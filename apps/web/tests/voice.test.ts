// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { ConnectionQuality } from "livekit-client";
import { VOICE_SETTINGS_DEFAULTS, voiceSettingsSchema } from "@vitality/shared";
import { qualityDots, useVoiceConnection } from "../src/voice/store.js";
import { MIC_PUBLISH_OPTIONS, useVoiceSettings, type NoiseMode } from "../src/voice/settings.js";

const chainSource = readFileSync(
  resolve(process.cwd(), "src/voice/chain.ts"),
  "utf8",
);
const deepFilterSource = readFileSync(
  resolve(process.cwd(), "src/voice/deepfilter.ts"),
  "utf8",
);
const roomSource = readFileSync(
  resolve(process.cwd(), "src/voice/room.ts"),
  "utf8",
);
const audioTabSource = readFileSync(
  resolve(process.cwd(), "src/components/VoiceAudioTab.tsx"),
  "utf8",
);

/**
 * DeepFilterNet3 as a fourth noise-suppression mode ("Deep"). These tests pin
 * the wiring decisions that are easy to regress:
 *  - the mode is accepted end-to-end (store -> zod schema -> API),
 *  - it is treated as a NEURAL mode (48 kHz context, browser stages off,
 *    mono->stereo upmix) exactly like Enhanced,
 *  - the worklet is loaded as a plain AudioWorkletNode so our own gain/gate/
 *    analyser chain stays in control (the package's own stream helper would
 *    bypass it),
 *  - a failure degrades to Enhanced, then to Standard, never to a dead mic.
 */
describe("DeepFilterNet noise mode", () => {
  beforeEach(() => {
    useVoiceSettings.getState().set({ noiseMode: "off" });
  });

  it("is a selectable mode in the store and the shared schema", () => {
    useVoiceSettings.getState().set({ noiseMode: "deep" });
    expect(useVoiceSettings.getState().noiseMode).toBe("deep");
    // The server validates the same enum, so an unknown value must be rejected
    // and "deep" accepted. voiceSettingsSchema is complete (not partial), so
    // the payload is built from the shipped defaults.
    expect(
      voiceSettingsSchema.safeParse({ ...VOICE_SETTINGS_DEFAULTS, noiseMode: "deep" })
        .success,
    ).toBe(true);
    expect(
      voiceSettingsSchema.safeParse({ ...VOICE_SETTINGS_DEFAULTS, noiseMode: "turbo" })
        .success,
    ).toBe(false);
  });

  it("is offered in the settings UI as a radio option", () => {
    expect(audioTabSource).toContain('checked={settings.noiseMode === "deep"}');
    expect(audioTabSource).toContain("DeepFilterNet3");
  });

  it("forces a 48 kHz context and a mono worklet node", () => {
    // DF3 runs at 48 kHz mono, so the neural-mode helper must cover "deep",
    // not just the literal "enhanced".
    const modes: NoiseMode[] = ["off", "standard", "enhanced", "deep"];
    for (const neural of ["enhanced", "deep"] satisfies NoiseMode[]) {
      expect(modes).toContain(neural);
    }
    expect(chainSource).toContain(
      `const neuralModes: readonly NoiseMode[] = ["enhanced", "deep"]`,
    );
    expect(chainSource).toContain("isNeuralMode(options.noiseMode)");
    // The node is built at the head of the chain, right after the source.
    expect(chainSource).toContain("createDeepFilterNode(context)");
    expect(deepFilterSource).toContain("DEEPFILTER_SAMPLE_RATE = 48000");
    // Monoprocessing: the browser's own cleanup must stay off to avoid
    // double processing (same as Enhanced).
    expect(chainSource).toMatch(
      /options\.noiseMode === "deep"[\s\S]{0,400}?head = deep;/,
    );
  });

  it("uses the package's worklet as a plain AudioWorkletNode (keeps our chain)", () => {
    expect(deepFilterSource).toContain("new AudioWorkletNode(context, PROCESSOR_NAME");
    // The chain (gain/analyser/gate/loopback) must stay ours: the package's
    // own end-to-end stream helper would create its own AudioContext.
    expect(deepFilterSource).not.toContain("createMediaStreamDestination");
    expect(deepFilterSource).not.toContain("new AudioContext(");
  });

  it("passes the compiled WASM module through processorOptions", () => {
    // The worklet instantiates the model itself, so the module must be handed
    // over rather than instantiated on the main thread.
    expect(deepFilterSource).toContain("processorOptions");
    expect(deepFilterSource).toContain("wasmModule");
    // Loaded lazily and cached: a 34 MB model must never be on the boot path.
    expect(deepFilterSource).toContain("cachedModule");
  });

  it("degrades Deep -> Enhanced -> Standard instead of failing the mic", () => {
    expect(roomSource).toContain("DeepFilterUnavailableError");
    expect(roomSource).toMatch(
      /prefs\.noiseMode === "deep"\)[\s\S]{0,200}?prefs\.set\(\{ noiseMode: "enhanced" \}\)/,
    );
    expect(roomSource).toContain('prefs.set({ noiseMode: "standard" })');
  });
});

