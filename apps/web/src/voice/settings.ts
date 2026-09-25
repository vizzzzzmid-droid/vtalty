import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type NoiseMode = "off" | "standard" | "enhanced" | "deep";

interface VoiceSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  /** Microphone gain multiplier applied in the processor chain. */
  inputVolume: number;
  noiseMode: NoiseMode;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  /** Noise-gate enable + open threshold in dB (RNNoise-independent). */
  gateEnabled: boolean;
  gateThresholdDb: number;
  /** Loopback mic to speakers (headphones required) for mode comparison. */
  hearMyself: boolean;
  pttEnabled: boolean;
  /** KeyboardEvent.code for push-to-talk (web: works while tab is focused). */
  pttKey: string;
  /** Per-user listen volume 0..MAX_VOLUME (boost >100%), keyed by user id. */
  userVolumes: Record<string, number>;
  /** Per-stream (screen audio) volume 0..MAX_VOLUME (boost >100%), keyed by sharer user id. */
  streamVolumes: Record<string, number>;
  set: (patch: Partial<VoiceSettings>) => void;
  setUserVolume: (userId: string, volume: number) => void;
  setStreamVolume: (userId: string, volume: number) => void;
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
      gateEnabled: false,
      gateThresholdDb: -40,
      hearMyself: false,
      userVolumes: {},
      streamVolumes: {},
      set: (patch) => set(patch),
      setUserVolume: (userId, volume) =>
        set((state) => ({
          userVolumes: { ...state.userVolumes, [userId]: volume },
        })),
      setStreamVolume: (userId, volume) =>
        set((state) => ({
          streamVolumes: { ...state.streamVolumes, [userId]: volume },
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
        gateEnabled: state.gateEnabled,
        gateThresholdDb: state.gateThresholdDb,
        hearMyself: state.hearMyself,
        pttEnabled: state.pttEnabled,
        pttKey: state.pttKey,
        userVolumes: state.userVolumes,
        streamVolumes: state.streamVolumes,
      }),
    },
  ),
);
