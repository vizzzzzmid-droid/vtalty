import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { serverStateSchema } from "@vitality/shared";
import { voiceStore } from "../../src/modules/voice/store.js";
import {
  authHeader,
  describeIf,
  FakeLiveKitAdmin,
  registerUser,
  resetDatabase,
  setup,
  teardown,
  webhookHeaders,
  type TestContext,
  type TestUser,
} from "./helpers.js";

async function fixture(ctx: TestContext): Promise<{
  owner: TestUser;
  serverId: string;
  voiceId: string;
}> {
  const owner = await registerUser(ctx, "owner");
  const serversRes = await ctx.app.inject({
    method: "GET",
    url: "/api/v1/servers",
    headers: authHeader(owner),
  });
  const serverId = (serversRes.json() as { id: string }[])[0]?.id ?? "";
  const stateRes = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/servers/${serverId}/state`,
    headers: authHeader(owner),
  });
  const voiceId =
    serverStateSchema.parse(await stateRes.json()).channels.find(
      (entry) => entry.type === "voice",
    )?.id ?? "";
  return { owner, serverId, voiceId };
}

async function joinViaInvite(
  ctx: TestContext,
  owner: TestUser,
  serverId: string,
  username: string,
): Promise<TestUser> {
  const inviteRes = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/servers/${serverId}/invites`,
    headers: authHeader(owner),
    payload: {},
  });
  return registerUser(ctx, username, (inviteRes.json() as { code: string }).code);
}

function trackBody(
  event: "track_published" | "track_unpublished",
  room: string,
  identity: string,
  source: number,
): string {
  return JSON.stringify({
    event,
    room: { name: room },
    participant: { identity, sid: "PA_test" },
    track: { sid: `TR_${identity}`, source },
    id: `EV_${event}_${identity}`,
    createdAt: "123",
  });
}

async function joinVoice(
  ctx: TestContext,
  voiceId: string,
  userId: string,
): Promise<void> {
  const body = JSON.stringify({
    event: "participant_joined",
    room: { name: voiceId },
    participant: { identity: userId, sid: "PA_test" },
    id: `EV_join_${userId}`,
    createdAt: "123",
  });
  const res = await ctx.app.inject({
    method: "POST",
    url: "/webhooks/livekit",
    headers: webhookHeaders(body),
    payload: body,
  });
  if (res.statusCode !== 200) {
    throw new Error(`webhook join failed: ${res.statusCode}`);
  }
}

