import { create } from "zustand";
import { ConnectionQuality } from "livekit-client";

export type VoiceStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

interface VoiceConnection {
  status: VoiceStatus;
  channelId: string | null;
  error: string | null;
  /** Mic toggle (works disconnected too; applied on join). */
  selfMuted: boolean;
  /** Deafen toggle (implies mute; undeafen restores pre-deafen mute). */
  selfDeafened: boolean;
  preDeafenMuted: boolean;
  pttActive: boolean;
  speakingIds: string[];
  connectionQuality: ConnectionQuality;
  /** Browser blocked autoplay: show a "click to enable audio" fallback. */
  needsAudioGesture: boolean;
  set: (patch: Partial<VoiceConnection>) => void;
  reset: () => void;
}

export const useVoiceConnection = create<VoiceConnection>()((set) => ({
  status: "idle",
  channelId: null,
  error: null,
  selfMuted: false,
  selfDeafened: false,
  preDeafenMuted: false,
  pttActive: false,
  speakingIds: [],
  connectionQuality: ConnectionQuality.Unknown,
  needsAudioGesture: false,
  set: (patch) => set(patch),
  reset: () =>
    set({
      status: "idle",
      channelId: null,
      error: null,
      pttActive: false,
      speakingIds: [],
      needsAudioGesture: false,
    }),
}));

export function qualityDots(quality: ConnectionQuality): number {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return 3;
    case ConnectionQuality.Good:
      return 2;
    case ConnectionQuality.Poor:
      return 1;
    default:
      return 0;
  }
}
