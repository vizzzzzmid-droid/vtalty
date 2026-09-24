import type { VideoPreset } from "livekit-client";
import type { RemoteTrackPublication } from "livekit-client";
import type { ContentHintMode, ScreenPresetId } from "./store.js";
import { getRoom, setSuppressShareNotice } from "./room.js";
import { useVoiceConnection } from "./store.js";
import { useVoiceSettings } from "./settings.js";
import { applyElementVolume, releaseElementVolume } from "./boost.js";

type LiveKitModule = typeof import("livekit-client");

let livekitModule: LiveKitModule | null = null;

async function livekit(): Promise<LiveKitModule> {
  if (livekitModule === null) {
    livekitModule = await import("livekit-client");
  }
  return livekitModule;
}

export const SHARE_PRESET_LABELS: Record<ScreenPresetId, string> = {
  "720p30": "720p30 — light on bandwidth",
  "1080p30": "1080p30 — balanced default",
  "1080p60": "1080p60 — smooth motion, heavy",
  source: "Source — native resolution",
};

async function presetFor(id: ScreenPresetId): Promise<VideoPreset> {
  const sdk = await livekit();
  switch (id) {
    case "720p30":
      return sdk.ScreenSharePresets.h720fps30;
    case "1080p30":
      return sdk.ScreenSharePresets.h1080fps30;
    case "1080p60":
      return new sdk.VideoPreset(1920, 1080, 3_000_000, 60);
    case "source":
      return sdk.ScreenSharePresets.original;
  }
}

export interface StartShareOptions {
  preset: ScreenPresetId;
  contentHint: ContentHintMode;
  withAudio: boolean;
}

export function describeShareError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
        return "Screen sharing was cancelled in the browser picker.";
      case "NotFoundError":
      case "AbortError":
        return "No screen source was selected.";
      case "NotReadableError":
        return "The screen source could not be captured (in use?).";
      default:
        break;
    }
  }
  if (err instanceof Error && /permission|grant/i.test(err.message)) {
    return "Your role cannot share the screen here.";
  }
  return "Could not start sharing. Check browser support and retry.";
}

/** Start publishing the screen (requires a connected room + share grant). */
export async function startShare(
  channelId: string,
  options: StartShareOptions,
): Promise<void> {
  const room = getRoom();
  if (room === null) {
    throw new Error("Join voice first");
  }
  const state = useVoiceConnection.getState();
  if (state.sharing !== null) {
    await stopShare();
  }
  const preset = await presetFor(options.preset);
  const publication = await room.localParticipant.setScreenShareEnabled(
    true,
    {
      audio: options.withAudio,
      resolution: { ...preset.resolution },
      contentHint: options.contentHint,
      systemAudio: "include",
    },
    {
      screenShareEncoding: { ...preset.encoding },
      simulcast: true,
      degradationPreference: "maintain-resolution",
    },
  );
  // The browser's native "Stop sharing" button ends the track directly.
  const mediaTrack = publication?.track?.mediaStreamTrack;
  if (mediaTrack !== undefined && mediaTrack !== null) {
    mediaTrack.onended = () => {
      void handleNativeShareStop();
    };
  }
  state.set({
    sharing: {
      channelId,
      preset: options.preset,
      contentHint: options.contentHint,
      withAudio: options.withAudio,
    },
    shareNotice: null,
  });
}

async function handleNativeShareStop(): Promise<void> {
  setSuppressShareNotice(true);
  try {
    await getRoom()?.localParticipant.setScreenShareEnabled(false);
  } catch {
    // Already stopped; state below still converges via track events.
  } finally {
    setSuppressShareNotice(false);
    useVoiceConnection.getState().set({ sharing: null });
  }
}

export async function stopShare(): Promise<void> {
  setSuppressShareNotice(true);
  try {
    await getRoom()?.localParticipant.setScreenShareEnabled(false);
  } catch {
    // Already stopped; state below still converges.
  } finally {
    setSuppressShareNotice(false);
    useVoiceConnection.getState().set({ sharing: null });
  }
}

export interface ScreenPublications {
  video?: RemoteTrackPublication;
  audio?: RemoteTrackPublication;
}

function publicationsOf(identity: string): ScreenPublications | null {
  const room = getRoom();
  if (room === null) {
    return null;
  }
  for (const participant of room.remoteParticipants.values()) {
    if (participant.identity !== identity) {
      continue;
    }
    let video: RemoteTrackPublication | undefined;
    let audio: RemoteTrackPublication | undefined;
    // String literals avoid a static livekit-client import (code-split);
    // values match Track.Source (verified against installed types).
    for (const publication of participant.videoTrackPublications.values()) {
      if ((publication as { source?: unknown }).source === "screen_share") {
        video = publication as RemoteTrackPublication;
      }
    }
    for (const publication of participant.audioTrackPublications.values()) {
      if ((publication as { source?: unknown }).source === "screen_share_audio") {
        audio = publication as RemoteTrackPublication;
      }
    }
    return { video, audio };
  }
  return null;
}

