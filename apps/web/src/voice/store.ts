import { create } from "zustand";
import { ConnectionQuality } from "livekit-client";

export type VoiceStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export type ScreenPresetId = "720p30" | "1080p30" | "1080p60" | "source";
export type ContentHintMode = "detail" | "motion";
export type StreamQuality = "auto" | "low" | "medium" | "high";

export interface ActiveShare {
  channelId: string;
  preset: ScreenPresetId;
  contentHint: ContentHintMode;
  withAudio: boolean;
}

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
  /** Non-fatal audio notice (e.g. Enhanced fallback); dismissed on change. */
  audioNotice: string | null;
  /** Local outgoing screen share (Phase 5). */
  sharing: ActiveShare | null;
  /** Notice when the local share was stopped remotely (limit/moderator). */
  shareNotice: string | null;
  /** Opted-in stream watching by sharer user id. */
  watching: Record<string, { quality: StreamQuality }>;
  set: (patch: Partial<VoiceConnection>) => void;
  reset: () => void;
  startWatching: (sharerId: string) => void;
  stopWatching: (sharerId: string) => void;
  setWatchQuality: (sharerId: string, quality: StreamQuality) => void;
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
  audioNotice: null,
  sharing: null,
  shareNotice: null,
  watching: {},
  set: (patch) => set(patch),
  startWatching: (sharerId) =>
    set((state) => ({
      watching: { ...state.watching, [sharerId]: { quality: "auto" } },
    })),
  stopWatching: (sharerId) =>
    set((state) => ({
      watching: Object.fromEntries(
        Object.entries(state.watching).filter(([id]) => id !== sharerId),
      ),
    })),
  setWatchQuality: (sharerId, quality) =>
    set((state) =>
      state.watching[sharerId] === undefined
        ? state
        : { watching: { ...state.watching, [sharerId]: { quality } } },
    ),
  reset: () =>
    set({
      status: "idle",
      channelId: null,
      error: null,
      pttActive: false,
      speakingIds: [],
      needsAudioGesture: false,
      sharing: null,
      shareNotice: null,
      watching: {},
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
