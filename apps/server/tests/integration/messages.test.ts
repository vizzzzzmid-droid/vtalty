import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { serverStateSchema, wsServerEventSchema } from "@vitality/shared";
import {
  authHeader,
  describeIf,
  registerUser,
  resetDatabase,
  setup,
  teardown,
  type TestContext,
  type TestUser,
} from "./helpers.js";

async function serverIdOf(ctx: TestContext, user: TestUser): Promise<string> {
  const res = await ctx.app.inject({
    method: "GET",
    url: "/api/v1/servers",
    headers: authHeader(user),
  });
  const servers = res.json() as { id: string }[];
  const id = servers[0]?.id;
  if (id === undefined) {
    throw new Error("user has no server");
  }
  return id;
}

async function inviteCode(
  ctx: TestContext,
  owner: TestUser,
  serverId: string,
): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/servers/${serverId}/invites`,
    headers: authHeader(owner),
    payload: {},
  });
  return (res.json() as { code: string }).code;
}

async function textChannelId(ctx: TestContext, user: TestUser, serverId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/servers/${serverId}/state`,
    headers: authHeader(user),
  });
  const state = serverStateSchema.parse(await res.json());
  const channel = state.channels.find((entry) => entry.name === "general");
  if (channel === undefined) {
    throw new Error("seed channel missing");
  }
  return channel.id;
}

