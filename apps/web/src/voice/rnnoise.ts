import {
  NoiseGateWorkletNode,
  RnnoiseWorkletNode,
  loadRnnoise,
} from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import noiseGateWorkletUrl from "@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url";

let cachedWasm: ArrayBuffer | null = null;
let wasmFailed = false;

export class EnhancedUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnhancedUnavailableError";
  }
}

function hasAudioWorklet(): boolean {
  return (
    typeof window !== "undefined" &&
    "AudioContext" in window &&
    window.AudioContext !== undefined &&
    "audioWorklet" in AudioContext.prototype
  );
}

/** Lazily fetch the RNNoise WASM (only when Enhanced is selected). */
async function loadWasm(): Promise<ArrayBuffer> {
  if (cachedWasm !== null) {
    return cachedWasm;
  }
  if (wasmFailed) {
    throw new EnhancedUnavailableError("ENHANCED_WASM");
  }
  try {
    cachedWasm = await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdUrl });
    return cachedWasm;
  } catch {
    wasmFailed = true;
    throw new EnhancedUnavailableError("ENHANCED_WASM");
  }
}

/**
 * Create an RNNoise node. Requires a 48 kHz AudioContext (RNNoise runs at
 * 48 kHz mono) and AudioWorklet support; otherwise throws
 * EnhancedUnavailableError and the caller falls back to Standard.
 */
export async function createRnnoiseNode(
  context: AudioContext,
): Promise<RnnoiseWorkletNode> {
  if (!hasAudioWorklet()) {
    throw new EnhancedUnavailableError("ENHANCED_UNAVAILABLE");
  }
  if (context.sampleRate !== 48000) {
    throw new EnhancedUnavailableError("ENHANCED_RATE");
  }
  const wasmBinary = await loadWasm();
  try {
    await context.audioWorklet.addModule(rnnoiseWorkletUrl);
  } catch {
    throw new EnhancedUnavailableError("ENHANCED_UNAVAILABLE");
  }
  return new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary });
}

export interface GateOptions {
  /** Open threshold in dB (close = 6 dB lower, hold 200 ms). */
  openThresholdDb: number;
}

/** Standalone noise gate (works in every mode, no WASM needed). */
export async function createGateNode(
  context: AudioContext,
  options: GateOptions,
): Promise<NoiseGateWorkletNode> {
  if (!hasAudioWorklet()) {
    throw new EnhancedUnavailableError("ENHANCED_UNAVAILABLE");
  }
  try {
    await context.audioWorklet.addModule(noiseGateWorkletUrl);
  } catch {
    throw new EnhancedUnavailableError("ENHANCED_UNAVAILABLE");
  }
  return new NoiseGateWorkletNode(context, {
    openThreshold: options.openThresholdDb,
    closeThreshold: options.openThresholdDb - 6,
    holdMs: 200,
    maxChannels: 1,
  });
}

/** Test hook: forget cached WASM so fallback paths can be exercised. */
export function resetRnnoiseCache(): void {
  cachedWasm = null;
  wasmFailed = false;
}
