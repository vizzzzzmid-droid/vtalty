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

  it("handshakes, broadcasts presence and relays typing", async () => {
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

    const state = serverStateSchema.parse(
      await (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/servers/${serverId}/state`,
          headers: authHeader(owner),
        })
      ).json(),
    );
    const generalId = state.channels.find((entry) => entry.name === "general")?.id ?? "";

    const friendSocket = await ctx.app.injectWS(`/ws?token=${friend.accessToken}`);
    try {
      const hello = await waitFor(friendSocket, (event) => event.type === "server.ready");
      expect(hello.data).toMatchObject({ userId: friend.id });

      const ownerSocket = await ctx.app.injectWS(`/ws?token=${owner.accessToken}`);
      try {
        await waitFor(ownerSocket, (event) => event.type === "server.ready");
        const presence = await waitFor(
          friendSocket,
          (event) =>
            event.type === "presence.update" && event.data["userId"] === owner.id,
        );
        expect(presence.data).toMatchObject({ status: "online" });

        friendSocket.send(JSON.stringify({ type: "typing.start", channelId: generalId }));
        const typing = await waitFor(
          ownerSocket,
          (event) => event.type === "typing.start",
        );
        expect(typing.data).toMatchObject({ channelId: generalId, userId: friend.id });
      } finally {
        ownerSocket.close();
      }
    } finally {
      friendSocket.close();
    }
  });

  it("rejects invalid tokens", async () => {
    let closed = false;
    try {
      const socket = await ctx.app.injectWS("/ws?token=invalid");
      closed = await new Promise<boolean>((resolve) => {
        socket.on("close", (code: number) => resolve(code === 4401));
        setTimeout(() => resolve(false), 3000);
      });
      socket.close();
    } catch {
      closed = true;
    }
    expect(closed).toBe(true);
  });
});
