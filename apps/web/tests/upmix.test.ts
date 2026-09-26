// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { __resetSharedPlaybackContext } from "../src/voice/boost.js";
import { attachRemoteAudio, clearRemoteAudio } from "../src/voice/remoteAudio.js";
import { centerMonoTrack, isMonoTrack } from "../src/voice/upmix.js";

/**
 * Behavioural test for the mono→stereo centring of remote audio.
 *
 * The first attempt at this feature SILENCED every voice track, so these tests
 * assert the actual WebAudio wiring (both merger inputs fed) and the fallbacks,
 * not merely that certain strings exist in the source.
 */


interface Connection {
  output: number;
  input: number;
}

/** Minimal AudioContext that records the graph it is asked to build. */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static suspended = false;
  static gesture = false;
  state: AudioContextState;
  connections: Connection[] = [];
  destination = {};

  constructor() {
    // Chromium leaves a context created outside a gesture suspended.
    this.state = FakeAudioContext.suspended ? "suspended" : "running";
    FakeAudioContext.instances.push(this);
  }

  static get last(): FakeAudioContext | undefined {
    return FakeAudioContext.instances.at(-1);
  }

  createMediaStreamSource(): { connect: (t: unknown, o: number, i: number) => void } {
    return {
      connect: (_target, output, input) => {
        this.connections.push({ output, input });
      },
    };
  }

  createChannelMerger(): { connect: (t: unknown) => void } {
    return { connect: () => undefined };
  }

  createMediaStreamDestination(): {
    stream: MediaStream;
    connect: (t: unknown) => void;
  } {
    const stream = new MediaStream();
    // happy-dom's MediaStream yields no tracks; stub the one the code needs.
    stream.getAudioTracks = () =>
      [{ stop: () => undefined }] as unknown as MediaStreamTrack[];
    return { stream, connect: () => undefined };
  }

  resume(): Promise<void> {
    // Chromium only flips a context to "running" once a user gesture unlocks
    // it; a resume() outside a gesture is a no-op (and may reject). Mirror that
    // so the tests exercise the same suspended fallback as the browser.
    if (FakeAudioContext.gesture) {
      this.state = "running";
    }
    return Promise.resolve();
  }

  /** Simulate the user gesture the unlock listeners wait for. */
  unlock(): void {
    FakeAudioContext.gesture = true;
    for (const ctx of FakeAudioContext.instances) {
      void ctx.resume();
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function fakeTrack(channelCount: number | undefined): MediaStreamTrack {
  return {
    getSettings: () => (channelCount === undefined ? {} : { channelCount }),
    kind: "audio",
    stop: () => undefined,
  } as unknown as MediaStreamTrack;
}

function installContext(): unknown {
  const original = (globalThis as { AudioContext?: unknown }).AudioContext;
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  return original;
}

beforeEach(() => {
  document.body.innerHTML = "";
  FakeAudioContext.instances = [];
  FakeAudioContext.suspended = false;
  FakeAudioContext.gesture = false;
  __resetSharedPlaybackContext();
});

describe("isMonoTrack", () => {
  it("only treats an explicitly mono track as mono", () => {
    expect(isMonoTrack(fakeTrack(1))).toBe(true);
    expect(isMonoTrack(fakeTrack(2))).toBe(false);
    // Unknown channel count must not be rerouted.
    expect(isMonoTrack(fakeTrack(undefined))).toBe(false);
    expect(isMonoTrack(null)).toBe(false);
  });
});

describe("centerMonoTrack", () => {
  it("feeds the mono source into BOTH merger inputs so the voice is centred", () => {
    const original = installContext();
    try {
      const graph = centerMonoTrack(fakeTrack(1));
      expect(graph).not.toBeNull();
      // ChannelMergerNode maps input N to output N: feeding only input 0 puts
      // the whole voice in the LEFT ear. Both must be connected.
      expect(FakeAudioContext.last?.connections).toEqual([
        { output: 0, input: 0 },
        { output: 0, input: 1 },
      ]);
      expect(graph?.input.getAudioTracks()).toHaveLength(1);
      graph?.release();
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });

  it("returns null for a stereo track (nothing to centre)", () => {
    const original = installContext();
    try {
      expect(centerMonoTrack(fakeTrack(2))).toBeNull();
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });

  // The exact failure that muted the whole room: a suspended AudioContext's
  // MediaStreamDestination outputs silence while <audio> still reports playing.
  it("refuses to build the graph while the context is suspended", () => {
    const original = installContext();
    FakeAudioContext.suspended = true;
    try {
      expect(centerMonoTrack(fakeTrack(1))).toBeNull();
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });
});

describe("remote audio centring wiring", () => {
  /** Attach a new element for the track. */
  function attachWithTrack(
    track: MediaStreamTrack,
    identity: string,
  ): HTMLAudioElement {
    const element = attachRemoteAudio(
      {
        attachedElements: [],
        attach: () => {
          const el = document.createElement("audio");
          el.srcObject = new MediaStream([track]);
          return el;
        },
        detach: (el?: HTMLAudioElement) => el ?? [],
        mediaStreamTrack: track,
      },
      identity,
    );
    expect(element).not.toBeNull();
    if (element === null) {
      throw new Error("attachRemoteAudio returned no element");
    }
    return element;
  }

  it("swaps a mono element onto the centred stream", () => {
    const original = installContext();
    try {
      const element = attachWithTrack(fakeTrack(1), "user-mono");
      // Both merger inputs were fed, so the element now plays a centred stream.
      expect(FakeAudioContext.last?.connections).toEqual([
        { output: 0, input: 0 },
        { output: 0, input: 1 },
      ]);
      expect(element.srcObject).not.toBeNull();
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });

  it("leaves the element on the direct stream when centring is unavailable", () => {
    const original = installContext();
    FakeAudioContext.suspended = true;
    try {
      const track = fakeTrack(1);
      const direct = new MediaStream([track]);
      const element = attachRemoteAudio(
        {
          attachedElements: [],
          attach: () => {
            const el = document.createElement("audio");
            el.srcObject = direct;
            return el;
          },
          detach: (el?: HTMLAudioElement) => el ?? [],
          mediaStreamTrack: track,
        },
        "user-suspended",
      );
      expect(element).not.toBeNull();
      if (element === null) {
        throw new Error("attachRemoteAudio returned no element");
      }
      // Audio must still be attached — one ear beats silence.
      expect(element.srcObject).toBe(direct);
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });

  it("does not touch the element for a track with no underlying media track", () => {
    const original = installContext();
    try {
      const element = attachRemoteAudio(
        {
          attachedElements: [],
          attach: () => {
            const el = document.createElement("audio");
            el.srcObject = new MediaStream();
            return el;
          },
          detach: (el?: HTMLAudioElement) => el ?? [],
        },
        "user-opaque",
      );
      // Without a mediaStreamTrack there is nothing to measure, so the direct
      // attach is kept (this is the pre-existing LiveKit Track path).
      expect(FakeAudioContext.instances).toHaveLength(0);
      expect(element).not.toBeNull();
      expect(element?.srcObject).toBeInstanceOf(MediaStream);
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });

  it("releases the graph on clearRemoteAudio", () => {
    const original = installContext();
    try {
      attachWithTrack(fakeTrack(1), "user-teardown");
      expect(() => clearRemoteAudio()).not.toThrow();
      expect(document.getElementById("remote-audio-container")).toBeNull();
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });
});