/** Opt in: subscribe to a sharer's screen tracks (video + audio). */
export function watchStream(identity: string): void {
  const publications = publicationsOf(identity);
  const deafened = useVoiceConnection.getState().selfDeafened;
  const volumes = useVoiceSettings.getState().streamVolumes;
  publications?.video?.setSubscribed(true);
  if (publications?.audio !== undefined && !deafened) {
    publications.audio.setSubscribed(true);
    const volume = volumes[identity];
    if (volume !== undefined) {
      setStreamVolume(identity, volume);
    }
  }
}

/** Opt out: unsubscribe (bandwidth stops immediately). */
export function unwatchStream(identity: string): void {
  const publications = publicationsOf(identity);
  publications?.video?.setSubscribed(false);
  publications?.audio?.setSubscribed(false);
}

export async function setStreamQuality(
  identity: string,
  quality: "auto" | "low" | "medium" | "high",
): Promise<void> {
  const video = publicationsOf(identity)?.video;
  if (video === undefined) {
    return;
  }
  const sdk = await livekit();
  if (quality === "auto") {
    // Adaptive stream resumes control; HIGH is the ceiling for manual caps.
    video.setVideoQuality(sdk.VideoQuality.HIGH);
    return;
  }
  const map = {
    low: sdk.VideoQuality.LOW,
    medium: sdk.VideoQuality.MEDIUM,
    high: sdk.VideoQuality.HIGH,
  } as const;
  video.setVideoQuality(map[quality]);
}

/** Set a stream's listen volume (0..MAX_VOLUME; >100% boosts via WebAudio gain). */
export function setStreamVolume(identity: string, volume: number): void {
  const elements = streamAudioElements.get(identity);
  if (elements === undefined) {
    return;
  }
  for (const element of elements) {
    applyElementVolume(element, volume);
  }
}

/** Attach the screen video track to an element; returns detach cleanup. */
export function attachStreamVideo(
  identity: string,
  element: HTMLVideoElement,
): () => void {
  const track = publicationsOf(identity)?.video?.track;
  if (track === undefined || track === null) {
    return () => undefined;
  }
  if (element.srcObject === null) {
    track.attach(element);
  }
  return () => {
    try {
      track.detach(element);
    } catch {
      // Element already gone.
    }
  };
}

/** Attach a stereo-upped livekit audio track to an HTMLAudioElement.
 *
 * LiveKit screen-share audio tracks can be mono; playing a mono track
 * directly into an HTMLAudioElement has been observed to produce sound only in
 * one ear on some renderers (Electron/Chromium included). To make it centred,
 * we explicitly up-mix mono → stereo through a shared ChannelMergerNode before
 * attaching to the element. If the track is already stereo, we attach it
 * directly. The returned cleanup detaches the (possibly re-attached) source.
 */
export function attachStreamAudio(
  identity: string,
  element: HTMLAudioElement,
): () => void {
  installAudioUnlockListeners();
  trackStreamAudioElement(identity, element);
  resumeStreamAudioContext();
  const pub = publicationsOf(identity)?.audio;
  const track = pub?.track;
  if (track === undefined || track === null) {
    return () => {
      untrackStreamAudioElement(identity, element);
    };
  }
  if (element.srcObject === null) {
    // Always upmix to stereo to ensure centered audio playback.
    // This handles both mono tracks (duplicated into L+R) and stereo tracks
    // (L/R kept separated via a ChannelSplitter).
    const mediaStreamTrack = track.mediaStreamTrack;
    if (mediaStreamTrack !== null && mediaStreamTrack !== undefined) {
      const upmixed = upmixToStereo(mediaStreamTrack);
      if (upmixed !== null) {
        element.srcObject = upmixed;
      } else {
        track.attach(element);
      }
    } else {
      // Fallback: attach directly if we can't access the underlying track.
      // In this case, we use the track's attach method which handles cleanup.
      track.attach(element);
    }
    tryPlay(element);
  } else if (element.paused) {
    // An earlier play() may have been rejected by autoplay policy; retry on
    // every attach tick (a real unlock happens on the next user gesture via
    // installAudioUnlockListeners).
    tryPlay(element);
  }
  applyElementVolume(
    element,
    useVoiceSettings.getState().streamVolumes[identity] ?? 1,
  );
  return () => {
    untrackStreamAudioElement(identity, element);
    try {
      // For upmixed tracks, we have a MediaStream that we need to clean up.
      const currentSrc = element.srcObject;
      if (currentSrc instanceof MediaStream) {
        // The up-mixed stereo track we created: stop the audio tracks and clear.
        for (const upmixed of currentSrc.getAudioTracks()) {
          upmixed.stop();
        }
        element.srcObject = null;
      } else if (currentSrc === null) {
        // Already cleared.
      } else {
        // Direct attach case: use the track's detach method.
        // We can't compare directly with track due to type differences,
        // so we check if the element still has a srcObject that isn't a MediaStream.
        track.detach(element);
      }
    } catch {
      // Element/audio context already gone.
    }
  };
}