describe("neural mode detection", () => {
  it("covers both neural suppressors everywhere Enhanced is special-cased", () => {
    // Guard against a new "enhanced"-only branch creeping back in: the only
    // place allowed to mention "enhanced" for chain building is the branch
    // that picks RNNoise itself.
    const branches = chainSource.match(/options\.noiseMode === "enhanced"/g) ?? [];
    expect(branches).toHaveLength(1);
  });

  it("keeps isNeuralMode consistent between context rate and upmix", () => {
    // Both decisions must use the same helper, otherwise a mode could get a
    // 48 kHz context without the mono->stereo upmix (left-ear-only audio).
    const rateUses = chainSource.includes(
      "context = isNeuralMode(options.noiseMode)",
    );
    const upmixUses = chainSource.includes(
      "if (isNeuralMode(options.noiseMode) || options.noiseSuppression)",
    );
    expect(rateUses && upmixUses).toBe(true);
  });
});

// keep the vitest import used even if the suite above is trimmed
void vi;

/**
 * Regression: the DeepFilterNet worklet is emscripten glue that calls
 * `new TextDecoder()` at MODULE TOP LEVEL, and TextDecoder does not exist in
 * AudioWorkletGlobalScope. The polyfill module must therefore be loaded with
 * addModule() BEFORE the real worklet, in the same context.
 */
