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

  it("boosts past 100% by tapping the element's MediaStream", () => {
    // Regression guard: MediaElementAudioSourceNode delivers SILENCE for
    // elements whose srcObject is a MediaStream (measured in Chromium 153 with
    // a fake mic + RTCPeerConnection loopback) while the element keeps playing
    // directly — the whole 0..400% boost was inaudible because of it.
    expect(boostSource).not.toContain("ctx.createMediaElementSource");
    expect(boostSource).toContain("createMediaStreamSource(input)");
    expect(boostSource).toContain("ctx.createMediaStreamDestination()");
    // The graph output goes back into the element, so its own renderer keeps
    // the user's output device and its autoplay state.
    expect(boostSource).toContain("element.srcObject = node.output;");
    // Only reroute while the context runs (a suspended one plays silence).
    expect(boostSource).toContain('ctx.state === "running"');
    // Native element.volume is kept as the ≤100% fast path.
    expect(boostSource).toContain("element.volume = clamped;");
  });

  it("boost survives suspended contexts, stream drift and dead inputs", () => {
    // The swap is retried (statechange flush + every apply) instead of being
    // armed once: a boost created while the AudioContext was suspended used
    // to leave the element half-wired — the gain existed but every slider
    // move hit a GainNode the element was never attached to.
    expect(boostSource).toContain('addEventListener("statechange"');
    expect(boostSource).toContain("pendingActivations");
    expect(boostSource).toContain("syncBoost(element, existing)");
    // Until the swap happens ≤100% keeps moving the real element.volume...
    expect(boostSource).toContain(
      "element.volume = Math.min(1, node.gain.gain.value);",
    );
    // ...and a ≤100% request on a never-activated node releases the graph
    // entirely instead of writing into an orphaned GainNode.
    expect(boostSource).toMatch(
      /releaseElementVolume\(element\);\r?\n    element\.volume = clamped;/,
    );
    // A replaced srcObject (LiveKit re-attach / tile cleanup) is re-tapped
    // and the element is swapped back onto the graph output.
    expect(boostSource).toContain("retapInput(node, current);");
    // Chromium stops delivering a WebRTC stream nothing consumes — the
    // graph's own MediaStreamSourceNode does not count — so a muted hidden
    // keeper element plays the original stream while the boost is active.
    expect(boostSource).toContain("keeper.muted = true;");
    expect(boostSource).toContain("document.body.appendChild(keeper);");
    expect(boostSource).toContain("node.keeper.remove();");
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
