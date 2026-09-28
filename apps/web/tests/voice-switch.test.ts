// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceConnection } from "../src/voice/store.js";

/**
 * Every FakeRoom.connect() parks on one of these; a test releases them to
 * settle a join (so it can hold a join in flight exactly where it wants).
 */
const gates: Array<{ promise: Promise<void>; resolve: () => void }> = [];

function makeGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolveFn) => {
    resolve = resolveFn;
  });
  gates.push({ promise, resolve });
  return { promise, resolve };
}

async function releaseGates(): Promise<void> {
  for (const gate of gates) {
    gate.resolve();
  }
  gates.length = 0;
}

function fakeTrack(): { enabled: boolean; stop: () => void } {
  return { enabled: true, stop: () => undefined };
}

/** A livekit publication stand-in that records every subscription change. */
function fakePublication(source: string, kind: "audio" | "video") {
  const calls: boolean[] = [];
  return {
    source,
    kind,
    track: { mediaStreamTrack: {} },
    setSubscribed: (want: boolean): void => {
      calls.push(want);
    },
    subscribedCalls: calls,
  };
}

type FakePublication = ReturnType<typeof fakePublication>;

function fakeRemoteParticipant(identity: string, publications: FakePublication[]) {
  return {
    identity,
    isLocal: false,
    connectionQuality: "excellent",
    audioTrackPublications: new Map(
      publications
        .filter((p) => p.kind === "audio")
        .map((p, index) => [`${identity}-audio-${index}`, p]),
    ),
    videoTrackPublications: new Map(
      publications
        .filter((p) => p.kind === "video")
        .map((p, index) => [`${identity}-video-${index}`, p]),
    ),
    trackPublications: new Map(
      publications.map((p, index) => [`${identity}-all-${index}`, p]),
    ),
  };
}

class FakeRoom {
  static last: FakeRoom | null = null;

  readonly remoteParticipants = new Map<string, ReturnType<typeof fakeRemoteParticipant>>();
  readonly localParticipant = {
    identity: "me",
    connectionQuality: "excellent",
    publishTrack: vi.fn(async () => ({})),
    unpublishTrack: vi.fn(async () => undefined),
  };
  readonly handlers = new Map<string, Set<(...args: never[]) => void>>();

  async connect(): Promise<void> {
    FakeRoom.last = this;
    await makeGate().promise;
  }
  async switchActiveDevice(): Promise<boolean> {
    return true;
  }
  async disconnect(): Promise<void> {
    // Room-level state is irrelevant to these tests; teardown just needs it.
  }
  on(event: string, cb: (...args: never[]) => void): void {
    let set = this.handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(cb);
  }
  off(event: string, cb: (...args: never[]) => void): void {
    this.handlers.get(event)?.delete(cb);
  }
}

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  VideoPreset: class {
    constructor(
      public width: number,
      public height: number,
      public maxBitrate: number,
      public maxFps: number,
    ) {}
  },
  ScreenSharePresets: {
    h720fps30: { resolution: {}, encoding: {} },
    h1080fps30: { resolution: {}, encoding: {} },
    original: { resolution: {}, encoding: {} },
  },
  RoomEvent: {
    ConnectionStateChanged: "ConnectionStateChanged",
    ActiveSpeakersChanged: "ActiveSpeakersChanged",
    ParticipantConnected: "ParticipantConnected",
    ParticipantDisconnected: "ParticipantDisconnected",
    TrackSubscribed: "TrackSubscribed",
    TrackUnsubscribed: "TrackUnsubscribed",
    TrackMuted: "TrackMuted",
    AudioPlaybackStatusChanged: "AudioPlaybackStatusChanged",
  },
  Track: {
    Kind: { Audio: "audio", Video: "video" },
    Source: {
      Microphone: "microphone",
      ScreenShare: "screen_share",
      ScreenShareAudio: "screen_share_audio",
    },
  },
  ConnectionState: {
    Connected: "connected",
    Reconnecting: "reconnecting",
    SignalReconnecting: "signal_reconnecting",
    Disconnected: "disconnected",
  },
}));

vi.mock("../src/api/resources.js", () => ({
  requestVoiceToken: vi.fn(async (channelId: string) => ({
    url: "wss://fake/livekit",
    token: `token-${channelId}`,
  })),
}));

vi.mock("../src/ws/socket.js", () => ({ sendVoiceFlags: vi.fn() }));

vi.mock("../src/voice/chain.js", () => ({
  buildMicChain: vi.fn(async () => ({
    track: fakeTrack(),
    cleanup: vi.fn(),
    setVolume: vi.fn(),
  })),
}));

