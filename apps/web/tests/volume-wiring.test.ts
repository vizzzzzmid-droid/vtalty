// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  attachRemoteAudio,
  remoteAudioContainer,
  setRemoteAudioVolume,
  type AttachableAudioTrack,
} from "../src/voice/remoteAudio.js";

/**
 * End-to-end wiring check for the per-user listen volume: the slider calls
 * setRemoteAudioVolume(identity, v), which must reach the hidden <audio>
 * element carrying that participant's mic track and set element.volume.
 */

function fakeTrack(): AttachableAudioTrack {
  const attached: HTMLMediaElement[] = [];
  return {
    attachedElements: attached,
    attach: () => {
      const element = document.createElement("audio");
      element.srcObject = new MediaStream();
      attached.push(element);
      return element;
    },
    detach: (element?: HTMLMediaElement) => element ?? [],
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("setRemoteAudioVolume end-to-end", () => {
  it("drives element.volume for the matching identity only", () => {
    const track = fakeTrack();
    const element = attachRemoteAudio(track, "user-1");
    expect(element).not.toBeNull();
    expect(remoteAudioContainer().contains(element)).toBe(true);

    setRemoteAudioVolume("user-1", 0);
    expect(element?.volume).toBe(0);
    setRemoteAudioVolume("user-1", 0.42);
    expect(element?.volume).toBeCloseTo(0.42);

    // Unknown identities must not touch the element.
    setRemoteAudioVolume("someone-else", 0);
    expect(element?.volume).toBeCloseTo(0.42);
  });
});

/**
 * Minimal AudioContext stand-in: happy-dom has none, and the boost path only
 * needs source/gain/destination creation to prove the routing decision.
 */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = "running";
  destination = {};
  gains: { value: number }[] = [];
  outputs: MediaStream[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource(): { connect: () => void } {
    return { connect: () => undefined };
  }

  createGain(): { gain: { value: number }; connect: () => void } {
    const gain = { value: 0 };
    this.gains.push(gain);
    return { gain, connect: () => undefined };
  }

  createMediaStreamDestination(): { stream: MediaStream; connect: () => void } {
    const stream = new MediaStream();
    this.outputs.push(stream);
    return { stream, connect: () => undefined };
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }
}

describe("boost graph (fake AudioContext)", () => {
  it("reroutes a MediaStream element through a GainNode above 100%", () => {
    const original = (globalThis as { AudioContext?: unknown }).AudioContext;
    (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
    try {
      const track = fakeTrack();
      const element = attachRemoteAudio(track, "user-boost");
      expect(element).not.toBeNull();
      const ownStream = element?.srcObject;
      expect(ownStream).toBeInstanceOf(MediaStream);

      setRemoteAudioVolume("user-boost", 2);
      const ctx = FakeAudioContext.instances.at(-1);
      expect(ctx).toBeDefined();
      // The gain carries the 200% (never element.volume).
      expect(ctx?.gains.map((g) => g.value)).toEqual([2]);
      // The element was switched onto the graph output stream...
      expect(element?.srcObject).toBe(ctx?.outputs[0]);
      expect(element?.srcObject).not.toBe(ownStream);
      // ...with native volume pinned at 100%.
      expect(element?.volume).toBe(1);

      // Later slider moves reuse the same gain node (mute included).
      setRemoteAudioVolume("user-boost", 0);
      expect(ctx?.gains.map((g) => g.value)).toEqual([0]);
      expect(ctx?.outputs).toHaveLength(1);
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });
});
