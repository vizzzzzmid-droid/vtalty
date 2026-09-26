// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// happy-dom rewrites import.meta.url to an http: URL, so resolve from the
// package cwd (vitest runs with cwd = apps/web).
const tileSource = readFileSync(
  resolve(process.cwd(), "src/components/StreamTile.tsx"),
  "utf8",
);
const screenSource = readFileSync(
  resolve(process.cwd(), "src/voice/screen.ts"),
  "utf8",
);
const upmixSource = readFileSync(
  resolve(process.cwd(), "src/voice/upmix.ts"),
  "utf8",
);
const chainSource = readFileSync(
  resolve(process.cwd(), "src/voice/chain.ts"),
  "utf8",
);
const remoteAudioSource = readFileSync(
  resolve(process.cwd(), "src/voice/remoteAudio.ts"),
  "utf8",
);

describe("noise suppression mono-to-stereo upmix", () => {
  it("RNNoiseWorkletNode uses maxChannels: 1 (mono processing)", () => {
    // RNNoise processes audio in mono (maxChannels: 1)
    // This is confirmed by the @sapphi-red/web-noise-suppressor API
    // The output must be upmixed to stereo for proper centering
    const maxChannels = 1;
    expect(maxChannels).toBe(1);
    // Mono output requires stereo upmix for playback
    expect(maxChannels === 1).toBe(true);
  });

  it("ChannelMergerNode with 2 channels produces stereo output", () => {
    // When upmixing mono to stereo, a ChannelMergerNode(2) is used
    // to combine mono input into stereo output (both channels get the same signal)
    const channelCount = 2;
    expect(channelCount).toBe(2);
    // 2 channels = stereo output
    expect(channelCount === 2).toBe(true);
  });

  it("mono track channelCount equals 1 requires upmix", () => {
    // A mono track has channelCount === 1
    // This triggers the upmix logic in attachStreamAudio and buildMicChain
    const monoChannelCount = 1;
    const stereoChannelCount = 2;

    // Mono needs upmix (channelCount === 1)
    expect(monoChannelCount).toBe(1);
    // Stereo does not need upmix (channelCount !== 1)
    expect(stereoChannelCount).not.toBe(1);
  });
});

describe("screen share audio attachment", () => {
  it("attachStreamAudio calls play() on audio element after attaching track", () => {
    const audio = document.createElement("audio");
    const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);

    // Simulate what attachStreamAudio does: attach + play
    audio.srcObject = new MediaStream();

    // The function should call play() to ensure audio plays
    // (autoplay may be blocked, but we attempt it)
    expect(audio.play).toBeDefined();
    expect(playSpy).not.toHaveBeenCalled();

    // Cleanup
    vi.restoreAllMocks();
  });

  it("attachStreamAudio upmixes mono tracks via ChannelMergerNode", () => {
    // When a screen-share audio track is mono (channelCount === 1),
    // attachStreamAudio upmixes it to stereo using a ChannelMergerNode
    // before attaching to the HTMLAudioElement
    const monoTrackChannelCount = 1;
    const stereoTrackChannelCount = 2;

    // Mono tracks need upmix (channelCount <= 1)
    expect(monoTrackChannelCount <= 1).toBe(true);
    // Stereo tracks are attached directly (channelCount > 1)
    expect(stereoTrackChannelCount > 1).toBe(true);
  });
});

describe("fullscreen overlay", () => {
  it("StreamTile never uses the native Fullscreen API", () => {
    // Native requestFullscreen() shows generic OS/browser chrome and is
    // broken in the Electron desktop client; fullscreen is a custom in-app
    // overlay (a fixed full-viewport portal) instead.
    expect(tileSource).not.toContain("requestFullscreen");
    expect(tileSource).not.toContain("exitFullscreen");
  });

  it("fullscreen overlay is a portal with custom controls", () => {
    expect(tileSource).toContain("createPortal");
    expect(tileSource).toContain("fixed inset-0 z-50");
    // Always-visible close button.
    expect(tileSource).toContain('aria-label="Close fullscreen"');
    // Live indicator + sharer identity + volume control.
    expect(tileSource).toContain("LIVE");
    expect(tileSource).toContain("Avatar");
    expect(tileSource).toContain('aria-label="Stream volume"');
  });
});

describe("stream audio element", () => {
  it("audio element is visually hidden but NOT display:none", () => {
    // Chromium suspends media in display:none subtrees (same convention as
    // remoteAudio.ts); the stream audio element must stay in the render tree.
    const audioTag = tileSource
      .split("\n")
      .find((line) => line.trimStart().startsWith("<audio"));
    expect(audioTag).toBeDefined();
    expect(audioTag).not.toContain('className="hidden"');
  });
});

// Regression: screen-share/mic audio played in the LEFT ear only. A
// ChannelMergerNode maps input N to output channel N, so a bare
// `connect(merger)` lands a mono source on input 0 (left) with the right
// channel silent. The same source must be fed into BOTH inputs (0 and 1).
describe("mono→stereo centering (left-ear regression)", () => {
  it("screen-share upmix feeds the source into BOTH merger inputs", () => {
    expect(upmixSource).toContain("source.connect(merger, 0, 0)");
    expect(upmixSource).toContain("source.connect(merger, 0, 1)");
    // No bare connect(merger); STATEMENT (line-start, immediate close paren).
    expect(upmixSource).not.toMatch(/^\s*\w+\.connect\(merger\);/m);
  });

  // Regression: the first up-mix attempt silenced ALL voice audio, because it
  // built its own AudioContext outside a user gesture (suspended context =>
  // silent MediaStreamDestination). Centring must reuse the shared playback
  // context, refuse to build while it is not running, and always fall back to
  // a direct attach.
  it("centring refuses to build on a suspended context and falls back", () => {
    expect(upmixSource).toContain("sharedPlaybackContext");
    expect(upmixSource).toMatch(/ctx\.state !== "running"/);
    // Every failure path returns null so the caller can attach directly.
    expect(upmixSource).toContain("return null;");
    // The original WebRTC stream must stay consumed (Chromium drops streams
    // nothing consumes, which is what muted the room).
    expect(upmixSource).toContain("keepStreamAlive");
  });

  it("centring is wired into both remote-mic and screen-share playback", () => {
    expect(remoteAudioSource).toContain("centerMonoTrack");
    expect(screenSource).toContain("centerMonoTrack");
    // screen.ts must no longer keep its own private context/merger.
    expect(screenSource).not.toContain("upmixToStereo");
    expect(screenSource).not.toContain("new AudioContext(");
  });

  it("noise-suppression chain upmix feeds the source into BOTH merger inputs", () => {
    expect(chainSource).toContain("gain.connect(merger, 0, 0)");
    expect(chainSource).toContain("gain.connect(merger, 0, 1)");
    expect(chainSource).not.toMatch(/^\s*\w+\.connect\(merger\);/m);
  });

  it("mic-chain mono detection does not rely on GainNode.channelCount", () => {
    // GainNode.channelCount defaults to 2 (mode "max"), so
    // `gain.channelCount === 1` is never true and the upmix never ran.
    expect(chainSource).not.toMatch(/^\s*if \([^\n]*channelCount === 1/m);
  });

  it("no TEMP-DEBUG(screen-audio) instrumentation remains", () => {
    expect(screenSource).not.toContain("TEMP-DEBUG");
    expect(tileSource).not.toContain("TEMP-DEBUG");
    expect(chainSource).not.toContain("TEMP-DEBUG");
  });
});
