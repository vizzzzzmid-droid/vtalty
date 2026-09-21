import type { VideoPreset } from "livekit-client";
import type { RemoteTrackPublication } from "livekit-client";
import type { ContentHintMode, ScreenPresetId } from "./store.js";
import { getRoom, setSuppressShareNotice } from "./room.js";
import { useVoiceConnection } from "./store.js";
import { useVoiceSettings } from "./settings.js";

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

export async function setStreamVolume(identity: string, volume: number): Promise<void> {
  const room = getRoom();
  if (room === null) {
    return;
  }
  const sdk = await livekit();
  for (const participant of room.remoteParticipants.values()) {
    if (participant.identity === identity) {
      participant.setVolume(volume, sdk.Track.Source.ScreenShareAudio);
    }
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

/** Attach the screen-share audio track to an element. */
export function attachStreamAudio(
  identity: string,
  element: HTMLAudioElement,
): () => void {
  const track = publicationsOf(identity)?.audio?.track;
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
