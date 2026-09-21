import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { serverStateSchema, wsServerEventSchema } from "@vitality/shared";
import { voiceStore } from "../../src/modules/voice/store.js";
import { reconcileVoice } from "../../src/modules/voice/service.js";
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

async function voiceFixture(ctx: TestContext): Promise<{
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
  const state = serverStateSchema.parse(await stateRes.json());
  const voiceId = state.channels.find((entry) => entry.type === "voice")?.id ?? "";
  return { owner, serverId, voiceId };
}

async function addMember(
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
  const code = (inviteRes.json() as { code: string }).code;
  return registerUser(ctx, username, code);
}

function webhookBody(
  event: string,
  room: string,
  identity: string,
  trackSource?: number,
): string {
  return JSON.stringify({
    event,
    room: { name: room },
    participant: { identity, sid: "PA_test" },
    ...(trackSource === undefined
      ? {}
      : { track: { sid: "TR_test", source: trackSource } }),
    id: `EV_${event}_${identity}`,
    createdAt: "123",
  });
}

async function postWebhook(
  ctx: TestContext,
  body: string,
  headers?: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/webhooks/livekit",
    headers: headers ?? webhookHeaders(body),
    payload: body,
  });
  return { status: res.statusCode, json: res.json() };
}

async function voiceSnapshot(
  ctx: TestContext,
  viewer: TestUser,
  serverId: string,
): Promise<{ channelId: string; participants: { userId: string; muted: boolean; deafened: boolean; sharingScreen: boolean; serverMuted: boolean }[] }[]> {
  const res = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/servers/${serverId}/state`,
    headers: authHeader(viewer),
  });
  return serverStateSchema.parse(await res.json()).voice;
}

describeIf("voice tokens and webhooks", () => {
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
  });
  afterAll(async () => {
    await teardown(ctx);
  });

  it("mints tokens with role-derived grants and short TTL", async () => {
    const { owner, voiceId } = await voiceFixture(ctx);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice-token`,
      headers: authHeader(owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; url: string; room: string };
    expect(body.url).toBe("wss://localhost/livekit");
    expect(body.room).toBe(voiceId);
    const decoded = jwt.decode(body.token) as {
      sub?: unknown;
      video?: Record<string, unknown>;
      exp?: unknown;
      iat?: unknown;
    } | null;
    expect(decoded?.sub).toBe(owner.id);
    expect(decoded?.video).toMatchObject({
      room: voiceId,
      room_join: true,
      can_subscribe: true,
      can_publish_data: false,
    });
    expect(decoded?.video?.["can_publish_sources"]).toEqual(["microphone"]);
    expect((decoded?.exp as number) - (decoded?.iat as number)).toBe(600);
  });

  it("rejects token requests without access", async () => {
    const { owner, serverId, voiceId } = await voiceFixture(ctx);
    const stateRes = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/servers/${serverId}/state`,
      headers: authHeader(owner),
    });
    const state = serverStateSchema.parse(await stateRes.json());
    const textId = state.channels.find((entry) => entry.type === "text")?.id ?? "";

    const textRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${textId}/voice-token`,
      headers: authHeader(owner),
    });
    expect(textRes.statusCode).toBe(400);

    const missing = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/channels/00000000-0000-0000-0000-000000000000/voice-token",
      headers: authHeader(owner),
    });
    expect(missing.statusCode).toBe(404);

    const anon = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice-token`,
    });
    expect(anon.statusCode).toBe(401);

    // Member without `connect` cannot mint.
    const friend = await addMember(ctx, owner, serverId, "friend");
    const memberRole = state.roles.find((role) => role.name === "member");
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/servers/${serverId}/roles/${memberRole?.id}`,
      headers: authHeader(owner),
      payload: { flags: { connect: false } },
    });
    const denied = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice-token`,
      headers: authHeader(friend),
    });
    expect(denied.statusCode).toBe(403);
  });

  it("grants listen-only tokens without speak", async () => {
    const { owner, serverId, voiceId } = await voiceFixture(ctx);
    const stateRes = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/servers/${serverId}/state`,
      headers: authHeader(owner),
    });
    const state = serverStateSchema.parse(await stateRes.json());
    const memberRole = state.roles.find((role) => role.name === "member");
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/servers/${serverId}/roles/${memberRole?.id}`,
      headers: authHeader(owner),
      payload: { flags: { speak: false } },
    });
    const friend = await addMember(ctx, owner, serverId, "listener");
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/voice-token`,
      headers: authHeader(friend),
    });
    expect(res.statusCode).toBe(200);
    const decoded = jwt.decode((res.json() as { token: string }).token) as {
      video?: Record<string, unknown>;
    } | null;
    expect(decoded?.video).toMatchObject({ can_publish: false, can_subscribe: true });
    expect(decoded?.video?.["can_publish_sources"]).toBeUndefined();
  });

  it("drives presence from webhooks, idempotently", async () => {
    const { owner, serverId, voiceId } = await voiceFixture(ctx);
    const friend = await addMember(ctx, owner, serverId, "friend");

    const join = webhookBody("participant_joined", voiceId, friend.id);
    expect((await postWebhook(ctx, join)).status).toBe(200);
    // Duplicate delivery converges to a single participant.
    expect((await postWebhook(ctx, join)).status).toBe(200);
    let voice = await voiceSnapshot(ctx, owner, serverId);
    expect(voice).toHaveLength(1);
    expect(voice[0]?.participants.map((entry) => entry.userId)).toEqual([friend.id]);

    const leave = webhookBody("participant_left", voiceId, friend.id);
    expect((await postWebhook(ctx, leave)).status).toBe(200);
    expect((await postWebhook(ctx, leave)).status).toBe(200);
    voice = await voiceSnapshot(ctx, owner, serverId);
    expect(voice).toHaveLength(0);
  });

  it("rejects forged webhooks and ignores unknown rooms", async () => {
    const { serverId } = await voiceFixture(ctx);
    const body = webhookBody("participant_joined", serverId, "someone");
    const tampered = `${body} `;
    const badSecret = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: {
        "content-type": "application/webhook+json",
        authorization: "Bearer garbage",
      },
      payload: body,
    });
    expect(badSecret.statusCode).toBe(401);
    const mismatch = await postWebhook(
      ctx,
      tampered,
      webhookHeaders(body),
    );
    expect(mismatch.status).toBe(401);

    const unknown = webhookBody("participant_joined", "no-such-room", "someone");
    const ignored = await postWebhook(ctx, unknown);
    expect(ignored.status).toBe(200);
  });

  it("tracks screen-share flags from track events", async () => {
    const { owner, serverId, voiceId } = await voiceFixture(ctx);
    const friend = await addMember(ctx, owner, serverId, "friend");
    await postWebhook(ctx, webhookBody("participant_joined", voiceId, friend.id));

    await postWebhook(ctx, webhookBody("track_published", voiceId, friend.id, 3));
    let voice = await voiceSnapshot(ctx, owner, serverId);
    expect(voice[0]?.participants[0]).toMatchObject({ sharingScreen: true });

    // Microphone tracks do not touch flags.
    await postWebhook(ctx, webhookBody("track_published", voiceId, friend.id, 2));
    voice = await voiceSnapshot(ctx, owner, serverId);
    expect(voice[0]?.participants[0]).toMatchObject({ sharingScreen: true });

    await postWebhook(ctx, webhookBody("track_unpublished", voiceId, friend.id, 3));
    voice = await voiceSnapshot(ctx, owner, serverId);
    expect(voice[0]?.participants[0]).toMatchObject({ sharingScreen: false });
  });

  it("accepts voice flags only from participants", async () => {
    const { owner, serverId, voiceId } = await voiceFixture(ctx);
    const friend = await addMember(ctx, owner, serverId, "friend");
    await postWebhook(ctx, webhookBody("participant_joined", voiceId, friend.id));

    const ticket = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/ws-ticket",
      headers: authHeader(friend),
    });
    const ws = await ctx.app.injectWS(
      `/ws?ticket=${encodeURIComponent((ticket.json() as { ticket: string }).ticket)}`,
    );
    try {
      const hello = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no ready")), 5000);
        ws.on("message", (data: WebSocket.RawData) => {
          try {
            const parsed = wsServerEventSchema.safeParse(
              JSON.parse(data.toString()) as unknown,
            );
            if (parsed.success && parsed.data.type === "server.ready") {
              clearTimeout(timer);
              resolve("ready");
            }
          } catch {
            // Ignore malformed frames.
          }
        });
      });
      expect(hello).toBe("ready");

      const ownerTicket = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/ws-ticket",
        headers: authHeader(owner),
      });
      const ownerWs = await ctx.app.injectWS(
        `/ws?ticket=${encodeURIComponent((ownerTicket.json() as { ticket: string }).ticket)}`,
      );
      try {
        const seen: string[] = [];
        ownerWs.on("message", (data: WebSocket.RawData) => {
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
        ws.send(
          JSON.stringify({
            type: "voice.state.update",
            channelId: voiceId,
            muted: true,
            deafened: false,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(seen.length).toBeGreaterThan(0);
        const voice = await voiceSnapshot(ctx, owner, serverId);
        expect(voice[0]?.participants[0]).toMatchObject({ muted: true });

        // A stranger's forged flags for this channel are ignored.
        const outsider = await addMember(ctx, owner, serverId, "outsider");
        const outsiderTicket = await ctx.app.inject({
          method: "POST",
          url: "/api/v1/ws-ticket",
          headers: authHeader(outsider),
        });
        const outsiderWs = await ctx.app.injectWS(
          `/ws?ticket=${encodeURIComponent((outsiderTicket.json() as { ticket: string }).ticket)}`,
        );
        try {
          outsiderWs.send(
            JSON.stringify({
              type: "voice.state.update",
              channelId: voiceId,
              muted: false,
              deafened: true,
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 800));
          const after = await voiceSnapshot(ctx, owner, serverId);
          expect(after[0]?.participants[0]).toMatchObject({
            muted: true,
            deafened: false,
          });
        } finally {
          outsiderWs.close();
        }
      } finally {
        ownerWs.close();
      }
    } finally {
      ws.close();
    }
  });

  it("evicts the previous channel when minting for another", async () => {
    const { owner, serverId, voiceId } = await voiceFixture(ctx);
    const friend = await addMember(ctx, owner, serverId, "friend");
    await postWebhook(ctx, webhookBody("participant_joined", voiceId, friend.id));

    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/channels`,
      headers: authHeader(owner),
      payload: { name: "second", type: "voice" },
    });
    const secondId = (second.json() as { id: string }).id;
    const mint = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${secondId}/voice-token`,
      headers: authHeader(friend),
    });
    expect(mint.statusCode).toBe(200);
    expect(fake.removed).toContainEqual({ room: voiceId, identity: friend.id });
    const voice = await voiceSnapshot(ctx, owner, serverId);
    const first = voice.find((entry) => entry.channelId === voiceId);
    expect(first?.participants ?? []).toHaveLength(0);
  });

  it("enforces max participants from env", async () => {
    const tightFake = new FakeLiveKitAdmin();
    const tight = await setup({ livekit: tightFake, voiceMaxParticipants: 1 });
    try {
      const owner = await registerUser(tight, "owner");
      const serversRes = await tight.app.inject({
        method: "GET",
        url: "/api/v1/servers",
        headers: authHeader(owner),
      });
      const serverId = (serversRes.json() as { id: string }[])[0]?.id ?? "";
      const stateRes = await tight.app.inject({
        method: "GET",
        url: `/api/v1/servers/${serverId}/state`,
        headers: authHeader(owner),
      });
      const voiceId =
        serverStateSchema.parse(await stateRes.json()).channels.find(
          (entry) => entry.type === "voice",
        )?.id ?? "";
      const inviteRes = await tight.app.inject({
        method: "POST",
        url: `/api/v1/servers/${serverId}/invites`,
        headers: authHeader(owner),
        payload: {},
      });
      const code = (inviteRes.json() as { code: string }).code;
      const first = await registerUser(tight, "first", code);
      const second = await registerUser(tight, "second", code);

      const join = webhookBody("participant_joined", voiceId, first.id);
      const hook = await tight.app.inject({
        method: "POST",
        url: "/webhooks/livekit",
        headers: webhookHeaders(join),
        payload: join,
      });
      expect(hook.statusCode).toBe(200);

      const mint = await tight.app.inject({
        method: "POST",
        url: `/api/v1/channels/${voiceId}/voice-token`,
        headers: authHeader(second),
      });
      expect(mint.statusCode).toBe(403);
      expect(mint.json()).toMatchObject({ error: { code: "CHANNEL_FULL" } });
    } finally {
      await teardown(tight);
    }
  });

  it("reconciles ghosts and resurrects live members", async () => {
    const { owner, serverId, voiceId } = await voiceFixture(ctx);
    const friend = await addMember(ctx, owner, serverId, "friend");

    // Ghost: store says joined (webhook), LiveKit knows nobody.
    await postWebhook(ctx, webhookBody("participant_joined", voiceId, friend.id));
    const healed = await reconcileVoice(ctx.db.db, fake);
    expect(healed.ghostsRemoved).toBe(1);
    expect(await voiceSnapshot(ctx, owner, serverId)).toHaveLength(0);

    // Live-but-unknown member is resurrected (membership + connect hold).
    fake.join(voiceId, friend.id, "aud-1");
    const revived = await reconcileVoice(ctx.db.db, fake);
    expect(revived.resurrected).toBe(1);
    const voice = await voiceSnapshot(ctx, owner, serverId);
    expect(voice[0]?.participants.map((entry) => entry.userId)).toEqual([friend.id]);

    // Live stranger without membership is force-dropped, not resurrected.
    fake.join(voiceId, "00000000-0000-0000-0000-000000000999", null);
    const cleaned = await reconcileVoice(ctx.db.db, fake);
    expect(cleaned.roguesDropped).toBe(1);
    expect(fake.removed).toContainEqual({
      room: voiceId,
      identity: "00000000-0000-0000-0000-000000000999",
    });
  });
});