async function sharingOf(
  ctx: TestContext,
  viewer: TestUser,
  serverId: string,
  voiceId: string,
): Promise<{ userId: string; sharingScreen: boolean }[]> {
  const res = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/servers/${serverId}/state`,
    headers: authHeader(viewer),
  });
  const voice = serverStateSchema.parse(await res.json()).voice;
  return voice.find((entry) => entry.channelId === voiceId)?.participants ?? [];
}

describeIf("voice screen sharing", () => {
  let ctx: TestContext;
  let fake: FakeLiveKitAdmin;
  beforeAll(async () => {
    fake = new FakeLiveKitAdmin();
    ctx = await setup({ livekit: fake, voiceMaxSharers: 3 });
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
    voiceStore.reset();
    fake.rooms.clear();
    fake.removed.length = 0;
    fake.muted.length = 0;
  });
  afterAll(async () => {
    await teardown(ctx);
  });

  it("grants screen sources only with share_screen", async () => {
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");

    const withShare = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice-token`,
      headers: authHeader(friend),
    });
    const decodedWith = jwt.decode(
      (withShare.json() as { token: string }).token,
    ) as { video?: Record<string, unknown> } | null;
    expect(decodedWith?.video?.["can_publish_sources"]).toEqual([
      "microphone",
      "screen_share",
      "screen_share_audio",
    ]);

    const stateRes = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/servers/${serverId}/state`,
      headers: authHeader(owner),
    });
    const memberRole = serverStateSchema
      .parse(await stateRes.json())
      .roles.find((role) => role.name === "member");
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/servers/${serverId}/roles/${memberRole?.id}`,
      headers: authHeader(owner),
      payload: { flags: { share_screen: false } },
    });
    const withoutShare = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice-token`,
      headers: authHeader(friend),
    });
    const decodedWithout = jwt.decode(
      (withoutShare.json() as { token: string }).token,
    ) as { video?: Record<string, unknown> } | null;
    expect(decodedWithout?.video?.["can_publish_sources"]).toEqual(["microphone"]);
  });

  it("caps simultaneous sharers and freezes excess tracks", async () => {
    const tightFake = new FakeLiveKitAdmin();
    const tight = await setup({ livekit: tightFake, voiceMaxSharers: 1 });
    try {
      const owner = await registerUser(tight, "owner");
      const serversRes = await tight.app.inject({
        method: "GET",
        url: "/api/v1/servers",
        headers: authHeader(owner),
      });
      const serverId = (serversRes.json() as { id: string }[])[0]?.id ?? "";
      const invite = async (username: string): Promise<TestUser> => {
        const inviteRes = await tight.app.inject({
          method: "POST",
          url: `/api/v1/servers/${serverId}/invites`,
          headers: authHeader(owner),
          payload: {},
        });
        return registerUser(tight, username, (inviteRes.json() as { code: string }).code);
      };
      const first = await invite("first");
      const second = await invite("second");
      const stateRes = await tight.app.inject({
        method: "GET",
        url: `/api/v1/servers/${serverId}/state`,
        headers: authHeader(owner),
      });
      const voiceId =
        serverStateSchema.parse(await stateRes.json()).channels.find(
          (entry) => entry.type === "voice",
        )?.id ?? "";
      const post = async (body: string): Promise<number> =>
        (
          await tight.app.inject({
            method: "POST",
            url: "/webhooks/livekit",
            headers: webhookHeaders(body),
            payload: body,
          })
        ).statusCode;
      const join = (userId: string): string =>
        JSON.stringify({
          event: "participant_joined",
          room: { name: voiceId },
          participant: { identity: userId, sid: "PA_test" },
          id: `EV_join_${userId}`,
          createdAt: "123",
        });
      expect(await post(join(first.id))).toBe(200);
      expect(await post(join(second.id))).toBe(200);
      expect(await post(trackBody("track_published", voiceId, first.id, 3))).toBe(200);

      tightFake.join(voiceId, second.id, "aud-2", ["TR_second"]);
      expect(await post(trackBody("track_published", voiceId, second.id, 3))).toBe(200);
      // Excess publisher is frozen server-side and never advertised.
      expect(tightFake.muted).toContainEqual({
        room: voiceId,
        identity: second.id,
        trackSid: `TR_${second.id}`,
        muted: true,
      });
      const seats = await sharingOf(tight, owner, serverId, voiceId);
      expect(seats.find((entry) => entry.userId === first.id)?.sharingScreen).toBe(true);
      expect(
        seats.find((entry) => entry.userId === second.id)?.sharingScreen ?? false,
      ).toBe(false);
    } finally {
      await teardown(tight);
    }
  });

  it("stops shares via moderation and on share-screen loss", async () => {
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    const peer = await joinViaInvite(ctx, owner, serverId, "peer");
    fake.join(voiceId, friend.id, "aud-1", ["TR_friend"]);
    await joinVoice(ctx, voiceId, friend.id);
    const publish = trackBody("track_published", voiceId, friend.id, 3);
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(publish),
      payload: publish,
    });
    let seats = await sharingOf(ctx, owner, serverId, voiceId);
    expect(seats.find((entry) => entry.userId === friend.id)?.sharingScreen).toBe(true);

    const byMember = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice/stop-share`,
      headers: authHeader(peer),
      payload: { userId: friend.id },
    });
    expect(byMember.statusCode).toBe(403);

    const stop = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice/stop-share`,
      headers: authHeader(owner),
      payload: { userId: friend.id },
    });
    expect(stop.statusCode).toBe(204);
    expect(fake.muted).toContainEqual({
      room: voiceId,
      identity: friend.id,
      trackSid: "TR_friend",
      muted: true,
    });
    seats = await sharingOf(ctx, owner, serverId, voiceId);
    expect(seats.find((entry) => entry.userId === friend.id)?.sharingScreen).toBe(false);

    const again = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice/stop-share`,
      headers: authHeader(owner),
      payload: { userId: friend.id },
    });
    expect(again.statusCode).toBe(404);

    // Re-share, then lose the permission: the share is stopped, voice stays.
    const republish = trackBody("track_published", voiceId, friend.id, 3);
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(republish),
      payload: republish,
    });
    const stateRes = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/servers/${serverId}/state`,
      headers: authHeader(owner),
    });
    const memberRole = serverStateSchema
      .parse(await stateRes.json())
      .roles.find((role) => role.name === "member");
    const revoke = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/servers/${serverId}/roles/${memberRole?.id}`,
      headers: authHeader(owner),
      payload: { flags: { share_screen: false } },
    });
    expect(revoke.statusCode).toBe(200);
    seats = await sharingOf(ctx, owner, serverId, voiceId);
    expect(seats.find((entry) => entry.userId === friend.id)?.sharingScreen).toBe(false);
    // Still in voice (only the share was stopped).
    expect(seats.map((entry) => entry.userId)).toContain(friend.id);
  });

  it("clears shares when the sharer is kicked", async () => {
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    fake.join(voiceId, friend.id, "aud-1", ["TR_friend"]);
    await joinVoice(ctx, voiceId, friend.id);
    const publish = trackBody("track_published", voiceId, friend.id, 3);
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(publish),
      payload: publish,
    });

    const stateRes = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/servers/${serverId}/state`,
      headers: authHeader(owner),
    });
    const memberId = serverStateSchema
      .parse(await stateRes.json())
      .members.find((entry) => entry.userId === friend.id)?.id;
    const kick = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/members/${memberId}`,
      headers: authHeader(owner),
    });
    expect(kick.statusCode).toBe(204);
    expect(await sharingOf(ctx, owner, serverId, voiceId)).toHaveLength(0);
  });

  it("replays are safe and permission-less publishes are frozen", async () => {
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    fake.join(voiceId, friend.id, "aud-1", ["TR_friend"]);
    await joinVoice(ctx, voiceId, friend.id);
    const publish = trackBody("track_published", voiceId, friend.id, 3);
    const post = async (body: string): Promise<number> =>
      (
        await ctx.app.inject({
          method: "POST",
          url: "/webhooks/livekit",
          headers: webhookHeaders(body),
          payload: body,
        })
      ).statusCode;
    expect(await post(publish)).toBe(200);
    // Redelivery of the same publish must not freeze the live stream.
    expect(await post(publish)).toBe(200);
    expect(
      fake.muted.filter(
        (entry) => entry.identity === friend.id && entry.trackSid === "TR_friend",
      ),
    ).toHaveLength(0);
    let seats = await sharingOf(ctx, owner, serverId, voiceId);
    expect(seats.find((entry) => entry.userId === friend.id)?.sharingScreen).toBe(true);

    // Revoke share_screen: the same publish event is now frozen, not flagged.
    const stateRes = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/servers/${serverId}/state`,
      headers: authHeader(owner),
    });
    const memberRole = serverStateSchema
      .parse(await stateRes.json())
      .roles.find((role) => role.name === "member");
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/servers/${serverId}/roles/${memberRole?.id}`,
      headers: authHeader(owner),
      payload: { flags: { share_screen: false } },
    });
    // Role revocation itself stops the running share (enforce hook).
    seats = await sharingOf(ctx, owner, serverId, voiceId);
    expect(seats.find((entry) => entry.userId === friend.id)?.sharingScreen).toBe(false);
    expect(fake.muted).toContainEqual({
      room: voiceId,
      identity: friend.id,
      trackSid: "TR_friend",
      muted: true,
    });
  });
});
