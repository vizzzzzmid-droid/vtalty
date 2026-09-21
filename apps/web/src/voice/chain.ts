import type { NoiseMode } from "./settings.js";

export interface MicChainOptions {
  deviceId: string | null;
  noiseMode: NoiseMode;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  /** Gain multiplier; Phase 5 inserts the RNNoise node before this gain. */
  inputVolume: number;
}

export interface MicChain {
  /** Processed track to publish (never the raw getUserMedia track). */
  track: MediaStreamTrack;
  /** Live level tap for the mic-test meter (time-domain analyser). */
  analyser: AnalyserNode;
  /** Set input gain without rebuilding the chain. */
  setVolume: (volume: number) => void;
  cleanup: () => void;
}

/**
 * Microphone processor chain: getUserMedia → [Phase 5: RNNoise] → gain →
 * analyser tap → MediaStreamDestination. Publishing the processed track
 * (instead of the raw mic track) is what makes suppression pluggable.
 */
export async function buildMicChain(options: MicChainOptions): Promise<MicChain> {
  const constraints: MediaTrackConstraints = {};
  if (options.deviceId !== null) {
    constraints.deviceId = { exact: options.deviceId };
  }
  if (options.noiseMode === "standard") {
    constraints.noiseSuppression = options.noiseSuppression;
    constraints.echoCancellation = options.echoCancellation;
    constraints.autoGainControl = options.autoGainControl;
  } else {
    // "off": raw mic; "enhanced" (Phase 5) disables the browser stage to
    // avoid double processing — the chain shape stays identical.
    constraints.noiseSuppression = false;
    constraints.echoCancellation = false;
    constraints.autoGainControl = false;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  gain.gain.value = options.inputVolume;
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  const destination = context.createMediaStreamDestination();
  // Phase 5 inserts: source -> rnnoiseNode -> gain -> analyser -> destination.
  source.connect(gain);
  gain.connect(analyser);
  analyser.connect(destination);

  const track = destination.stream.getAudioTracks()[0];
  if (track === undefined) {
    cleanup();
    throw new Error("Microphone chain produced no audio track");
  }
  let cleaned = false;
  function cleanup(): void {
    if (cleaned) {
      return;
    }
    cleaned = true;
    for (const raw of stream.getTracks()) {
      raw.stop();
    }
    void context.close().catch(() => undefined);
  }
  return {
    track,
    analyser,
    setVolume: (volume: number) => {
      gain.gain.value = volume;
    },
    cleanup,
  };
}

/** 0..1 level from an analyser (for the mic-test meter). */
export function analyserLevel(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let peak = 0;
  for (const sample of data) {
    const centered = Math.abs(sample - 128) / 128;
    if (centered > peak) {
      peak = centered;
    }
  }
  return Math.min(1, peak);
}
