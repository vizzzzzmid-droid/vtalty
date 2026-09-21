import { ConnectionQuality } from "livekit-client";
import { describe, expect, it } from "vitest";
import { qualityDots, useVoiceConnection } from "../src/voice/store.js";
import { useVoiceSettings } from "../src/voice/settings.js";

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
