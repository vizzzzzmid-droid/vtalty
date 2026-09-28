import { beforeEach, describe, expect, it } from "vitest";
import { TrackSource } from "livekit-server-sdk";
import type { VoiceParticipant } from "@vitality/shared";
import {
  diffVoicePresence,
  toVoiceParticipant,
  voiceStore,
} from "../../src/modules/voice/store.js";
import { voiceGrantsFor } from "../../src/modules/voice/service.js";
import type { Db } from "../../src/db/client.js";
import { setMyVoiceFlags } from "../../src/modules/voice/service.js";

beforeEach(() => {
  voiceStore.reset();
});

/** Project a seat the way presence does (throws if the seat is gone). */
function publish(userId: string, channelId = "chan-a"): VoiceParticipant {
  const seat = voiceStore.get(channelId, userId);
  if (seat === null) {
    throw new Error(`no voice seat for ${userId}`);
  }
  return toVoiceParticipant(seat);
}

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

  it("keeps the server lock out of the participant's own mute flag", () => {
    voiceStore.join("chan-a", "user-1");
    voiceStore.setFlags("user-1", { serverMuted: true });
    // The lock never clobbers the participant's own state...
    const locked = voiceStore.get("chan-a", "user-1");
    expect(locked?.muted).toBe(false);
    expect(locked?.serverMuted).toBe(true);
    // ...but published presence still reads as muted.
    expect(publish("user-1")).toMatchObject({ muted: true, serverMuted: true });

    // A client unmute while server-muted cannot lift the published mute.
    const seat = voiceStore.setFlags("user-1", { muted: false });
    expect(seat?.muted).toBe(false);
    expect(seat?.serverMuted).toBe(true);
    expect(publish("user-1")).toMatchObject({ muted: true });

    // Admin unmute clears the lock and the participant's own state shows
    // through verbatim — they are NOT left stuck "muted" (regression: the
    // mute used to write `muted: true` alongside `serverMuted: true` and
    // the unmute never cleared it, so an unmuted, audible participant was
    // advertised muted until the next toggle or reconnect).
    voiceStore.setFlags("user-1", { serverMuted: false });
    expect(publish("user-1")).toMatchObject({ muted: false, serverMuted: false });
  });

  it("preserves a self-muted participant through a server-mute cycle", () => {
    voiceStore.join("chan-a", "user-1");
    voiceStore.setFlags("user-1", { muted: true });
    voiceStore.setFlags("user-1", { serverMuted: true });
    expect(publish("user-1")).toMatchObject({ muted: true, serverMuted: true });
    // Lifting the lock must not fabricate an unmute: the participant's own
    // flag is what their mic is actually doing.
    voiceStore.setFlags("user-1", { serverMuted: false });
    expect(publish("user-1")).toMatchObject({ muted: true, serverMuted: false });
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

describe("voice flag updates are scoped to the validated channel", () => {
  it("setFlagsInChannel ignores an update for a channel the user no longer sits in", () => {
    // Regression: setFlags mutated wherever the user currently sat, so a
    // handler/moderation path that had validated channel A could flip flags
    // in channel B if the participant switched between the validation and
    // the mutation. The same class was already fixed for participant_left
    // and setMyVoiceFlags; the track/moderation paths still used the
    // unscoped setter.
    voiceStore.join("chan-a", "user-1");
    voiceStore.join("chan-b", "user-1");
    expect(voiceStore.userChannelOf("user-1")).toBe("chan-b");

    expect(voiceStore.setFlagsInChannel("chan-a", "user-1", { muted: true })).toBeNull();
    const seat = voiceStore.get("chan-b", "user-1");
    expect(seat?.muted).toBe(false);

    // The scoped setter still applies when the channel matches.
    const updated = voiceStore.setFlagsInChannel("chan-b", "user-1", { muted: true });
    expect(updated?.muted).toBe(true);
    expect(voiceStore.get("chan-b", "user-1")?.muted).toBe(true);
  });

  it("setFlagsInChannel ignores a stale share flag for the previous channel", () => {
    voiceStore.join("chan-a", "user-1", { sharingScreen: true });
    voiceStore.join("chan-b", "user-1", { sharingScreen: true });
    expect(voiceStore.setFlagsInChannel("chan-a", "user-1", { sharingScreen: false })).toBeNull();
    // The live share in the new channel survives a stale unpublish event
    // from the old one.
    expect(voiceStore.get("chan-b", "user-1")?.sharingScreen).toBe(true);
  });

  it("getInChannel sees only the named channel", () => {
    voiceStore.join("chan-a", "user-1", { muted: true });
    voiceStore.join("chan-b", "user-1");
    // One session per user: the seat moved, so the previous channel reads
    // empty even through the scoped reader.
    expect(voiceStore.getInChannel("chan-a", "user-1")).toBeNull();
    expect(voiceStore.getInChannel("chan-b", "user-1")?.muted).toBe(false);
    expect(voiceStore.getInChannel("chan-c", "user-1")).toBeNull();
  });
});

describe("setMyVoiceFlags", () => {
  it("rejects users who are not participants (no DB touched)", async () => {
    const db = {} as unknown as Db;
    await expect(
      setMyVoiceFlags(db, "ghost", "chan-a", { muted: true, deafened: false }),
    ).resolves.toBe(false);
  });

  it("a stale/forged channelId mutates nothing in the real channel", async () => {
    // Regression: setFlags used to run BEFORE the channelId check, so a
    // wrong channelId still flipped the user's flags in whatever channel
    // they actually sat in.
    const db = {} as unknown as Db;
    voiceStore.join("chan-a", "user-1");
    voiceStore.setFlags("user-1", { muted: false, deafened: false });
    const before = voiceStore.get("chan-a", "user-1");

    await expect(
      setMyVoiceFlags(db, "user-1", "chan-b", { muted: true, deafened: true }),
    ).resolves.toBe(false);

    expect(voiceStore.get("chan-a", "user-1")).toEqual(before);
  });
});

describe("voice state invariants (deafened/serverMuted => muted)", () => {
  it("forces muted when a client deafens while unmuted", () => {
    voiceStore.join("chan-a", "user-1");
    const seat = voiceStore.setFlags("user-1", { deafened: true, muted: false });
    expect(seat?.deafened).toBe(true);
    expect(seat?.muted).toBe(true);
  });

  it("forces muted when deafen arrives without an explicit muted flag", () => {
    // A partial update (no `muted` key) must not preserve a stale unmuted.
    voiceStore.join("chan-a", "user-1");
    voiceStore.setFlags("user-1", { muted: false });
    const seat = voiceStore.setFlags("user-1", { deafened: true });
    expect(seat?.muted).toBe(true);
    expect(seat?.deafened).toBe(true);
  });

  it("lets undeafen restore a client-chosen mute state", () => {
    voiceStore.join("chan-a", "user-1");
    voiceStore.setFlags("user-1", { deafened: true, muted: true });
    const seat = voiceStore.setFlags("user-1", {
      deafened: false,
      muted: false,
    });
    expect(seat?.deafened).toBe(false);
    expect(seat?.muted).toBe(false);
  });

  it("forces muted when server-muted even without an explicit flag", () => {
    // The server lock must read as a published mute even when the
    // participant never announced a flag of their own.
    voiceStore.join("chan-a", "user-1");
    voiceStore.setFlags("user-1", { muted: false });
    voiceStore.setFlags("user-1", { serverMuted: true });
    expect(publish("user-1")).toMatchObject({ muted: true, serverMuted: true });
  });
});

describe("voice admission (capacity race)", () => {
  it("admits up to capacity and refuses the rest", () => {
    expect(voiceStore.admit("chan-a", "u1", 2)).toEqual({
      admitted: true,
      evictedFrom: null,
    });
    expect(voiceStore.admit("chan-a", "u2", 2).admitted).toBe(true);
    expect(voiceStore.admit("chan-a", "u3", 2).admitted).toBe(false);
  });

  it("a pending reservation counts toward capacity and stays out of presence", () => {
    voiceStore.admit("chan-a", "u1", 1);
    // Not joined yet: no presence entry, but the slot is taken.
    expect(voiceStore.channelParticipants("chan-a")).toEqual([]);
    expect(voiceStore.count("chan-a")).toBe(1);
    expect(voiceStore.admit("chan-a", "u2", 1).admitted).toBe(false);
    // The real join clears the reservation and publishes presence.
    voiceStore.join("chan-a", "u1", { pending: false });
    expect(
      voiceStore.channelParticipants("chan-a").map((seat) => seat.userId),
    ).toEqual(["u1"]);
  });

  it("a re-mint by the same user never double-counts", () => {
    voiceStore.admit("chan-a", "u1", 1);
    expect(voiceStore.admit("chan-a", "u1", 1).admitted).toBe(true);
    expect(voiceStore.count("chan-a")).toBe(1);
  });

  it("admitting a second channel evicts the first (one session per user)", () => {
    voiceStore.admit("chan-a", "u1", 5);
    expect(voiceStore.admit("chan-b", "u1", 5)).toEqual({
      admitted: true,
      evictedFrom: "chan-a",
    });
    expect(voiceStore.count("chan-a")).toBe(0);
    expect(voiceStore.count("chan-b")).toBe(1);
  });

  it("sweeps expired reservations so the slot frees", () => {
    const now = 1_000_000;
    voiceStore.admit("chan-a", "u1", 1, now);
    expect(voiceStore.admit("chan-a", "u2", 1).admitted).toBe(false);
    expect(voiceStore.sweepReservations(60_000, now + 120_000)).toEqual([
      "chan-a",
    ]);
    expect(voiceStore.admit("chan-a", "u2", 1).admitted).toBe(true);
  });

  it("keeps a reservation whose token is still valid", () => {
    const now = 1_000_000;
    voiceStore.admit("chan-a", "u1", 1, now);
    expect(voiceStore.sweepReservations(60_000, now + 30_000)).toEqual([]);
    expect(voiceStore.count("chan-a")).toBe(1);
  });

  it("never admits two users into a one-seat channel concurrently", async () => {
    // The store is synchronous, so this also pins the invariant the
    // per-channel lock around admit protects at the service level.
    const results = await Promise.all(
      ["u1", "u2", "u3", "u4"].map((userId) =>
        Promise.resolve(voiceStore.admit("chan-race", userId, 1)),
      ),
    );
    const admitted = results.filter((result) => result.admitted);
    expect(admitted).toHaveLength(1);
  });
});
