import deepfilterWorkletUrl from "@lofcz/deepfilternet-web/worklet?url";
import deepfilterWasmUrl from "@lofcz/deepfilternet-web/df_bg.wasm?url";
import workletGlobalsUrl from "./worklet-globals.js?url";

/**
 * DeepFilterNet3 (neural, 48 kHz mono) as a fourth noise-suppression mode.
 *
 * Only the two ASSETS of the package are used (worklet + WASM, imported with
 * Vite `?url` so they stay separate same-origin files and are fetched lazily);
 * the worklet registers a plain `deepfilternet-processor` AudioWorkletNode
 * that we can drop into the mic chain exactly like the RNNoise node, instead
 * of the package's own end-to-end stream helper (which would create its own
 * AudioContext and bypass our gain/analyser/gate chain).
 *
 * The WASM is ~34 MB and holds the baked-in DF3 weights, so it is downloaded
 * once, on demand, only when this mode is actually selected.
 */

export const DEEPFILTER_SAMPLE_RATE = 48000;

const PROCESSOR_NAME = "deepfilternet-processor";

/**
 * Attenuation limit in dB (0..100). DeepFilterNet clamps how far the filter
 * may attenuate a band; 100 dB is the library default and removes the most
 * noise, at the cost of a slightly "underwater" voice on already-clean input.
 */
const DEFAULT_ATTENUATION_LIMIT = 100;

export class DeepFilterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepFilterUnavailableError";
  }
}

let cachedModule: WebAssembly.Module | null = null;
let wasmFailed = false;

function hasAudioWorklet(): boolean {
  return (
    typeof window !== "undefined" &&
    "AudioContext" in window &&
    window.AudioContext !== undefined &&
    "audioWorklet" in AudioContext.prototype
  );
}

/** Fetch + compile the DF3 WASM once (34 MB, so never on the critical path). */
async function loadWasmModule(): Promise<WebAssembly.Module> {
  if (cachedModule !== null) {
    return cachedModule;
  }
  if (wasmFailed) {
    throw new DeepFilterUnavailableError("DEEPFILTER_WASM");
  }
  try {
    const response = await fetch(deepfilterWasmUrl);
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    // compile() (not instantiateStreaming) so the module can be handed to the
    // worklet through processorOptions, which is what the worklet expects.
    cachedModule = await WebAssembly.compileStreaming
      ? await WebAssembly.compileStreaming(Promise.resolve(response))
      : await WebAssembly.compile(await response.arrayBuffer());
    return cachedModule;
  } catch {
    wasmFailed = true;
    throw new DeepFilterUnavailableError("DEEPFILTER_WASM");
  }
}

/**
 * Create a DeepFilterNet node for the mic chain. Requires a 48 kHz
 * AudioContext (DF3 runs at 48 kHz mono) and AudioWorklet support; otherwise
 * throws DeepFilterUnavailableError and the caller falls back to Enhanced.
 */
export async function createDeepFilterNode(
  context: AudioContext,
  attenuationLimitDb: number = DEFAULT_ATTENUATION_LIMIT,
): Promise<AudioWorkletNode> {
  if (!hasAudioWorklet()) {
    throw new DeepFilterUnavailableError("DEEPFILTER_UNAVAILABLE");
  }
  if (context.sampleRate !== DEEPFILTER_SAMPLE_RATE) {
    throw new DeepFilterUnavailableError("DEEPFILTER_RATE");
  }
  const wasmModule = await loadWasmModule();
  try {
    // The DeepFilterNet build is emscripten glue that calls `new TextDecoder()`
    // at module top level, and TextDecoder does NOT exist in
    // AudioWorkletGlobalScope — addModule() would throw ReferenceError and no
    // processor would be registered. Load our polyfill first: globals set by one
    // addModule() call are visible to the next one in the same context.
    await context.audioWorklet.addModule(workletGlobalsUrl);
    await context.audioWorklet.addModule(deepfilterWorkletUrl);
  } catch {
    throw new DeepFilterUnavailableError("DEEPFILTER_UNAVAILABLE");
  }
  // Constructing the node is the SECOND failure point: if the worklet module
  // threw at top level (or was never registered), addModule() may resolve but
  // `new AudioWorkletNode` throws NotSupportedError. That is a raw DOM error,
  // not a DeepFilterUnavailableError, so without this wrapper the caller's
  // Deep → Enhanced → Standard fallback would never fire and JOINING THE VOICE
  // CHANNEL would fail outright.
  try {
    return new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: {
        wasmModule,
        attenuationLimit: attenuationLimitDb,
      },
    });
  } catch {
    throw new DeepFilterUnavailableError("DEEPFILTER_UNAVAILABLE");
  }
}

/** Test hook: forget the cached WASM so fallback paths can be exercised. */
export function resetDeepFilterCache(): void {
  cachedModule = null;
  wasmFailed = false;
}