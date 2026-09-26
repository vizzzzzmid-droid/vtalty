import type { VideoPreset } from "livekit-client";
import type { RemoteTrackPublication } from "livekit-client";
import type { ContentHintMode, ScreenPresetId } from "./store.js";
import { getRoom, setSuppressShareNotice } from "./room.js";
import { useVoiceConnection } from "./store.js";
import { useVoiceSettings } from "./settings.js";
import { applyElementVolume, releaseElementVolume, sharedPlaybackContext } from "./boost.js";
import { centerMonoTrack, type CenteredStream } from "./upmix.js";

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

/**
 * True when `identity` is the local participant. LiveKit never auto-subscribes
 * a publisher to their own tracks, so any explicit watch/attach against the
 * local identity is our own bug: the sharer would hear their own screen-share
 * audio played back to them (self-echo) and pay for the extra subscriptions.
 */
export function isSelfIdentity(identity: string): boolean {
  const room = getRoom();
  return room !== null && room.localParticipant.identity === identity;
}

/** Opt in: subscribe to a sharer's screen tracks (video + audio). */
export function watchStream(identity: string): void {
  if (isSelfIdentity(identity)) {
    return;
  }
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
  if (isSelfIdentity(identity)) {
    return;
  }
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
  if (isSelfIdentity(identity)) {
    return () => undefined;
  }
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
  // Self-echo guard: never register or attach the sharer's OWN screen audio on
  // the sharer's client (LiveKit would not deliver it anyway).
  if (isSelfIdentity(identity)) {
    return () => undefined;
  }
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
    // Centre mono through the SHARED playback context (upmix.ts). It returns
    // null on any failure — including a suspended context, which is what
    // silenced the whole room in an earlier attempt — and we then fall back
    // to a direct attach, which is never silent.
    const mediaStreamTrack = track.mediaStreamTrack;
    const graph =
      mediaStreamTrack === null || mediaStreamTrack === undefined
        ? null
        : centerMonoTrack(mediaStreamTrack);
    if (graph !== null) {
      streamGraphs.set(element, graph);
      element.srcObject = graph.stream;
    } else {
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
      const graph = streamGraphs.get(element);
      if (graph !== undefined) {
        // Restore the original stream BEFORE tearing the graph down, so the
        // element is never left pointing at a stopped graph output.
        streamGraphs.delete(element);
        element.srcObject = graph.input;
        graph.release();
        track.detach(element);
      } else {
        track.detach(element);
      }
      element.srcObject = null;
    } catch {
      // Element/audio context already gone.
    }
  };
}

/** Centring graphs owned by stream-tile elements (for teardown). */
const streamGraphs = new WeakMap<HTMLAudioElement, CenteredStream>();

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
  // The centring graph lives in the shared playback context (boost.ts), which
  // owns its own resume-on-gesture handling. Nudge it on every attach too.
  const ctx = sharedPlaybackContext();
  if (ctx !== null && ctx.state === "suspended") {
    void ctx.resume();
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
