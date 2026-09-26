import { keepStreamAlive, sharedPlaybackContext } from "./boost.js";

/**
 * Mono→stereo centring for remote microphone audio.
 *
 * THE PROBLEM: LiveKit's SFU always hands subscribers a MONO Opus track. When
 * a mono track reaches an <audio> element, the browser feeds channel 0 (left)
 * only, so the speaker's voice is audible in one ear. The fix is publisher-side
 * (an upmixed stereo source), but a stereo track cannot be relied on either:
 * `forceStereo: false` means LiveKit negotiates Opus as mono, so the receiving
 * side must centre the audio it actually got.
 *
 * WHY THIS IS SAFE (the first attempt at this silenced ALL voice audio):
 *  1. It REUSES the shared playback AudioContext from boost.ts, which is
 *     already running in production (the volume boost drives it) and is
 *     resumed on the first user gesture. A context created here would start
 *     "suspended" outside a gesture, and a suspended MediaStreamDestination
 *     outputs SILENCE while the element still reports as playing.
 *  2. Every failure path returns null, and the caller then attaches the track
 *     DIRECTLY — the pre-fix behaviour, which is audible in both ears or one,
 *     but never silent.
 *  3. The graph is only built for a track that is really mono, and the
 *     original stream is kept alive by a muted keeper element, because
 *     Chromium stops delivering a WebRTC stream nothing consumes (which is
 *     also what made the first attempt mute the room).
 *  4. The context must be observably "running" before we reroute anything.
 */

export interface CenteredStream {
  /** Stereo stream to hand to the media element. */
  stream: MediaStream;
  /** Original (mono) stream, needed to restore the element on teardown. */
  input: MediaStream;
  /** Tear down the graph and release the keeper. */
  release: () => void;
}

/**
 * True when the track should be treated as mono and therefore centred.
 *
 * An UNREPORTED channelCount counts as mono on purpose. LiveKit's SFU always
 * hands subscribers a mono Opus track unless stereo was explicitly negotiated,
 * and a freshly attached remote track reports its channelCount only once
 * playback has started — waiting for it left the voice in one ear for the
 * whole call. The failure modes are not symmetric: wrongly centring a truly
 * stereo source just folds it to a centred mono (still perfectly audible),
 * whereas never centring the common mono case is the bug being fixed.
 * A track that positively reports 2+ channels is left completely alone.
 */
export function isMonoTrack(track: MediaStreamTrack | null | undefined): boolean {
  if (track === null || track === undefined) {
    return false;
  }
  try {
    const count = track.getSettings().channelCount;
    return count === undefined || count === 1;
  } catch {
    // Settings unreadable: treat as mono, the SFU default.
    return true;
  }
}

/** True when the track positively reports more than one channel. */
export function isStereoTrack(track: MediaStreamTrack | null | undefined): boolean {
  if (track === null || track === undefined) {
    return false;
  }
  try {
    const count = track.getSettings().channelCount;
    return count !== undefined && count > 1;
  } catch {
    return false;
  }
}

/**
 * Build a centred (mono duplicated to L+R) stream for a mono track, or null
 * when that cannot be done safely — the caller must then attach the track
 * directly.
 */
export function centerMonoTrack(track: MediaStreamTrack): CenteredStream | null {
  if (!isMonoTrack(track)) {
    return null;
  }
  const ctx = sharedPlaybackContext();
  // A suspended context yields a silent destination, so refuse to build the
  // graph at all until it is genuinely running.
  if (ctx === null || ctx.state !== "running") {
    return null;
  }
  let source: MediaStreamAudioSourceNode | null = null;
  let merger: ChannelMergerNode | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  try {
    const input = new MediaStream([track]);
    source = ctx.createMediaStreamSource(input);
    merger = ctx.createChannelMerger(2);
    // ChannelMergerNode maps input N to output channel N, so a bare
    // `connect(merger)` feeds input 0 (LEFT) only — exactly the one-ear
    // symptom. Feed the same mono source into BOTH inputs to centre it.
    source.connect(merger, 0, 0);
    source.connect(merger, 0, 1);
    dest = ctx.createMediaStreamDestination();
    merger.connect(dest);
    const stream = dest.stream;
    // Keep the original WebRTC stream consumed while the element plays the
    // graph output (Chromium drops streams nothing consumes).
    const releaseKeeper = keepStreamAlive(input);
    return {
      stream,
      input,
      release: () => {
        releaseKeeper();
        try {
          source?.disconnect();
          merger?.disconnect();
        } catch {
          // Context already gone.
        }
        for (const out of stream.getAudioTracks()) {
          out.stop();
        }
      },
    };
  } catch {
    for (const out of dest?.stream.getAudioTracks() ?? []) {
      out.stop();
    }
    try {
      source?.disconnect();
      merger?.disconnect();
    } catch {
      // Nothing to clean up.
    }
    return null;
  }
}