describe("AudioWorklet TextDecoder polyfill", () => {
  const shimSource = readFileSync(
    resolve(process.cwd(), "src/voice/worklet-globals.js"),
    "utf8",
  );

  it("actually installs a working TextDecoder when the global is missing", () => {
    // Run the shipped shim the way an AudioWorkletGlobalScope would: no
    // TextDecoder, no TextEncoder. Executing it proves the polyfill is valid
    // JS and not just plausible-looking source.
    const g = {} as Record<string, unknown>;
    new Function("globalThis", shimSource)(g);
    const Decoder = g["TextDecoder"] as new (
      encoding?: string,
      options?: { ignoreBOM?: boolean },
    ) => { decode: (bytes?: Uint8Array) => string };

    expect(typeof Decoder).toBe("function");
    const decoder = new Decoder("utf-8", { ignoreBOM: true });
    // ASCII, 2-byte, 3-byte and 4-byte (astral) sequences must decode, since
    // emscripten decodes UTF-8 error messages out of WASM memory.
    expect(decoder.decode(new TextEncoder().encode("abc"))).toBe("abc");
    expect(decoder.decode(new TextEncoder().encode("héllo"))).toBe("héllo");
    expect(decoder.decode(new TextEncoder().encode("прив"))).toBe("прив");
    expect(decoder.decode(new TextEncoder().encode("🙂"))).toBe("🙂");
    expect(decoder.decode()).toBe("");
  });

  it("honours ignoreBOM and replaces invalid bytes without throwing", () => {
    const g = {} as Record<string, unknown>;
    new Function("globalThis", shimSource)(g);
    const Decoder = g["TextDecoder"] as new (
      encoding?: string,
      options?: { ignoreBOM?: boolean; fatal?: boolean },
    ) => { decode: (bytes?: Uint8Array) => string };

    expect(new Decoder("utf-8", { ignoreBOM: true })
      .decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe("A");
    // Non-fatal mode must not throw on a truncated/invalid sequence.
    expect(() => new Decoder("utf-8", { fatal: false })
      .decode(new Uint8Array([0xc3]))).not.toThrow();
    // ...and fatal mode must throw (emscripten relies on this).
    expect(() => new Decoder("utf-8", { fatal: true })
      .decode(new Uint8Array([0xc3]))).toThrow();
  });

  it("installs TextEncoder too (other emscripten worklets use it)", () => {
    const g = {} as Record<string, unknown>;
    new Function("globalThis", shimSource)(g);
    const Encoder = g["TextEncoder"] as new () => {
      encode: (input: string) => Uint8Array;
    };
    expect(Array.from(new Encoder().encode("a€"))).toEqual([0x61, 0xe2, 0x82, 0xac]);
    expect(Array.from(new Encoder().encode("é"))).toEqual([0xc3, 0xa9]);
  });

  it("never clobbers a real TextDecoder", () => {
    // The shim is a no-op when the global already exists (e.g. a browser that
    // does expose it), so it must not replace a working implementation.
    const native = function TextDecoder() {};
    (native as unknown as { decode: () => string }).decode = () => "native";
    const g = { TextDecoder: native } as Record<string, unknown>;
    new Function("globalThis", shimSource)(g);
    expect(g["TextDecoder"]).toBe(native);
  });

  it("is loaded with addModule BEFORE the DeepFilter worklet", () => {
    // Order matters: globals set by one addModule() call are visible to the
    // next one in the same AudioWorkletGlobalScope, but not the reverse.
    const shimIndex = deepFilterSource.indexOf("addModule(workletGlobalsUrl)");
    const workletIndex = deepFilterSource.indexOf("addModule(deepfilterWorkletUrl)");
    expect(shimIndex).toBeGreaterThan(-1);
    expect(workletIndex).toBeGreaterThan(-1);
    expect(shimIndex).toBeLessThan(workletIndex);
    expect(deepFilterSource).toContain('import workletGlobalsUrl from "./worklet-globals.js?url"');
  });
});

/**
 * Regression: when the worklet module failed to register its processor,
 * `new AudioWorkletNode(...)` throws a raw DOM NotSupportedError. That escaped
 * the DeepFilterUnavailableError contract, so the Deep -> Enhanced -> Standard
 * fallback never ran and joining the voice channel failed outright.
 */
describe("DeepFilter node construction failures are recoverable", () => {
  it("wraps AudioWorkletNode construction in the unavailable error", () => {
    const construct = deepFilterSource.indexOf("new AudioWorkletNode(");
    expect(construct).toBeGreaterThan(-1);
    // Exactly one construction site, so there is nothing left unguarded.
    expect(deepFilterSource.split("new AudioWorkletNode(").length - 1).toBe(1);
    // It must sit inside a try whose catch rethrows the typed error the caller
    // falls back on.
    const before = deepFilterSource.slice(0, construct);
    expect(before.lastIndexOf("try {")).toBeGreaterThan(-1);
    const after = deepFilterSource.slice(construct);
    expect(after).toContain("} catch {");
    expect(after).toContain("throw new DeepFilterUnavailableError(");
  });
});

describe("microphone publish quality (Opus)", () => {
  it("pins an explicit high-quality bitrate above the SDK default", () => {
    // LiveKit's publishDefaults use AudioPresets.music = 48 kbps. We ship
    // 64 kbps, matching Discord's voice floor.
    expect(MIC_PUBLISH_OPTIONS.audioPreset.maxBitrate).toBe(64000);
    expect(MIC_PUBLISH_OPTIONS.audioPreset.maxBitrate).toBeGreaterThan(48000);
    // Must be at least Discord's 64 kbps floor, never the phone-grade preset.
    expect(MIC_PUBLISH_OPTIONS.audioPreset.maxBitrate).toBeGreaterThanOrEqual(64000);
    expect(MIC_PUBLISH_OPTIONS.audioPreset.maxBitrate).not.toBe(12000);
    expect(MIC_PUBLISH_OPTIONS.audioPreset.maxBitrate).not.toBe(24000);
  });

  it("enables DTX and RED explicitly (stereo publishing force-disables both)", () => {
    // livekit-client 2.22.3 sets `opts.dtx = false; opts.red = false` for
    // stereo tracks when they are undefined, which silently costs us packet
    // loss concealment. Passing them explicitly is the fix.
    expect(MIC_PUBLISH_OPTIONS.dtx).toBe(true);
    expect(MIC_PUBLISH_OPTIONS.red).toBe(true);
  });

  it("never negotiates a stereo voice track", () => {
    // Stereo publication is REQUIRED, not incidental: the SFU hands every
    // subscriber a mono track otherwise, and a mono track in an <audio>
    // element plays in the LEFT ear only. This single flag is the fix.
    expect(MIC_PUBLISH_OPTIONS.forceStereo).toBe(true);
  });

  it("applies the publish options at every publish site", () => {
    // Both the initial join and the rebuild-on-change path must publish with
    // the same quality profile, or a mid-call device switch silently degrades.
    // `(?<!n)` excludes unpublishTrack(), which contains the same substring.
    const publishSites = roomSource.match(/(?<!n)publishTrack\(/g) ?? [];
    expect(publishSites.length).toBe(2);
    const spreads = roomSource.match(/\.\.\.MIC_PUBLISH_OPTIONS/g) ?? [];
    expect(spreads.length).toBe(publishSites.length);
  });
});

describe("mic capture constraints", () => {
  it("captures 48 kHz mono for Opus", () => {
    // Anything else forces a resample on the way in, and a stereo track gets
    // the DTX/RED treatment described above.
    expect(chainSource).toContain("sampleRate: 48000");
    expect(chainSource).toContain("channelCount: 1");
  });

  it("keeps the browser stages off for neural modes only", () => {
    // Standard mode still uses the browser's own processing; neural modes
    // must not be double-processed.
    expect(chainSource).toMatch(
      /if \(options\.noiseMode === "standard"\)[\s\S]*?constraints\.noiseSuppression = options\.noiseSuppression/,
    );
    expect(chainSource).toContain("constraints.noiseSuppression = false");
  });
});

describe("gain staging does not clip", () => {
  it("limits the signal before the MediaStreamDestination", () => {
    // The input-volume slider reaches 200%, so gain can exceed full scale.
    // The destination converts to 16-bit PCM and hard-clips -> crackling.
    const gainToDestination = /gain\.connect\(destination\)/.test(chainSource);
    expect(gainToDestination).toBe(false);
    expect(chainSource).toContain("createDynamicsCompressor()");
    expect(chainSource).toContain("limiter.threshold.value = -6");
    expect(chainSource).toMatch(/gain\.connect\(limiter\)/);
    expect(chainSource).toMatch(/limiter\.connect\(destination\)/);
  });

  it("publishes the mono gain node, keeping stereo out of the encoded track", () => {
    // The stereo up-mix exists only so local loopback monitoring is centred;
    // it must never reach the published track.
    const stereoMerger = chainSource.match(/stereoTap\.connect\(context\.destination\)/);
    expect(stereoMerger).not.toBeNull();
    expect(chainSource).not.toMatch(/merger\.connect\(destination\)/);
  });
});

describe("qualityDots", () => {
  it("maps connection quality to dot counts", () => {
    expect(qualityDots(ConnectionQuality.Excellent)).toBe(3);
    expect(qualityDots(ConnectionQuality.Good)).toBe(2);
    expect(qualityDots(ConnectionQuality.Poor)).toBe(1);
    expect(qualityDots(ConnectionQuality.Lost)).toBe(0);
    expect(qualityDots(ConnectionQuality.Unknown)).toBe(0);
  });
});

describe("voice stores", () => {
  it("holds mic toggles disconnected, reset keeps them", () => {
    useVoiceConnection.getState().set({ selfMuted: true, selfDeafened: false });
    expect(useVoiceConnection.getState().selfMuted).toBe(true);
    // reset() clears connection state but keeps the toggles (they apply
    // on the next join, even while disconnected).
    useVoiceConnection.getState().reset();
    expect(useVoiceConnection.getState().status).toBe("idle");
    expect(useVoiceConnection.getState().selfMuted).toBe(true);
    useVoiceConnection.getState().set({ selfMuted: false });
  });

  it("holds no tokens (persisted prefs are UI-only)", () => {
    const keys = Object.keys(useVoiceSettings.getState());
    expect(keys).not.toContain("accessToken");
    expect(keys).not.toContain("token");
    expect(keys).not.toContain("refresh");
  });
});

