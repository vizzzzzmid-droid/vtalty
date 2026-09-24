import type { NoiseMode } from "./settings.js";
import { createGateNode, createRnnoiseNode } from "./rnnoise.js";

export interface MicChainOptions {
  deviceId: string | null;
  noiseMode: NoiseMode;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  /** Gain multiplier. */
  inputVolume: number;
  gateEnabled: boolean;
  gateThresholdDb: number;
  /** Loop the processed mic to the speakers (headphones required). */
  loopback: boolean;
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
 * Microphone processor chain:
 *   getUserMedia → [RNNoise?] → [gate?] → gain → analyser → [upmix?] → destination
 * Publishing the processed track (instead of the raw mic track) is what
 * makes suppression pluggable. Enhanced mode forces a 48 kHz context
 * (RNNoise requirement) and disables the browser noiseSuppression stage to
 * avoid double processing.
 *
 * When noise suppression is active (RNNoise processes mono), the final output
 * is up-mixed to stereo so it plays centred rather than in one ear. Standard
 * mode (browser processing) may already be stereo, so we only up-mix when the
 * source is mono.
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
    constraints.noiseSuppression = false;
    constraints.echoCancellation = false;
    constraints.autoGainControl = false;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  let context: AudioContext | null = null;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    for (const raw of stream.getTracks()) {
      raw.stop();
    }
    if (context !== null) {
      void context.close().catch(() => undefined);
    }
  };
  try {
    context =
      options.noiseMode === "enhanced"
        ? new AudioContext({ sampleRate: 48000 })
        : new AudioContext();
    const source = context.createMediaStreamSource(stream);
    let head: AudioNode = source;
    if (options.noiseMode === "enhanced") {
      const rnnoise = await createRnnoiseNode(context);
      head.connect(rnnoise);
      head = rnnoise;
    }
    if (options.gateEnabled) {
      const gate = await createGateNode(context, {
        openThresholdDb: options.gateThresholdDb,
      });
      head.connect(gate);
      head = gate;
    }
    const gain = context.createGain();
    gain.gain.value = options.inputVolume;
    head.connect(gain);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    gain.connect(analyser);

    // Up-mix mono → stereo when noise suppression is active (RNNoise outputs mono).
    // This prevents the "left ear only" symptom on some renderers (Electron/Chromium
    // included). Standard mode may already be stereo; we only up-mix when needed.
    let finalNode: AudioNode = analyser;
    if (options.noiseMode === "enhanced" || options.noiseSuppression) {
      try {
        // Detect mono from the TRACK, not from the GainNode: a GainNode's
        // channelCount defaults to 2 (channelCountMode "max"), so
        // `gain.channelCount === 1` was never true and this upmix never ran.
        const micChannels = stream.getAudioTracks()[0]?.getSettings().channelCount;
        if (options.noiseMode === "enhanced" || micChannels === 1) {
          const merger = context.createChannelMerger(2);
          // ChannelMergerNode maps input N to output channel N: a bare
          // `connect(merger)` feeds input 0 (LEFT) only — one-ear audio.
          // Feed the SAME mono source into BOTH inputs so it is centred.
          gain.connect(merger, 0, 0);
          gain.connect(merger, 0, 1);
          // Route both channels of the merger to the analyser (for the meter) and destination.
          merger.connect(analyser);
          finalNode = merger;
        }
      } catch {
        // channelCount may not be readable yet; fall back to direct connection.
      }
    }

    const destination = context.createMediaStreamDestination();
    finalNode.connect(destination);
    if (options.loopback) {
      finalNode.connect(context.destination);
    }

    const track = destination.stream.getAudioTracks()[0];
    if (track === undefined) {
      throw new Error("Microphone chain produced no audio track");
    }
    return {
      track,
      analyser,
      setVolume: (volume: number) => {
        gain.gain.value = volume;
      },
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
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
