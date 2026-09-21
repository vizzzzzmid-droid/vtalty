import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { wsClientIntentSchema } from "@vitality/shared";
import type { AppDeps } from "../app.js";
import { verifyAccessToken } from "../lib/jwt.js";
import { getMembership } from "../lib/permissions.js";
import { getChannelServerId } from "../modules/channels/service.js";
import { getMemberServerIds } from "../modules/members/service.js";
import {
  addConnection,
  broadcastToServers,
  heartbeatTick,
  markAlive,
  removeConnection,
  sendEvent,
  setUserStatus,
} from "./hub.js";

async function handleIntent(
  app: FastifyInstance,
  deps: AppDeps,
  socket: WebSocket,
  userId: string,
  raw: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    app.log.debug("ignoring non-JSON WS frame");
    return;
  }
  const intent = wsClientIntentSchema.safeParse(parsed);
  if (!intent.success) {
    app.log.debug("ignoring unknown WS intent");
    return;
  }
  switch (intent.data.type) {
    case "client.hello": {
      // No server-side event log in Phase 2: clients refetch the REST
      // snapshot on (re)connect, then consume live events. lastSeq is
      // accepted for future gap detection.
      break;
    }
    case "typing.start": {
      const serverId = await getChannelServerId(deps.db, intent.data.channelId);
      if (serverId === null) {
        break;
      }
      const membership = await getMembership(deps.db, userId, serverId);
      if (membership === null) {
        break;
      }
      broadcastToServers([serverId], "typing.start", {
        channelId: intent.data.channelId,
        userId,
      });
      break;
    }
    case "presence.update": {
      setUserStatus(userId, intent.data.status);
      break;
    }
  }
}

async function handleSocket(
  app: FastifyInstance,
  deps: AppDeps,
  socket: WebSocket,
  request: FastifyRequest<{ Querystring: { token?: string } }>,
): Promise<void> {
  const raw = request.query.token;
  if (typeof raw !== "string" || raw.length === 0) {
    socket.close(4401, "missing token");
    return;
  }
  let userId: string;
  try {
    userId = verifyAccessToken(raw, app.config.JWT_ACCESS_SECRET);
  } catch {
    socket.close(4401, "invalid token");
    return;
  }
  let serverIds: string[];
  try {
    serverIds = await getMemberServerIds(deps.db, userId);
  } catch (err) {
    app.log.error({ err }, "failed to load WS subscriptions");
    socket.close(1011, "internal error");
    return;
  }

  addConnection(socket, userId, serverIds);
  sendEvent(socket, "server.ready", { userId });

  socket.on("message", (data: WebSocket.RawData) => {
    void handleIntent(app, deps, socket, userId, data.toString()).catch(
      (err: unknown) => {
        app.log.warn({ err }, "WS intent handling failed");
      },
    );
  });
  socket.on("pong", () => {
    markAlive(socket);
  });
  socket.on("close", () => {
    removeConnection(socket);
  });
  socket.on("error", (err: Error) => {
    app.log.warn({ err }, "WS socket error");
  });
}

export async function registerGateway(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  await app.register(websocket);

  const timer = setInterval(() => {
    try {
      heartbeatTick();
    } catch (err) {
      app.log.error({ err }, "WS heartbeat failed");
    }
  }, 30000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });

  app.get<{ Querystring: { token?: string } }>(
    "/ws",
    { websocket: true },
    (socket, request) => {
      void handleSocket(app, deps, socket, request).catch((err: unknown) => {
        app.log.error({ err }, "WS handshake failed");
        try {
          socket.close(1011, "internal error");
        } catch {
          // Socket already dead; nothing to do.
        }
      });
    },
  );
}
