/**
 * Mono → stereo centring for PLAYBACK.
 *
 * LiveKit delivers remote microphone audio as a single-channel Opus stream
 * (it is mono whenever the publisher's capture is mono, which is always the
 * case for our mic chain: browser mics and every neural suppressor we run —
 * RNNoise and DeepFilterNet — are mono). Playing a mono track straight into
 * an HTMLAudioElement has been observed to come out in ONE EAR only on
 * Chromium/Electron renderers. Since the SFU hands subscribers a mono track,
 * the receiver is the only place this can be fixed, so every playback sink
 * (remote mic elements AND stream-tile elements) routes through here.
 *
 * The publisher-side up-mix in chain.ts is not enough on its own: the SFU
 * down-mixes to mono for the wire, so subscribers still receive mono.
 */

let sharedContext: AudioContext | null = null;

/** Shared 48 kHz context for all playback up-mixes (48 kHz matches Opus). */
export function upmixContext(): AudioContext {
  if (sharedContext === null) {
    sharedContext = new AudioContext({ sampleRate: 48000 });
  }
  return sharedContext;
}

/**
 * Chromium/Electron start an AudioContext created outside a user gesture in
 * the "suspended" state, and its MediaStreamDestination then carries silence
 * even though the attached element reports as playing. Callers pair this with
 * a gesture-driven retry (see screen.ts).
 */
export function resumeUpmixContext(): void {
  if (sharedContext !== null && sharedContext.state === "suspended") {
    void sharedContext.resume();
  }
}

/** Test hook: drop the shared context so a fresh one is created. */
export function resetUpmixContext(): void {
  sharedContext = null;
}

/**
 * Build a stereo MediaStream from an audio track.
 *
 * Mono sources are fed into BOTH merger inputs (a ChannelMergerNode maps
 * input N to output channel N, so a bare `connect(merger)` lands the signal on
 * input 0 = LEFT only, which is the original one-ear bug). Genuine stereo
 * sources go through a ChannelSplitter so L and R stay separated — wiring
 * stereo straight into a merger input would down-mix it to mono.
 *
 * Returns null when WebAudio is unavailable, so callers can fall back to a
 * direct attach (one-ear but audible) rather than dropping the audio.
 */
export function upmixToStereo(track: MediaStreamTrack): MediaStream | null {
  try {
    const ctx = upmixContext();
    resumeUpmixContext();
    const stream = new MediaStream([track]);
    const source = ctx.createMediaStreamSource(stream);
    const merger = ctx.createChannelMerger(2);
    if (track.getSettings().channelCount === 2) {
      const splitter = ctx.createChannelSplitter(2);
      source.connect(splitter);
      splitter.connect(merger, 0, 0);
      splitter.connect(merger, 1, 1);
    } else {
      source.connect(merger, 0, 0);
      source.connect(merger, 0, 1);
    }
    const dest = ctx.createMediaStreamDestination();
    merger.connect(dest);
    return dest.stream;
  } catch {
    return null;
  }
}

/** Stop and drop an up-mixed stream created by {@link upmixToStereo}. */
export function disposeUpmixedStream(stream: MediaStream | null): void {
  if (stream === null) {
    return;
  }
  for (const audioTrack of stream.getAudioTracks()) {
    audioTrack.stop();
  }
}