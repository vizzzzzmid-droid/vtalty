import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type NoiseMode = "off" | "standard";

interface VoiceSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  /** Microphone gain multiplier applied in the processor chain. */
  inputVolume: number;
  noiseMode: NoiseMode;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  pttEnabled: boolean;
  /** KeyboardEvent.code for push-to-talk (web: works while tab is focused). */
  pttKey: string;
  /** Per-user listen volume 0..1, keyed by user id. */
  userVolumes: Record<string, number>;
  set: (patch: Partial<VoiceSettings>) => void;
  setUserVolume: (userId: string, volume: number) => void;
}

export const useVoiceSettings = create<VoiceSettings>()(
  persist(
    (set) => ({
      inputDeviceId: null,
      outputDeviceId: null,
      inputVolume: 1,
      noiseMode: "standard",
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
      pttEnabled: false,
      pttKey: "Backquote",
      userVolumes: {},
      set: (patch) => set(patch),
      setUserVolume: (userId, volume) =>
        set((state) => ({
          userVolumes: { ...state.userVolumes, [userId]: volume },
        })),
    }),
    {
      name: "vitality-voice-settings",
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        inputDeviceId: state.inputDeviceId,
        outputDeviceId: state.outputDeviceId,
        inputVolume: state.inputVolume,
        noiseMode: state.noiseMode,
        noiseSuppression: state.noiseSuppression,
        echoCancellation: state.echoCancellation,
        autoGainControl: state.autoGainControl,
        pttEnabled: state.pttEnabled,
        pttKey: state.pttKey,
        userVolumes: state.userVolumes,
      }),
    },
  ),
);
