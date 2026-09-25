// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { ConnectionQuality } from "livekit-client";
import { VOICE_SETTINGS_DEFAULTS, voiceSettingsSchema } from "@vitality/shared";
import { qualityDots, useVoiceConnection } from "../src/voice/store.js";
import { useVoiceSettings, type NoiseMode } from "../src/voice/settings.js";

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