vi.mock("../src/voice/remoteAudio.js", () => ({
  attachRemoteAudio: vi.fn(),
  clearRemoteAudio: vi.fn(),
  detachRemoteAudio: vi.fn(),
  detachRemoteAudioFor: vi.fn(),
  setRemoteAudioVolume: vi.fn(),
}));

vi.mock("../src/voice/sounds.js", () => ({
  voiceSounds: {
    join: vi.fn(),
    leave: vi.fn(),
    mute: vi.fn(),
    unmute: vi.fn(),
    deafen: vi.fn(),
    undeafen: vi.fn(),
  },
}));

import { joinVoiceChannel, leaveVoiceChannel, setSelfDeafened } from "../src/voice/room.js";

const CHANNEL_A = "11111111-1111-1111-8111-111111111111";
const CHANNEL_B = "22222222-2222-2222-8222-222222222222";
const SHARER = "33333333-3333-3333-8333-333333333333";

beforeEach(() => {
  FakeRoom.last = null;
  gates.length = 0;
  useVoiceConnection.getState().reset();
  useVoiceConnection.setState({ selfMuted: false, selfDeafened: false });
});

afterEach(async () => {
  await leaveVoiceChannel();
});

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("voice channel switching", () => {
  it("lands in the channel clicked LAST, even when a join is already in flight", async () => {
    // Regression: joinVoiceChannel returned early while status === "connecting",
    // so clicking channel B mid-join was silently dropped and the user ended
    // up in channel A.
    const joinA = joinVoiceChannel(CHANNEL_A);
    await waitFor(() => useVoiceConnection.getState().status === "connecting");
    expect(useVoiceConnection.getState().channelId).toBe(CHANNEL_A);

    const joinB = joinVoiceChannel(CHANNEL_B);
    // Both joins must be parked inside FakeRoom.connect() before releasing,
    // otherwise a release ahead of the second connect deadlocks it.
    await waitFor(() => gates.length === 2);
    await releaseGates();
    await joinA;
    await joinB;

    expect(useVoiceConnection.getState().channelId).toBe(CHANNEL_B);
    expect(useVoiceConnection.getState().status).toBe("connected");
  });

  it("collapses a duplicate click on the channel already being joined", async () => {
    const first = joinVoiceChannel(CHANNEL_A);
    await waitFor(() => useVoiceConnection.getState().status === "connecting");
    const second = joinVoiceChannel(CHANNEL_A);
    await waitFor(() => FakeRoom.last !== null);
    await releaseGates();
    await first;
    await second;

    expect(useVoiceConnection.getState().channelId).toBe(CHANNEL_A);
    expect(useVoiceConnection.getState().status).toBe("connected");
  });

  it("leaves cleanly and returns to idle", async () => {
    const join = joinVoiceChannel(CHANNEL_A);
    await waitFor(() => FakeRoom.last !== null);
    await releaseGates();
    await join;
    expect(useVoiceConnection.getState().status).toBe("connected");

    await leaveVoiceChannel();

    expect(useVoiceConnection.getState().status).toBe("idle");
    expect(useVoiceConnection.getState().channelId).toBeNull();
  });
});

describe("deafen subscriptions", () => {
  it("never subscribes to a non-watched sharer's screen-share audio", async () => {
    const mic = fakePublication("microphone", "audio");
    const screenAudio = fakePublication("screen_share_audio", "audio");
    const screenVideo = fakePublication("screen_share", "video");

    const join = joinVoiceChannel(CHANNEL_A);
    // The room exists before connect() resolves; seed its participants so the
    // join's subscription pass sees them.
    await waitFor(() => FakeRoom.last !== null);
    FakeRoom.last?.remoteParticipants.set(
      SHARER,
      fakeRemoteParticipant(SHARER, [mic, screenAudio, screenVideo]),
    );
    await releaseGates();
    await join;

    // Microphone audio is subscribed (that IS the call); screen-share audio
    // stays opt-in, so a sharer the user is not watching costs no bandwidth.
    expect(mic.subscribedCalls).toContain(true);
    expect(screenAudio.subscribedCalls).toEqual([]);
    expect(screenVideo.subscribedCalls).toEqual([]);

    // Deafen unsubscribes the mic; undeafen restores it and STILL leaves the
    // screen audio alone (undeafen used to re-subscribe every sharer's screen
    // audio until the next TrackSubscribed event unsubscribed it again).
    await setSelfDeafened(true);
    expect(mic.subscribedCalls).toContain(false);
    await setSelfDeafened(false);
    expect(mic.subscribedCalls.slice(-1)).toEqual([true]);
    expect(screenAudio.subscribedCalls).toEqual([]);
  });
});
