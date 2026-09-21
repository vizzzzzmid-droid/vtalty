import { sql } from "drizzle-orm";
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

interface WsEvent {
  type: string;
  data: Record<string, unknown>;
}

function nextEvent(socket: WebSocket, timeoutMs = 5000): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("timed out waiting for WS event"));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(data.toString()) as unknown;
      } catch {
        return;
      }
      const parsed = wsServerEventSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return;
      }
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve({
        type: parsed.data.type,
        data: parsed.data.data as Record<string, unknown>,
      });
    };
    socket.on("message", onMessage);
  });
}

async function waitFor(
  socket: WebSocket,
  predicate: (event: WsEvent) => boolean,
  timeoutMs = 5000,
): Promise<WsEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("timed out waiting for WS event");
    }
    const event = await nextEvent(socket, remaining);
    if (predicate(event)) {
      return event;
    }
  }
}

async function mintTicket(ctx: TestContext, user: TestUser): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/ws-ticket",
    headers: authHeader(user),
  });
  if (res.statusCode !== 200) {
    throw new Error(`ticket mint failed: ${res.statusCode} ${res.body}`);
  }
  return (res.json() as { ticket: string }).ticket;
}

async function connectWithTicket(
  ctx: TestContext,
  ticket: string,
): Promise<WebSocket> {
  return ctx.app.injectWS(`/ws?ticket=${encodeURIComponent(ticket)}`);
}

/** Resolves true when the socket closes with 4401 (or the upgrade fails). */
async function expect4401(
  connect: () => Promise<WebSocket>,
  ctx: TestContext,
): Promise<void> {
  void ctx;
  let closed = false;
  try {
    const socket = await connect();
    closed = await new Promise<boolean>((resolve) => {
      socket.on("close", (code: number) => resolve(code === 4401));
      setTimeout(() => resolve(false), 3000);
    });
    socket.close();
  } catch {
    closed = true;
  }
  expect(closed).toBe(true);
}

describeIf("websocket gateway", () => {
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

  it("handshakes via ticket, broadcasts presence and relays typing", async () => {
    const owner = await registerUser(ctx, "owner");
    const serversRes = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/servers",
      headers: authHeader(owner),
    });
    const servers = serversRes.json() as { id: string }[];
    const serverId = servers[0]?.id ?? "";
    const inviteRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/invites`,
      headers: authHeader(owner),
      payload: {},
    });
    const invite = inviteRes.json() as { code: string };
    const friend = await registerUser(ctx, "friend", invite.code);

    const stateRes = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/servers/${serverId}/state`,
      headers: authHeader(owner),
    });
    const state = serverStateSchema.parse(await stateRes.json());
    const generalId =
      state.channels.find((entry) => entry.name === "general")?.id ?? "";

    const friendSocket = await connectWithTicket(ctx, await mintTicket(ctx, friend));
    try {
      const hello = await waitFor(
        friendSocket,
        (event) => event.type === "server.ready",
      );
      expect(hello.data).toMatchObject({ userId: friend.id });

      const ownerSocket = await connectWithTicket(ctx, await mintTicket(ctx, owner));
      try {
        await waitFor(ownerSocket, (event) => event.type === "server.ready");
        const presence = await waitFor(
          friendSocket,
          (event) =>
            event.type === "presence.update" && event.data["userId"] === owner.id,
        );
        expect(presence.data).toMatchObject({ status: "online" });

        friendSocket.send(
          JSON.stringify({ type: "typing.start", channelId: generalId }),
        );
        const typing = await waitFor(
          ownerSocket,
          (event) => event.type === "typing.start",
        );
        expect(typing.data).toMatchObject({
          channelId: generalId,
          userId: friend.id,
        });
      } finally {
        ownerSocket.close();
      }
    } finally {
      friendSocket.close();
    }
  });

  it("rejects reused tickets (single use)", async () => {
    const owner = await registerUser(ctx, "owner");
    const ticket = await mintTicket(ctx, owner);
    const first = await connectWithTicket(ctx, ticket);
    try {
      await waitFor(first, (event) => event.type === "server.ready");
    } finally {
      first.close();
    }
    await expect4401(() => connectWithTicket(ctx, ticket), ctx);
  });

  it("rejects expired tickets", async () => {
    const owner = await registerUser(ctx, "owner");
    const ticket = await mintTicket(ctx, owner);
    await ctx.db.db.execute(
      sql`UPDATE ws_tickets SET expires_at = now() - interval '1 minute'`,
    );
    await expect4401(() => connectWithTicket(ctx, ticket), ctx);
  });

  it("rejects tickets of a logged-out (revoked) session", async () => {
    const owner = await registerUser(ctx, "owner");
    const ticket = await mintTicket(ctx, owner);
    const logoutRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: owner.refreshCookie },
    });
    expect(logoutRes.statusCode).toBe(204);
    await expect4401(() => connectWithTicket(ctx, ticket), ctx);
  });

  it("rejects garbage tickets", async () => {
    await registerUser(ctx, "owner");
    await expect4401(() => connectWithTicket(ctx, "not-a-real-ticket"), ctx);
  });

  it("throttles typing relays per socket and channel", async () => {
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
    const generalId =
      state.channels.find((entry) => entry.name === "general")?.id ?? "";

    const sender = await connectWithTicket(ctx, await mintTicket(ctx, owner));
    const watcher = await connectWithTicket(ctx, await mintTicket(ctx, owner));
    try {
      await waitFor(sender, (event) => event.type === "server.ready");
      await waitFor(watcher, (event) => event.type === "server.ready");

      const seen: WsEvent[] = [];
      watcher.on("message", (data: WebSocket.RawData) => {
        try {
          const parsed = wsServerEventSchema.safeParse(
            JSON.parse(data.toString()) as unknown,
          );
          if (parsed.success && parsed.data.type === "typing.start") {
            seen.push({
              type: parsed.data.type,
              data: parsed.data.data as Record<string, unknown>,
            });
          }
        } catch {
          // Ignore malformed frames in the collector.
        }
      });
      sender.send(JSON.stringify({ type: "typing.start", channelId: generalId }));
      sender.send(JSON.stringify({ type: "typing.start", channelId: generalId }));
      sender.send(JSON.stringify({ type: "typing.start", channelId: generalId }));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(seen).toHaveLength(1);
      expect(seen[0]?.data).toMatchObject({ channelId: generalId });
    } finally {
      sender.close();
      watcher.close();
    }
  });

  it("drops oversized WS frames", async () => {
    const owner = await registerUser(ctx, "owner");
    const socket = await connectWithTicket(ctx, await mintTicket(ctx, owner));
    try {
      await waitFor(socket, (event) => event.type === "server.ready");
      // The payload exceeds the 64 KiB maxPayload: the server terminates
      // the socket with code 1009 instead of buffering attacker memory.
      const closedCode = await new Promise<number>((resolve) => {
        socket.on("close", (code: number) => resolve(code));
        setTimeout(() => resolve(-1), 3000);
        socket.send(
          JSON.stringify({ type: "typing.start", channelId: "x".repeat(100 * 1024) }),
        );
      });
      expect(closedCode).toBe(1009);
    } finally {
      socket.close();
    }
  });
});
