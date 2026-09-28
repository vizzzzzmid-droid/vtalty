// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// The screen module resolves the LiveKit room through room.js. The room is
// faked per-test so livekit-client never loads in this suite (same pattern
// as screen-self-echo.test.tsx).
const { roomState } = vi.hoisted(() => ({
  roomState: {
    current: null as {
      localParticipant: { identity: string };
      remoteParticipants: Map<string, unknown>;
    } | null,
  },
}));

vi.mock("../src/voice/room.js", () => ({
  getRoom: () => roomState.current,
  setSuppressShareNotice: () => undefined,
}));

import { StreamTile } from "../src/components/StreamTile.js";
import { useVoiceConnection } from "../src/voice/store.js";
import { TooltipProvider } from "@radix-ui/react-tooltip";
/** A screen-share publication that records attach/detach/subscribe calls. */
function fakePublication(source: "screen_share" | "screen_share_audio") {
  const subscriptionCalls: boolean[] = [];
  const attached: HTMLMediaElement[] = [];
  const detached: HTMLMediaElement[] = [];
  let attachCount = 0;
  let detachCount = 0;
  const track = {
    attachedElements: attached,
    attach: (target?: HTMLMediaElement) => {
      const element =
        target ??
        document.createElement(source === "screen_share" ? "video" : "audio");
      // Mirrors the real Track: attach() owns srcObject and records the
      // element (re-attaching the same element is a no-op there).
      if (element.srcObject === null) {
        element.srcObject = new MediaStream();
      }
      if (!attached.includes(element)) {
        attached.push(element);
      }
      attachCount += 1;
      return element;
    },
    detach: (element?: HTMLMediaElement) => {
      if (element !== undefined) {
        element.srcObject = null;
        const index = attached.indexOf(element);
        if (index !== -1) {
          attached.splice(index, 1);
        }
        detached.push(element);
      }
      detachCount += 1;
      return attached.filter((candidate) => candidate !== element);
    },
  };
  return {
    source,
    track,
    subscriptionCalls,
    detached,
    /** Total attach() calls for the balanced-teardown assertion. */
    attachCount: () => attachCount,
    detachCount: () => detachCount,
    setSubscribed: (want: boolean): void => {
      subscriptionCalls.push(want);
    },
  };
}

function installSharingRoom(sharerIdentity: string): {
  video: ReturnType<typeof fakePublication>;
  audio: ReturnType<typeof fakePublication>;
} {
  const video = fakePublication("screen_share");
  const audio = fakePublication("screen_share_audio");
  const remote = new Map<string, unknown>();
  remote.set(sharerIdentity, {
    identity: sharerIdentity,
    connectionQuality: "excellent",
    videoTrackPublications: new Map([["video", video]]),
    audioTrackPublications: new Map([["audio", audio]]),
  });
  roomState.current = {
    localParticipant: { identity: "user-me" },
    remoteParticipants: remote,
  };
  return { video, audio };
}

const SHARER = "user-other";
let container: HTMLDivElement | null = null;
let unmountTree: (() => Promise<void>) | null = null;

afterEach(async () => {
  // Every test must unmount its React tree: a leaked root keeps its 1s
  // re-attach interval running and would attach the NEXT test's room.
  if (unmountTree !== null) {
    const unmount = unmountTree;
    unmountTree = null;
    await unmount();
  }
  if (container !== null) {
    document.body.removeChild(container);
    container = null;
  }
  roomState.current = null;
  useVoiceConnection.setState({ watching: {} });
});

async function renderTile(): Promise<() => Promise<void>> {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <TooltipProvider>
        <StreamTile
          sharerId={SHARER}
          sharerName="Other"
          sharerAvatarUrl={null}
        />
      </TooltipProvider>,
    );
  });
  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
  };
  unmountTree = unmount;
  return unmount;
}

describe("StreamTile attach teardown", () => {
  it("attaches the screen tracks while watching", async () => {
    const { video, audio } = installSharingRoom(SHARER);
    useVoiceConnection.setState({ watching: { [SHARER]: { quality: "auto" } } });
    await renderTile();

    expect(video.attachCount()).toBeGreaterThan(0);
    expect(audio.attachCount()).toBeGreaterThan(0);
    expect(video.subscriptionCalls).toContain(true);
  });

  it("detaches every track when the tile stops watching (no leaked graphs)", async () => {
    // Regression: the attach helpers RETURN teardown functions. The effect
    // used to drop them on the floor, so the LiveKit track kept references
    // to detached elements and the mono->stereo centring graph leaked its
    // nodes plus a muted keeper <audio> into document.body forever (once
    // per watch cycle and once per fullscreen toggle).
    const { video, audio } = installSharingRoom(SHARER);
    useVoiceConnection.setState({ watching: { [SHARER]: { quality: "auto" } } });
    await renderTile();

    await act(async () => {
      useVoiceConnection.setState({ watching: {} });
    });

    // Every element that was ever attached is detached again: nothing may
    // outlive the teardown.
    expect(video.track.attachedElements.length).toBe(0);
    expect(video.detachCount()).toBe(video.attachCount());
    expect(audio.track.attachedElements.length).toBe(0);
    expect(audio.detachCount()).toBe(audio.attachCount());
    // The subscription is dropped too.
    expect(video.subscriptionCalls).toContain(false);
  });

  it("detaches when the tile unmounts while watching", async () => {
    const { video, audio } = installSharingRoom(SHARER);
    useVoiceConnection.setState({ watching: { [SHARER]: { quality: "auto" } } });
    const unmount = await renderTile();

    await unmount();
    unmountTree = null;
    container = null;

    expect(video.track.attachedElements.length).toBe(0);
    expect(video.detachCount()).toBe(video.attachCount());
    expect(audio.track.attachedElements.length).toBe(0);
    expect(audio.detachCount()).toBe(audio.attachCount());
  });
});