async function send(
  ctx: TestContext,
  user: TestUser,
  channelId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const res = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/messages`,
    headers: authHeader(user),
    payload: body,
  });
  return { status: res.statusCode, json: res.json() };
}

describeIf("messages", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setup();
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
  });
  afterAll(async () => {
    await teardown(ctx);
  });

  it("sends and pages history (tail, before, after, around)", async () => {
    const owner = await registerUser(ctx, "owner");
    const channelId = await textChannelId(ctx, owner, await serverIdOf(ctx, owner));
    for (const content of ["one", "two", "three", "four", "five"]) {
      const res = await send(ctx, owner, channelId, { content });
      expect(res.status).toBe(201);
    }

    const tail = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages?limit=2`,
      headers: authHeader(owner),
    });
    const tailBody = tail.json() as {
      messages: { content: string; id: string }[];
      hasMoreBefore: boolean;
      hasMoreAfter: boolean;
    };
    expect(tailBody.messages.map((entry) => entry.content)).toEqual(["four", "five"]);
    expect(tailBody.hasMoreBefore).toBe(true);
    expect(tailBody.hasMoreAfter).toBe(false);

    const oldestOnTail = tailBody.messages[0]?.id ?? "";
    const page2 = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/channels/${channelId}/messages?limit=2&before=${oldestOnTail}`,
        headers: authHeader(owner),
      })
    ).json()) as typeof tailBody;
    expect(page2.messages.map((entry) => entry.content)).toEqual(["two", "three"]);
    expect(page2.hasMoreBefore).toBe(true);

    const page3 = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/channels/${channelId}/messages?limit=2&before=${page2.messages[0]?.id}`,
        headers: authHeader(owner),
      })
    ).json()) as typeof tailBody;
    expect(page3.messages.map((entry) => entry.content)).toEqual(["one"]);
    expect(page3.hasMoreBefore).toBe(false);

    const afterFirst = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/channels/${channelId}/messages?after=${page3.messages[0]?.id}`,
        headers: authHeader(owner),
      })
    ).json()) as typeof tailBody;
    expect(afterFirst.messages).toHaveLength(4);

    const middleId = page2.messages[1]?.id ?? "";
    const around = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/channels/${channelId}/messages?limit=4&around=${middleId}`,
        headers: authHeader(owner),
      })
    ).json()) as typeof tailBody;
    expect(around.messages.map((entry) => entry.content)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);

    // Boundary: around the first message yields just the anchor + newer.
    const firstId = page3.messages[0]?.id ?? "";
    const aroundFirst = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/channels/${channelId}/messages?limit=4&around=${firstId}`,
        headers: authHeader(owner),
      })
    ).json()) as typeof tailBody;
    expect(aroundFirst.messages.map((entry) => entry.content)).toEqual([
      "one",
      "two",
    ]);
    expect(aroundFirst.hasMoreBefore).toBe(false);
    expect(aroundFirst.hasMoreAfter).toBe(true);

    // Boundary: around the last message with limit=1 yields the anchor.
    const lastId = tailBody.messages[tailBody.messages.length - 1]?.id ?? "";
    const aroundLast = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/channels/${channelId}/messages?limit=1&around=${lastId}`,
        headers: authHeader(owner),
      })
    ).json()) as typeof tailBody;
    expect(aroundLast.messages.map((entry) => entry.content)).toEqual(["five"]);
    expect(aroundLast.hasMoreBefore).toBe(true);
    expect(aroundLast.hasMoreAfter).toBe(false);
  });

  it("validates content, channel type and permissions", async () => {
    const owner = await registerUser(ctx, "owner");
    const serverId = await serverIdOf(ctx, owner);
    const channelId = await textChannelId(ctx, owner, serverId);
    const friend = await registerUser(ctx, "friend", await inviteCode(ctx, owner, serverId));

    expect((await send(ctx, owner, channelId, { content: "   " })).status).toBe(400);
    expect((await send(ctx, owner, channelId, { content: "x".repeat(4001) })).status).toBe(400);

    const state = serverStateSchema.parse(
      await (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/servers/${serverId}/state`,
          headers: authHeader(owner),
        })
      ).json(),
    );
    const voiceId = state.channels.find((entry) => entry.type === "voice")?.id ?? "";
    expect((await send(ctx, owner, voiceId, { content: "hi" })).status).toBe(400);

    // Revoke send_messages from the member role: friend can read, not send.
    const memberRole = state.roles.find((role) => role.name === "member");
    const revoke = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/servers/${serverId}/roles/${memberRole?.id}`,
      headers: authHeader(owner),
      payload: { flags: { send_messages: false } },
    });
    expect(revoke.statusCode).toBe(200);
    expect((await send(ctx, friend, channelId, { content: "hi" })).status).toBe(403);
    const history = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: authHeader(friend),
    });
    expect(history.statusCode).toBe(200);
  });

  it("edits own messages and lets admins delete any", async () => {
    const owner = await registerUser(ctx, "owner");
    const serverId = await serverIdOf(ctx, owner);
    const channelId = await textChannelId(ctx, owner, serverId);
    const friend = await registerUser(ctx, "friend", await inviteCode(ctx, owner, serverId));

    const created = (await send(ctx, friend, channelId, { content: "oops" })).json as {
      id: string;
    };
    const forbidden = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/messages/${created.id}`,
      headers: authHeader(owner),
      payload: { content: "hijack" },
    });
    expect(forbidden.statusCode).toBe(403);

    const edited = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/messages/${created.id}`,
      headers: authHeader(friend),
      payload: { content: "fixed" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ content: "fixed" });
    if ((edited.json() as { editedAt: unknown }).editedAt === null) {
      throw new Error("editedAt was not set");
    }

    const memberDeletesOwn = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${created.id}`,
      headers: authHeader(friend),
    });
    expect(memberDeletesOwn.statusCode).toBe(204);

    const again = (await send(ctx, friend, channelId, { content: "again" })).json as {
      id: string;
    };
    const otherDeletes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${again.id}`,
      headers: authHeader(friend),
    });
    expect(otherDeletes.statusCode).toBe(204);

    const victims = (await send(ctx, friend, channelId, { content: "victim" })).json as {
      id: string;
    };
    const peer = await registerUser(ctx, "peer", await inviteCode(ctx, owner, serverId));
    const peerDeletes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${victims.id}`,
      headers: authHeader(peer),
    });
    expect(peerDeletes.statusCode).toBe(403);
    const adminDeletes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${victims.id}`,
      headers: authHeader(owner),
    });
    expect(adminDeletes.statusCode).toBe(204);

    const history = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/channels/${channelId}/messages`,
        headers: authHeader(owner),
      })
    ).json()) as { messages: unknown[] };
    expect(history.messages).toHaveLength(0);
  });

  it("tracks mentions, read states and unread counters", async () => {
    const owner = await registerUser(ctx, "owner");
    const serverId = await serverIdOf(ctx, owner);
    const channelId = await textChannelId(ctx, owner, serverId);
    const friend = await registerUser(ctx, "friend", await inviteCode(ctx, owner, serverId));

    const withMention = (await send(ctx, owner, channelId, {
      content: "hey @friend, look",
    })).json as { id: string; mentions: string[] };
    expect(withMention.mentions).toEqual([friend.id]);
    const plain = (await send(ctx, owner, channelId, { content: "general update" })).json as {
      id: string;
    };

    const unreadRes = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/servers/${serverId}/unread`,
      headers: authHeader(friend),
    });
    const unread = unreadRes.json() as {
      channelId: string;
      unreadCount: number;
      mentionCount: number;
    }[];
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({
      channelId,
      unreadCount: 2,
      mentionCount: 1,
    });

    const mark = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/read`,
      headers: authHeader(friend),
      payload: { lastReadMessageId: plain.id },
    });
    expect(mark.statusCode).toBe(204);

    const after = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/servers/${serverId}/unread`,
        headers: authHeader(friend),
      })
    ).json()) as typeof unread;
    expect(after[0]).toMatchObject({ unreadCount: 0, mentionCount: 0 });

    // The cursor only moves forward: re-marking an older message is a no-op.
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/read`,
      headers: authHeader(friend),
      payload: { lastReadMessageId: withMention.id },
    });
    const still = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/servers/${serverId}/unread`,
        headers: authHeader(friend),
      })
    ).json()) as typeof unread;
    expect(still[0]).toMatchObject({ unreadCount: 0 });
  });

  it("fans out only to members of the right server", async () => {
    const ownerA = await registerUser(ctx, "ownerA");
    const serverA = await serverIdOf(ctx, ownerA);
    const channelA = await textChannelId(ctx, ownerA, serverA);
    const codeA = await inviteCode(ctx, ownerA, serverA);
    const memberA = await registerUser(ctx, "memberA", codeA);

    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/servers",
      headers: authHeader(ownerA),
      payload: { name: "second" },
    });
    const serverB = (second.json() as { id: string }).id;
    const codeB = await inviteCode(ctx, ownerA, serverB);
    const memberB = await registerUser(ctx, "memberB", codeB);

    const ticketFor = async (user: TestUser): Promise<string> => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/ws-ticket",
        headers: authHeader(user),
      });
      return (res.json() as { ticket: string }).ticket;
    };
    const socketA = await ctx.app.injectWS(
      `/ws?ticket=${encodeURIComponent(await ticketFor(memberA))}`,
    );
    const socketB = await ctx.app.injectWS(
      `/ws?ticket=${encodeURIComponent(await ticketFor(memberB))}`,
    );
    try {
      const seenB: string[] = [];
      socketB.on("message", (data: WebSocket.RawData) => {
        try {
          const parsed = wsServerEventSchema.safeParse(
            JSON.parse(data.toString()) as unknown,
          );
          if (parsed.success && parsed.data.type === "message.create") {
            seenB.push(parsed.data.type);
          }
        } catch {
          // Ignore malformed frames in the collector.
        }
      });
      const created = await send(ctx, ownerA, channelA, { content: "hello A" });
      expect(created.status).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(seenB).toHaveLength(0);
    } finally {
      socketA.close();
      socketB.close();
    }
  });
});
