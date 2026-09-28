import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { serverStateSchema, wsServerEventSchema } from "@vitality/shared";
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

function joinBody(room: string, identity: string): string {
  return JSON.stringify({
    event: "participant_joined",
    room: { name: room },
    participant: { identity, sid: "PA_test" },
    id: `EV_join_${identity}`,
    createdAt: "123",
  });
}

async function participantsOf(
  ctx: TestContext,
  viewer: TestUser,
  serverId: string,
  voiceId: string,
): Promise<{ userId: string; muted: boolean; serverMuted: boolean }[]> {
  const res = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/servers/${serverId}/state`,
    headers: authHeader(viewer),
  });
  const voice = serverStateSchema.parse(await res.json()).voice;
  return voice.find((entry) => entry.channelId === voiceId)?.participants ?? [];
}

describeIf("voice moderation", () => {
  let ctx: TestContext;
  let fake: FakeLiveKitAdmin;
  beforeAll(async () => {
    fake = new FakeLiveKitAdmin();
    ctx = await setup({ livekit: fake });
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
    voiceStore.reset();
    fake.rooms.clear();
    fake.removed.length = 0;
    fake.muted.length = 0;
    fake.failList = false;
    fake.failRemove = false;
    fake.failMute = false;
  });
  afterAll(async () => {
    await teardown(ctx);
  });

  it("server-mutes through LiveKit and locks the mic", async () => {
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    fake.join(voiceId, friend.id, "aud-1");
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(joinBody(voiceId, friend.id)),
      payload: joinBody(voiceId, friend.id),
    });

    const mute = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice/mute`,
      headers: authHeader(owner),
      payload: { userId: friend.id, muted: true },
    });
    expect(mute.statusCode).toBe(204);
    expect(fake.muted).toContainEqual({
      room: voiceId,
      identity: friend.id,
      trackSid: "aud-1",
      muted: true,
    });
    let seats = await participantsOf(ctx, owner, serverId, voiceId);
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({ muted: true, serverMuted: true });

    // The victim's own unmute intent is held muted by the server lock.
    const ticket = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/ws-ticket",
      headers: authHeader(friend),
    });
    const ws = await ctx.app.injectWS(
      `/ws?ticket=${encodeURIComponent((ticket.json() as { ticket: string }).ticket)}`,
    );
    try {
      ws.send(JSON.stringify({ type: "voice.state.update", channelId: voiceId, muted: false, deafened: false }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      seats = await participantsOf(ctx, owner, serverId, voiceId);
      expect(seats[0]).toMatchObject({ muted: true, serverMuted: true });
    } finally {
      ws.close();
    }

    const unmute = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice/mute`,
      headers: authHeader(owner),
      payload: { userId: friend.id, muted: false },
    });
    expect(unmute.statusCode).toBe(204);
    seats = await participantsOf(ctx, owner, serverId, voiceId);
    expect(seats[0]).toMatchObject({ serverMuted: false });
    expect(fake.muted).toContainEqual({
      room: voiceId,
      identity: friend.id,
      trackSid: "aud-1",
      muted: false,
    });
  });

  it("lifting a server mute restores an unmuted participant", async () => {
    // Regression: the mute wrote `muted: true` alongside `serverMuted: true`
    // and the unmute only cleared `serverMuted`, so the participant stayed
    // advertised as muted вЂ” while their track was live at the SFU and
    // nothing on their side ever changed to make them re-announce.
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    fake.join(voiceId, friend.id, "aud-1");
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(joinBody(voiceId, friend.id)),
      payload: joinBody(voiceId, friend.id),
    });

    const mute = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice/mute`,
      headers: authHeader(owner),
      payload: { userId: friend.id, muted: true },
    });
    expect(mute.statusCode).toBe(204);
    let seats = await participantsOf(ctx, owner, serverId, voiceId);
    expect(seats[0]).toMatchObject({ muted: true, serverMuted: true });

    const unmute = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice/mute`,
      headers: authHeader(owner),
      payload: { userId: friend.id, muted: false },
    });
    expect(unmute.statusCode).toBe(204);
    seats = await participantsOf(ctx, owner, serverId, voiceId);
    expect(seats[0]).toMatchObject({ muted: false, serverMuted: false });
  });

  it("keeps a self-muted participant muted through a server-mute cycle", async () => {
    // The participant muted themselves first. The server lock must not
    // fabricate an unmute when it lifts, and must still read as muted
    // while it holds.
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    fake.join(voiceId, friend.id, "aud-1");
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(joinBody(voiceId, friend.id)),
      payload: joinBody(voiceId, friend.id),
    });

    const ticket = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/ws-ticket",
      headers: authHeader(friend),
    });
    const ws = await ctx.app.injectWS(
      `/ws?ticket=${encodeURIComponent((ticket.json() as { ticket: string }).ticket)}`,
    );
    try {
      // The socket must finish the ticket handshake before any intent is
      // processed, otherwise the frame arrives with no listener attached.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no ready")), 5000);
        ws.on("message", (data: WebSocket.RawData) => {
          try {
            const parsed = wsServerEventSchema.safeParse(
              JSON.parse(data.toString()) as unknown,
            );
            if (parsed.success && parsed.data.type === "server.ready") {
              clearTimeout(timer);
              resolve();
            }
          } catch {
            // Ignore malformed frames.
          }
        });
      });
      ws.send(
        JSON.stringify({
          type: "voice.state.update",
          channelId: voiceId,
          muted: true,
          deafened: false,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(
        (await participantsOf(ctx, owner, serverId, voiceId))[0],
      ).toMatchObject({ muted: true });

      await ctx.app.inject({
        method: "POST",
        url: `/api/v1/channels/${voiceId}/voice/mute`,
        headers: authHeader(owner),
        payload: { userId: friend.id, muted: true },
      });
      expect(
        (await participantsOf(ctx, owner, serverId, voiceId))[0],
      ).toMatchObject({ muted: true, serverMuted: true });

      await ctx.app.inject({
        method: "POST",
        url: `/api/v1/channels/${voiceId}/voice/mute`,
        headers: authHeader(owner),
        payload: { userId: friend.id, muted: false },
      });
      // Still muted: their own flag, not the lifted lock.
      expect(
        (await participantsOf(ctx, owner, serverId, voiceId))[0],
      ).toMatchObject({ muted: true, serverMuted: false });
    } finally {
      ws.close();
    }
  });

  it("checks moderation permissions and surfaces LiveKit failures", async () => {
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    const peer = await joinViaInvite(ctx, owner, serverId, "peer");
    fake.join(voiceId, friend.id, "aud-1");
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(joinBody(voiceId, friend.id)),
      payload: joinBody(voiceId, friend.id),
    });

    const byMember = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice/mute`,
      headers: authHeader(peer),
      payload: { userId: friend.id, muted: true },
    });
    expect(byMember.statusCode).toBe(403);

    const ghost = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice/mute`,
      headers: authHeader(owner),
      payload: { userId: peer.id, muted: true },
    });
    expect(ghost.statusCode).toBe(404);

    fake.failMute = true;
    const failed = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice/mute`,
      headers: authHeader(owner),
      payload: { userId: friend.id, muted: true },
    });
    expect(failed.statusCode).toBe(502);
    fake.failMute = false;

    const peerDisconnect = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${voiceId}/voice/participants/${friend.id}`,
      headers: authHeader(peer),
    });
    expect(peerDisconnect.statusCode).toBe(403);
  });

  it("disconnects participants and drops voice on kick", async () => {
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    fake.join(voiceId, friend.id, "aud-1");
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(joinBody(voiceId, friend.id)),
      payload: joinBody(voiceId, friend.id),
    });

    const drop = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${voiceId}/voice/participants/${friend.id}`,
      headers: authHeader(owner),
    });
    expect(drop.statusCode).toBe(204);
    expect(fake.removed).toContainEqual({ room: voiceId, identity: friend.id });
    expect(await participantsOf(ctx, owner, serverId, voiceId)).toHaveLength(0);

    // Rejoin, then kick from the server: voice must follow.
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(joinBody(voiceId, friend.id)),
      payload: joinBody(voiceId, friend.id),
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
    expect(fake.removed).toContainEqual({ room: voiceId, identity: friend.id });
    expect(await participantsOf(ctx, owner, serverId, voiceId)).toHaveLength(0);
  });

  it("empties voice when the channel is deleted", async () => {
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    fake.join(voiceId, friend.id, "aud-1");
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(joinBody(voiceId, friend.id)),
      payload: joinBody(voiceId, friend.id),
    });

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${voiceId}`,
      headers: authHeader(owner),
    });
    expect(del.statusCode).toBe(204);
    expect(fake.removed).toContainEqual({ room: voiceId, identity: friend.id });
  });
  it("never fans voice events out to other servers", async () => {
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/servers",
      headers: authHeader(owner),
      payload: { name: "second" },
    });
    const serverB = (second.json() as { id: string }).id;
    const inviteB = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverB}/invites`,
      headers: authHeader(owner),
      payload: {},
    });
    const outsider = await registerUser(
      ctx,
      "outsider",
      (inviteB.json() as { code: string }).code,
    );

    const ticket = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/ws-ticket",
      headers: authHeader(outsider),
    });
    const ws = await ctx.app.injectWS(
      `/ws?ticket=${encodeURIComponent((ticket.json() as { ticket: string }).ticket)}`,
    );
    try {
      const seen: string[] = [];
      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const parsed = wsServerEventSchema.safeParse(
            JSON.parse(data.toString()) as unknown,
          );
          if (parsed.success && parsed.data.type === "voice.state") {
            seen.push(parsed.data.type);
          }
        } catch {
          // Ignore malformed frames.
        }
      });
      await ctx.app.inject({
        method: "POST",
        url: "/webhooks/livekit",
        headers: webhookHeaders(joinBody(voiceId, friend.id)),
        payload: joinBody(voiceId, friend.id),
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(seen).toHaveLength(0);
    } finally {
      ws.close();
    }
  });

  it("ignores a stale screen-share unpublish from the previous channel", async () => {
    // Regression: the track_unpublished handler called the unscoped
    // setFlags, so an unpublish event arriving for the channel a
    // participant just left silently cleared the LIVE share in the
    // channel they moved to (the event is not a session-bound signal the
    // way participant_left is: the sharer did stop sharing in the old
    // room, but the store has no sid to compare against).
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/channels`,
      headers: authHeader(owner),
      payload: { name: "second", type: "voice" },
    });
    const secondId = (second.json() as { id: string }).id;

    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(joinBody(voiceId, friend.id)),
      payload: joinBody(voiceId, friend.id),
    });
    const screenShareBody = JSON.stringify({
      event: "track_published",
      room: { name: voiceId },
      participant: { identity: friend.id, sid: "PA_test" },
      track: { sid: "TR_screen", source: 3 },
      id: `EV_share_${friend.id}`,
      createdAt: "123",
    });
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(screenShareBody),
      payload: screenShareBody,
    });
    expect(
      (await participantsOf(ctx, owner, serverId, voiceId))[0],
    ).toMatchObject({ sharingScreen: true });

    // Switch channels: the store seats them in the second channel, and
    // they share there too.
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${secondId}/voice-token`,
      headers: authHeader(friend),
    });
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(joinBody(secondId, friend.id)),
      payload: joinBody(secondId, friend.id),
    });
    const secondShareBody = JSON.stringify({
      event: "track_published",
      room: { name: secondId },
      participant: { identity: friend.id, sid: "PA_test" },
      track: { sid: "TR_screen2", source: 3 },
      id: `EV_share2_${friend.id}`,
      createdAt: "123",
    });
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(secondShareBody),
      payload: secondShareBody,
    });

    // The old room's unpublish lands now, after the switch.
    const unpublishBody = JSON.stringify({
      event: "track_unpublished",
      room: { name: voiceId },
      participant: { identity: friend.id, sid: "PA_test" },
      track: { sid: "TR_screen", source: 3 },
      id: `EV_unpub_${friend.id}`,
      createdAt: "123",
    });
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(unpublishBody),
      payload: unpublishBody,
    });

    // The live share in the new channel survives.
    const seats = await participantsOf(ctx, owner, serverId, secondId);
    expect(seats[0]).toMatchObject({ userId: friend.id, sharingScreen: true });
  });

  it("lifts the server mute in the channel the participant sits in now", async () => {
    // Regression (TOCTOU): moderateMute validated the seat in channel A,
    // awaited LiveKit, then called the UNSCOPED setFlags — which flips
    // flags in whatever channel the participant sits in AT THAT MOMENT. A
    // `participant_joined` webhook landing during the await (the
    // participant switched channels) let the moderator's lock for channel
    // A land on the participant's LIVE seat in channel B.
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/channels`,
      headers: authHeader(owner),
      payload: { name: "second", type: "voice" },
    });
    const secondId = (second.json() as { id: string }).id;

    // The victim is seated in channel A with a published mic.
    fake.join(voiceId, friend.id, "aud-1");
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(joinBody(voiceId, friend.id)),
      payload: joinBody(voiceId, friend.id),
    });

    // The switch lands INSIDE the mute call: the fake's listParticipants
    // (awaited by moderateMute before it writes the flag) seats the
    // participant in channel B first, the way the join webhook would.
    fake.onListParticipants = (room: string) => {
      if (room === voiceId) {
        voiceStore.join(secondId, friend.id, {
          pending: false,
          participantSid: "PA_switch",
        });
      }
    };
    try {
      const mute = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/channels/${voiceId}/voice/mute`,
        headers: authHeader(owner),
        payload: { userId: friend.id, muted: true },
      });
      expect(mute.statusCode).toBe(204);
    } finally {
      fake.onListParticipants = undefined;
    }

    // The lock must not have leaked into the channel the moderator never
    // targeted: the victim is not server-muted in B, and A (which they
    // left mid-call) carries no seat at all.
    expect(voiceStore.get(voiceId, friend.id)).toBeNull();
    const after = await participantsOf(ctx, owner, serverId, secondId);
    expect(after[0]).toMatchObject({ userId: friend.id, serverMuted: false });
  });

  it("disconnects only from the channel the moderation call named", async () => {
    // Regression (TOCTOU): moderateDisconnect validated the seat in channel
    // A, awaited removeParticipant, then called the UNSCOPED remove — which
    // drops the participant from wherever they sit at that moment. A channel
    // switch landing during the await wiped their LIVE seat in channel B
    // (presence gone, mic still flowing at the SFU).
    const { owner, serverId, voiceId } = await fixture(ctx);
    const friend = await joinViaInvite(ctx, owner, serverId, "friend");
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/channels`,
      headers: authHeader(owner),
      payload: { name: "second", type: "voice" },
    });
    const secondId = (second.json() as { id: string }).id;

    fake.join(voiceId, friend.id, "aud-1");
    await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: webhookHeaders(joinBody(voiceId, friend.id)),
      payload: joinBody(voiceId, friend.id),
    });

    // The switch lands inside the disconnect call, after the seat check.
    fake.onRemoveParticipant = (room: string) => {
      if (room === voiceId) {
        voiceStore.join(secondId, friend.id, {
          pending: false,
          participantSid: "PA_switch",
        });
      }
    };
    try {
      const drop = await ctx.app.inject({
        method: "DELETE",
        url: `/api/v1/channels/${voiceId}/voice/participants/${friend.id}`,
        headers: authHeader(owner),
      });
      expect(drop.statusCode).toBe(204);
    } finally {
      fake.onRemoveParticipant = undefined;
    }

    // The live seat in channel B survives the disconnect aimed at channel A.
    expect(voiceStore.userChannelOf(friend.id)).toBe(secondId);
    const after = await participantsOf(ctx, owner, serverId, secondId);
    expect(after[0]).toMatchObject({ userId: friend.id });
  });
});

