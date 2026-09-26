// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { __resetSharedPlaybackContext } from "../src/voice/boost.js";
import {
  attachRemoteAudio,
  clearRemoteAudio,
  detachRemoteAudio,
} from "../src/voice/remoteAudio.js";
import { centerMonoTrack, isMonoTrack, isStereoTrack } from "../src/voice/upmix.js";

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
  private listeners: (() => void)[] = [];

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

  /**
   * `onPlaybackRunning` waits on `statechange`; the fake has to honour it or the
   * deferred centring path can never be exercised.
   */
  addEventListener(type: string, listener: () => void): void {
    if (type === "statechange") {
      this.listeners.push(listener);
    }
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "statechange") {
      this.listeners = this.listeners.filter((l) => l !== listener);
    }
  }

  /** Flip to running and fire `statechange`, as a real context would. */
  fireStateChange(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
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

/** Attach a new element for `track` through the real public entry point. */
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

describe("isMonoTrack", () => {
  it("treats mono and not-yet-reported tracks as mono, but leaves stereo alone", () => {
    expect(isMonoTrack(fakeTrack(1))).toBe(true);
    expect(isMonoTrack(fakeTrack(2))).toBe(false);
    // An unreported channelCount means the SFU default (mono) and is the
    // situation that actually occurs on a freshly attached remote track:
    // waiting for the number was what kept RNNoise voices in one ear.
    expect(isMonoTrack(fakeTrack(undefined))).toBe(true);
    expect(isMonoTrack(null)).toBe(false);
    expect(isMonoTrack(undefined)).toBe(false);
    // The complementary predicate drives the "never retry" decision.
    expect(isStereoTrack(fakeTrack(2))).toBe(true);
    expect(isStereoTrack(fakeTrack(1))).toBe(false);
    expect(isStereoTrack(fakeTrack(undefined))).toBe(false);
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

// Regression for the actual reported bug: "RNNoise on, voice in the left ear
// only". At attach time the LiveKit track is brand new (its channelCount is
// usually not reported yet) AND the shared playback context is still suspended
// (attaching happens after the async connect, outside the join click). The old
// code treated "cannot centre right now" as "never" and silently kept the
// one-ear audio for the whole call.
describe("deferred centring (left-ear regression)", () => {
  it("centres later, once the shared context is actually running", () => {
    const original = installContext();
    FakeAudioContext.suspended = true;
    try {
      // A track whose channelCount is not reported yet — the live situation.
      const track = fakeTrack(undefined);
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
        "user-deferred",
      );
      expect(element).not.toBeNull();
      // Audible immediately, even though centring is not possible yet.
      expect(element?.srcObject).toBe(direct);
      expect(FakeAudioContext.last?.connections ?? []).toHaveLength(0);

      // The gesture unlocks the shared context...
      const ctx = FakeAudioContext.last;
      expect(ctx?.state).toBe("suspended");
      if (ctx === undefined) {
        throw new Error("no context was created");
      }
      ctx.unlock();
      ctx.fireStateChange();

      // ...and the element is upgraded to the centred stream, not left as-is.
      expect(FakeAudioContext.last?.connections).toEqual([
        { output: 0, input: 0 },
        { output: 0, input: 1 },
      ]);
      expect(element?.srcObject).not.toBe(direct);
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });

  it("never retries a track that is known to be stereo", () => {
    const original = installContext();
    FakeAudioContext.suspended = true;
    try {
      const element = attachWithTrack(fakeTrack(2), "user-stereo");
      // Stereo needs no centring, so no context is built and no retry armed:
      // re-checking a settled channelCount on every statechange is pointless.
      expect(FakeAudioContext.instances).toHaveLength(0);
      expect(element.srcObject).toBeInstanceOf(MediaStream);
      FakeAudioContext.instances.forEach((ctx) => ctx.fireStateChange());
      expect(FakeAudioContext.instances).toHaveLength(0);
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });

  it("cancels a pending retry when the element is detached", () => {
    const original = installContext();
    FakeAudioContext.suspended = true;
    try {
      const track = fakeTrack(undefined);
      const element = attachWithTrack(track, "user-leaves");
      // Centring is pending: the context exists but is suspended.
      const ctx = FakeAudioContext.last;
      expect(ctx?.state).toBe("suspended");

      detachRemoteAudio(
        {
          attachedElements: [element],
          attach: () => element,
          detach: (el?: HTMLAudioElement) => el ?? [],
          mediaStreamTrack: track,
        },
      );
      expect(element.isConnected).toBe(false);

      // A later unlock must not resurrect the graph on a removed element,
      // and must not leave the waiter registered for the session.
      ctx?.unlock();
      ctx?.fireStateChange();
      expect(FakeAudioContext.last?.connections ?? []).toHaveLength(0);
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });
});

