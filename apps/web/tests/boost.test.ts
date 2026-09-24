import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_VOLUME, clampVolume } from "../src/voice/boost.js";

function source(path: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/${path}`, import.meta.url)),
    "utf8",
  );
}

const boostSource = source("voice/boost.ts");
const remoteAudioSource = source("voice/remoteAudio.ts");
const roomSource = source("voice/room.ts");
const screenSource = source("voice/screen.ts");
const participantsSource = source("components/VoiceParticipants.tsx");
const streamTileSource = source("components/StreamTile.tsx");

describe("clampVolume", () => {
  it("clamps into the 0..MAX_VOLUME range", () => {
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(1)).toBe(1);
    expect(clampVolume(2.5)).toBe(2.5);
    expect(clampVolume(4)).toBe(4);
    expect(clampVolume(400)).toBe(MAX_VOLUME);
  });

  it("treats non-finite input as 100%", () => {
    expect(clampVolume(Number.NaN)).toBe(1);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("volume boost wiring (up to 400%)", () => {
  it("caps the boost at 4x", () => {
    expect(MAX_VOLUME).toBe(4);
  });

  it("boosts past 100% through a MediaElementSource + GainNode", () => {
    expect(boostSource).toContain("createMediaElementSource(element)");
    expect(boostSource).toContain("gain.connect(ctx.destination)");
    // Native element.volume is kept as the ≤100% fast path.
    expect(boostSource).toContain("element.volume = clamped;");
  });

  it("per-user voice volume no longer relies on LiveKit setVolume", () => {
    expect(roomSource).toContain("setRemoteAudioVolume(participant.identity, volume)");
    expect(roomSource).toContain("setRemoteAudioVolume(userId, volume)");
    expect(roomSource).not.toContain("(participant as RemoteParticipant).setVolume");
  });

  it("hidden voice elements route volume through the boost module", () => {
    expect(remoteAudioSource).toContain("applyElementVolume(element, volume)");
    expect(remoteAudioSource).toContain("releaseElementVolume(element)");
  });

  it("stream volume targets the tile elements through the boost module", () => {
    expect(screenSource).toContain("applyElementVolume(element, volume)");
    expect(screenSource).not.toContain("participant.setVolume(volume");
  });

  it("volume sliders allow up to 400%", () => {
    expect(participantsSource).toContain("max={400}");
    expect(streamTileSource.match(/max=\{400\}/g)).toHaveLength(2);
    expect(participantsSource).not.toContain("max={100}");
    expect(streamTileSource).not.toContain("max={100}");
  });
});
