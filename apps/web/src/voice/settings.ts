import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Explicit microphone publish options.
 *
 * LiveKit's `publishDefaults` already use AudioPresets.music (48 kbps) with
 * dtx/red enabled, but relying on an implicit default is fragile: bumping the
 * SDK can silently change voice quality. The voice profile is pinned here.
 *
 * Bitrate: the effective default is already AudioPresets.music (48 kbps) and
 * the track is published MONO, so the whole bitrate goes to the single voice
 * channel (see chain.ts). Discord voice runs 64-96 kbps; we ship 64 kbps,
 * which matches its floor and keeps the uplink sane on a small VPS with up to
 * 15 speakers (~1 Mbps aggregate at full talkership). Raising this further
 * (e.g. 96 kbps) is audibly negligible for speech and only costs CPU/bandwidth.
 *
 * DTX + RED: RED (RFC 2198 redundant audio) is what conceals packet loss on a
 * real network, DTX saves bandwidth during silence. Both stay on. They are
 * passed EXPLICITLY because livekit-client FORCE-DISABLES both for stereo
 * tracks when they are undefined (verified in livekit-client 2.22.3), and
 * because explicit values survive future changes to publishDefaults.
 */
export const MIC_PUBLISH_OPTIONS = {
  audioPreset: { maxBitrate: 64000 },
  // livekit-client FORCE-disables both for stereo tracks when they are
  // undefined (verified in livekit-client 2.22.3), so they must be explicit.
  dtx: true,
  red: true,
  /**
   * Publish STEREO, and this is the fix for "voice only in the left ear".
   *
   * The SFU always hands subscribers a MONO Opus track, and a mono track in
   * an <audio> element feeds channel 0 only — the voice lands in one ear. The
   * publisher-side ChannelMerger in chain.ts cannot fix that, because with
   * `forceStereo: false` livekit-client still negotiates Opus as MONO and
   * throws the upmix away. Centring had therefore been attempted on the
   * RECEIVING side (upmix.ts), which is unreliable: a fresh WebRTC track
   * usually reports no `channelCount` at attach time, so the centring was
   * skipped and stayed skipped for the whole call.
   *
   * With `forceStereo: true` the browser encodes real stereo Opus, the SFU
   * forwards it, and the subscriber plays BOTH ears natively — no WebAudio
   * graph, no keeper element, no gesture-timing dependency. Mono-capable
   * microphones are up-mixed by the encoder itself.
   */
  forceStereo: true,
} as const;

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
