import { beforeEach, describe, expect, it } from "vitest";
import { TrackSource } from "livekit-server-sdk";
import { diffVoicePresence, voiceStore } from "../../src/modules/voice/store.js";
import { voiceGrantsFor } from "../../src/modules/voice/service.js";
import type { Db } from "../../src/db/client.js";
import { setMyVoiceFlags } from "../../src/modules/voice/service.js";

beforeEach(() => {
  voiceStore.reset();
});

describe("voice store", () => {
  it("joins, dedupes and leaves idempotently", () => {
    expect(voiceStore.join("chan-a", "user-1")).toEqual({ evictedFrom: null });
    // Duplicate join (webhook retry) is a no-op refresh.
    expect(voiceStore.join("chan-a", "user-1")).toEqual({ evictedFrom: null });
    expect(voiceStore.count("chan-a")).toBe(1);
    expect(voiceStore.remove("user-1")).toEqual({ channelId: "chan-a" });
    expect(voiceStore.remove("user-1")).toBeNull();
    expect(voiceStore.count("chan-a")).toBe(0);
  });

  it("evicts the previous channel (one session per user)", () => {
    voiceStore.join("chan-a", "user-1");
    const result = voiceStore.join("chan-b", "user-1");
    expect(result).toEqual({ evictedFrom: "chan-a" });
    expect(voiceStore.userChannelOf("user-1")).toBe("chan-b");
    expect(voiceStore.count("chan-a")).toBe(0);
  });

  it("enforces server-mute on flag updates", () => {
    voiceStore.join("chan-a", "user-1");
    voiceStore.setFlags("user-1", { serverMuted: true, muted: true });
    // A client unmute while server-muted stays muted.
    const seat = voiceStore.setFlags("user-1", { muted: false });
    expect(seat?.muted).toBe(true);
    expect(seat?.serverMuted).toBe(true);
    // Admin unmute clears the lock; the client can unmute after.
    voiceStore.setFlags("user-1", { serverMuted: false });
    expect(voiceStore.setFlags("user-1", { muted: false })?.muted).toBe(false);
  });

  it("clears whole channels", () => {
    voiceStore.join("chan-a", "user-1");
    voiceStore.join("chan-a", "user-2");
    expect(voiceStore.clearChannel("chan-a").sort()).toEqual(["user-1", "user-2"]);
    expect(voiceStore.userChannelOf("user-1")).toBeNull();
    expect(voiceStore.clearChannel("chan-a")).toEqual([]);
  });
});

describe("diffVoicePresence", () => {
  it("splits ghosts from missing participants", () => {
    expect(diffVoicePresence(["a", "b"], ["b", "c"])).toEqual({
      ghosts: ["c"],
      missing: ["a"],
    });
    expect(diffVoicePresence([], [])).toEqual({ ghosts: [], missing: [] });
  });
});

describe("voiceGrantsFor", () => {
  it("grants microphone publishing to speakers", () => {
    const grant = voiceGrantsFor({ speak: true, shareScreen: false });
    expect(grant.roomJoin).toBe(true);
    expect(grant.canSubscribe).toBe(true);
    expect(grant.canPublishData).toBe(false);
    expect(grant.canPublishSources).toEqual([TrackSource.MICROPHONE]);
  });

  it("grants screen-share sources only with share_screen", () => {
    const grant = voiceGrantsFor({ speak: true, shareScreen: true });
    expect(grant.canPublishSources).toEqual([
      TrackSource.MICROPHONE,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO,
    ]);
  });

  it("grants listen-only access without speak", () => {
    const grant = voiceGrantsFor({ speak: false, shareScreen: false });
    expect(grant).toMatchObject({
      roomJoin: true,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
    });
    expect(grant.canPublishSources).toBeUndefined();
  });

  it("never grants screen sources without speak", () => {
    const grant = voiceGrantsFor({ speak: false, shareScreen: true });
    expect(grant.canPublishSources).toBeUndefined();
    expect(grant.canPublish).toBe(false);
  });
});

describe("setMyVoiceFlags", () => {
  it("rejects users who are not participants (no DB touched)", async () => {
    const db = {} as unknown as Db;
    await expect(
      setMyVoiceFlags(db, "ghost", "chan-a", { muted: true, deafened: false }),
    ).resolves.toBe(false);
  });
});
