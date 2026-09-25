// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The screen module resolves the LiveKit room through room.js. The room is
// faked per-test below so livekit-client never loads in this suite.
const { roomState } = vi.hoisted(() => ({
  roomState: { current: null as { localParticipant: { identity: string }; remoteParticipants: Map<string, unknown> } | null },
}));

vi.mock("../src/voice/room.js", () => ({
  getRoom: () => roomState.current,
  setSuppressShareNotice: () => undefined,
}));

import {
  attachStreamAudio,
  attachStreamVideo,
  unwatchStream,
  watchStream,
} from "../src/voice/screen.js";
import { StreamTile } from "../src/components/StreamTile.js";

/** A screen-share publication that records subscription calls. */
function fakePublication(source: "screen_share" | "screen_share_audio") {
  const subscriptionCalls: boolean[] = [];
  const attached: HTMLMediaElement[] = [];
  const track = {
    attachedElements: attached,
    attach: (target?: HTMLMediaElement) => {
      const element = target ?? document.createElement(
        source === "screen_share" ? "video" : "audio",
      );
      element.srcObject = new MediaStream();
      attached.push(element);
      return element;
    },
    detach: (element?: HTMLMediaElement) => {
      if (element !== undefined) {
        element.srcObject = null;
      }
      return attached.filter((candidate) => candidate !== element);
    },
  };
  return {
    source,
    track,
    subscriptionCalls,
    setSubscribed: (want: boolean): void => {
      subscriptionCalls.push(want);
    },
  };
}

type FakeParticipant = ReturnType<typeof fakeParticipant>;

function fakeParticipant(identity: string) {
  const video = fakePublication("screen_share");
  const audio = fakePublication("screen_share_audio");
  return {
    identity,
    connectionQuality: "excellent",
    videoTrackPublications: new Map([["video", video]]),
    audioTrackPublications: new Map([["audio", audio]]),
    pubs: { video, audio },
  };
}
function selfParticipant(): FakeParticipant {
  return (roomState.current as { remoteParticipants: Map<string, unknown> }).remoteParticipants.get(
    "user-me",
  ) as unknown as FakeParticipant;
}

function otherParticipant(): FakeParticipant {
  return (roomState.current as { remoteParticipants: Map<string, unknown> }).remoteParticipants.get(
    "user-other",
  ) as unknown as FakeParticipant;
}

function installRoom(options: {
  /** Also place a participant with the LOCAL identity into remoteParticipants
   * (worst case: transient/edge state where self leaks into the remote map). */
  withSelf?: boolean;
}): void {
  const self = fakeParticipant("user-me");
  const other = fakeParticipant("user-other");
  const remote = new Map<string, FakeParticipant>();
  if (options.withSelf === true) {
    remote.set(self.identity, self);
  }
  remote.set(other.identity, other);
  roomState.current = {
    localParticipant: { identity: "user-me" },
    remoteParticipants: remote,
  };
}

describe("never watch/attach your own screen share (self-echo)", () => {
  it("does not attach own screen audio even if self is in remoteParticipants", () => {
    installRoom({ withSelf: true });
    const element = document.createElement("audio");
    const play = vi.spyOn(element, "play").mockResolvedValue(undefined);

    const cleanup = attachStreamAudio("user-me", element);

    expect(element.srcObject).toBeNull();
    expect(play).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });

  it("does not subscribe to own screen tracks (watch/unwatch are no-ops)", () => {
    installRoom({ withSelf: true });

    watchStream("user-me");
    unwatchStream("user-me");

    expect(selfParticipant().pubs.video.subscriptionCalls).toEqual([]);
    expect(selfParticipant().pubs.audio.subscriptionCalls).toEqual([]);
  });

  it("does not attach own screen video either", () => {
    installRoom({ withSelf: true });
    const video = document.createElement("video");

    attachStreamVideo("user-me", video);

    expect(video.srcObject).toBeNull();
  });

  it("still watches and attaches a REMOTE sharer (no over-blocking)", () => {
    installRoom({ withSelf: true });
    const element = document.createElement("audio");
    vi.spyOn(element, "play").mockResolvedValue(undefined);

    watchStream("user-other");
    attachStreamAudio("user-other", element);

    expect(otherParticipant().pubs.video.subscriptionCalls).toEqual([true]);
    expect(otherParticipant().pubs.audio.subscriptionCalls).toEqual([true]);
    expect(element.srcObject).toBeInstanceOf(MediaStream);
  });

  it("never registers own identity in the stream-audio volume map", () => {
    installRoom({ withSelf: true });
    const element = document.createElement("audio");
    vi.spyOn(element, "play").mockResolvedValue(undefined);

    attachStreamAudio("user-me", element);
    // Nothing playable was attached, so a later setStreamVolume("user-me")
    // has no element to act on either.
    expect(element.srcObject).toBeNull();
  });
});

describe("StreamTile own-share UI", () => {
  it("never renders a Watch control for your own share", () => {
    const html = renderToStaticMarkup(
      <StreamTile sharerId="user-me" sharerName="Me" isSelf />,
    );
    expect(html).not.toContain("Watch stream");
    expect(html).toContain("You are sharing");
  });

  it("still offers Watch for other sharers", () => {
    const html = renderToStaticMarkup(
      <StreamTile sharerId="user-other" sharerName="Ann" />,
    );
    expect(html).toContain("Watch stream");
  });
});

describe("source wiring", () => {
  it("MainView marks the local participant's own tile", () => {
    const mainViewSource = readSource("src/components/MainView.tsx");
    expect(mainViewSource).toContain("isSelf=");
    expect(mainViewSource).toContain("myUserId");
  });

  it("room.ts TrackSubscribed bails out for local participants", () => {
    const roomSource = readSource("src/voice/room.ts");
    expect(roomSource).toContain("if (participant.isLocal) {");
  });
});

function readSource(relativePath: string): string {
  // happy-dom rewrites import.meta.url to an http: URL, so resolve from the
  // package cwd (vitest runs with cwd = apps/web).
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}
