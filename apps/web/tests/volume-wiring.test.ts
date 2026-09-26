// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { resetUpmixContext } from "../src/voice/upmix.js";
import {
  attachRemoteAudio,
  detachRemoteAudio,
  remoteAudioContainer,
  remoteAudioCount,
  setRemoteAudioVolume,
  type AttachableAudioTrack,
} from "../src/voice/remoteAudio.js";

/**
 * End-to-end wiring check for the per-user listen volume: the slider calls
 * setRemoteAudioVolume(identity, v), which must reach the hidden <audio>
 * element carrying that participant's mic track and set element.volume.
 */

function fakeTrack(opts?: { mono?: boolean }): AttachableAudioTrack {
  const attached: HTMLMediaElement[] = [];
  return {
    attachedElements: attached,
    mediaStreamTrack: {
      kind: "audio",
      getSettings: () => ({ channelCount: opts?.mono === true ? 1 : 2 }),
    } as unknown as MediaStreamTrack,
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
 * Regression: remote microphone audio played in ONE EAR.
 *
 * LiveKit delivers a mono Opus track to subscribers, and a mono track played
 * straight into an <audio> element comes out on the left channel only in
 * Chromium/Electron. attachRemoteAudio must re-point the element at a stereo
 * up-mix, feeding the mono source into BOTH ChannelMerger inputs.
 */
interface FakeNode {
  __kind: string;
  connect: (target: FakeNode, out?: number, input?: number) => void;
}

function fakeNode(kind: string, log?: string[], label = kind): FakeNode {
  return {
    __kind: label,
    connect: (target: FakeNode, out?: number, input?: number) => {
      log?.push(`${kind}->${target.__kind}:${String(out)}:${String(input)}`);
    },
  };
}

/** Records every graph edge so the test can assert the exact wiring. */
class UpmixAudioContext {
  static instances: UpmixAudioContext[] = [];
  state: AudioContextState = "running";
  edges: string[] = [];
  outputs: MediaStream[] = [];
  private sourceIndex = 0;

  constructor() {
    UpmixAudioContext.instances.push(this);
  }

  createMediaStreamSource(): FakeNode {
    const index = this.sourceIndex++;
    return fakeNode(`source${index}`, this.edges);
  }

  createChannelMerger(): FakeNode {
    return fakeNode("merger", this.edges, "merger");
  }

  createChannelSplitter(): FakeNode {
    return fakeNode("splitter", this.edges, "splitter");
  }

  createMediaStreamDestination(): FakeNode & { stream: MediaStream } {
    const stream = new MediaStream();
    // happy-dom cannot construct MediaStreamTrack ("Illegal constructor"), so
    // give the destination a stub track the disposal path can stop.
    const stub = { kind: "audio", stop: () => undefined } as unknown as MediaStreamTrack;
    stream.getAudioTracks = (): MediaStreamTrack[] => [stub];
    this.outputs.push(stream);
    return Object.assign(fakeNode("destination", this.edges), { stream });
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }
}

/** Install the fake context, run `fn`, then restore the global. */
async function withUpmixContext(fn: (get: () => UpmixAudioContext) => void): Promise<void> {
  const original = (globalThis as { AudioContext?: unknown }).AudioContext;
  (globalThis as { AudioContext?: unknown }).AudioContext = UpmixAudioContext;
  UpmixAudioContext.instances = [];
  try {
    // The module caches its context, so start each case from a clean slate.
    resetUpmixContext();
    fn(() => {
      const ctx = UpmixAudioContext.instances.at(-1);
      if (ctx === undefined) {
        throw new Error("upmix did not create an AudioContext");
      }
      return ctx;
    });
  } finally {
    resetUpmixContext();
    (globalThis as { AudioContext?: unknown }).AudioContext = original;
  }
}

describe("remote mic mono→stereo centring", () => {
  it("feeds a mono remote track into BOTH merger inputs (not left only)", async () => {
    await withUpmixContext((get) => {
      const element = attachRemoteAudio(fakeTrack({ mono: true }), "user-mono");
      expect(element).not.toBeNull();
      // A bare `connect(merger)` maps to output 0 (LEFT) only — the bug.
      expect(get().edges).toEqual([
        "source0->merger:0:0",
        "source0->merger:0:1",
        "merger->destination:undefined:undefined",
      ]);
      // Mono must not be routed through a splitter.
      expect(get().edges.join(" ")).not.toContain("splitter");
    });
  });

  it("routes the element at the up-mixed stereo stream, not the raw mono one", async () => {
    await withUpmixContext((get) => {
      const element = attachRemoteAudio(fakeTrack({ mono: true }), "user-mono-2");
      expect(element?.srcObject).toBe(get().outputs.at(-1));
    });
  });

  it("keeps genuine stereo sources separated via a splitter", async () => {
    await withUpmixContext(() => {
      attachRemoteAudio(fakeTrack(), "user-stereo");
    });
    const ctx = UpmixAudioContext.instances[0];
    expect(ctx?.edges).toEqual([
      "source0->splitter:undefined:undefined",
      "splitter->merger:0:0",
      "splitter->merger:1:1",
      "merger->destination:undefined:undefined",
    ]);
  });

  it("still plays audio when WebAudio is unavailable", () => {
    // No AudioContext at all: the direct attach must survive (one ear, audible)
    // rather than dropping the participant entirely.
    const original = (globalThis as { AudioContext?: unknown }).AudioContext;
    (globalThis as { AudioContext?: unknown }).AudioContext = undefined;
    try {
      resetUpmixContext();
      const element = attachRemoteAudio(fakeTrack({ mono: true }), "user-no-wa");
      expect(element).not.toBeNull();
      expect(element?.srcObject).toBeInstanceOf(MediaStream);
    } finally {
      resetUpmixContext();
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });

  it("stops the up-mixed track on detach so the graph is released", async () => {
    await withUpmixContext(() => {
      const track = fakeTrack({ mono: true });
      const element = attachRemoteAudio(track, "user-detach");
      const upmixed = element?.srcObject;
      expect(upmixed).toBeInstanceOf(MediaStream);
      const stopped: string[] = [];
      for (const t of (upmixed as MediaStream).getAudioTracks()) {
        t.stop = () => stopped.push("stopped");
      }
      detachRemoteAudio(track);
      expect(stopped).toEqual(["stopped"]);
      expect(element?.srcObject).toBeNull();
      expect(remoteAudioCount()).toBe(0);
    });
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