/** Up-mix a MediaStreamTrack to stereo via AudioContext.
 *
 * If the track is already stereo, the merger passes it through unchanged.
 * If mono, both output channels receive the same signal (centered playback).
 */
function upmixToStereo(track: MediaStreamTrack): MediaStream | null {
  try {
    // Use a shared AudioContext for the upmix operation.
    let ctx = sharedContext;
    if (ctx === null) {
      ctx = new AudioContext({ sampleRate: 48000 });
      sharedContext = ctx;
    }
    resumeStreamAudioContext();
    // Wrap the track in a MediaStream for createMediaStreamSource.
    const stream = new MediaStream([track]);
    const source = ctx.createMediaStreamSource(stream);
    const merger = ctx.createChannelMerger(2);
    // ChannelMergerNode maps input N to output channel N: a bare
    // `source.connect(merger)` feeds input 0 (LEFT) only, so the audio plays
    // in one ear. Mono sources must be fed into BOTH inputs to be centred.
    if (track.getSettings().channelCount === 2) {
      // Genuine stereo source: keep L/R separation via a splitter (connecting
      // stereo straight into a merger input would down-mix it to mono).
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

let sharedContext: AudioContext | null = null;

/**
 * Chromium/Electron start an AudioContext created outside a user gesture in
 * the "suspended" state — its MediaStreamDestination then carries silence
 * even though the attached <audio> element reports as playing. The voice
 * path surfaces this via the "click to enable audio" banner, but stream
 * tiles are excluded from it (they own their elements), so they self-unlock:
 * resume the shared upmix context and re-play paused stream elements on the
 * first pointer/key gesture anywhere in the document.
 */
const liveAudioElements = new Set<HTMLAudioElement>();
/** Stream-tile audio elements keyed by sharer identity (for volume control). */
const streamAudioElements = new Map<string, Set<HTMLAudioElement>>();

function trackStreamAudioElement(identity: string, element: HTMLAudioElement): void {
  liveAudioElements.add(element);
  let set = streamAudioElements.get(identity);
  if (set === undefined) {
    set = new Set();
    streamAudioElements.set(identity, set);
  }
  set.add(element);
}

function untrackStreamAudioElement(identity: string, element: HTMLAudioElement): void {
  liveAudioElements.delete(element);
  releaseElementVolume(element);
  const set = streamAudioElements.get(identity);
  set?.delete(element);
  if (set !== undefined && set.size === 0) {
    streamAudioElements.delete(identity);
  }
}

let unlockListenersInstalled = false;

function resumeStreamAudioContext(): void {
  if (sharedContext !== null && sharedContext.state === "suspended") {
    void sharedContext.resume();
  }
}

function tryPlay(element: HTMLAudioElement): void {
  try {
    element.play().catch(() => undefined);
  } catch {
    // Autoplay blocked; the gesture listener retries on the next interaction.
  }
}

function installAudioUnlockListeners(): void {
  if (unlockListenersInstalled || typeof document === "undefined") {
    return;
  }
  unlockListenersInstalled = true;
  const unlock = (): void => {
    resumeStreamAudioContext();
    for (const element of liveAudioElements) {
      if (element.paused) {
        tryPlay(element);
      }
    }
  };
  document.addEventListener("pointerdown", unlock);
  document.addEventListener("keydown", unlock);
}

/** Live connection quality of a sharer (for the "degraded" hint). */
export function sharerQuality(identity: string): string | null {
  const room = getRoom();
  if (room === null) {
    return null;
  }
  for (const participant of room.remoteParticipants.values()) {
    if (participant.identity === identity) {
      return participant.connectionQuality;
    }
  }
  return null;
}

/** True for poor/lost qualities (string-compared to stay code-split). */
export function isDegradedQuality(quality: string | null): boolean {
  return quality === "poor" || quality === "lost";
}
