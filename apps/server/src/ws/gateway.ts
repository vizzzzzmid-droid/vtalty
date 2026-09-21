import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { wsClientIntentSchema } from "@vitality/shared";
import type { AppDeps } from "../app.js";
import { HttpError } from "../lib/errors.js";
import { getMembership } from "../lib/permissions.js";
import { getChannelServerId } from "../modules/channels/service.js";
import { getMemberServerIds } from "../modules/members/service.js";
import { consumeWsTicket } from "../modules/ws-tickets/service.js";
import { setMyVoiceFlags } from "../modules/voice/service.js";
import {
  addConnection,
  broadcastToServers,
  heartbeatTick,
  markAlive,
  removeConnection,
  sendEvent,
  setUserStatus,
} from "./hub.js";

const typingCooldown = new Map<WebSocket, Map<string, number>>();
const TYPING_COOLDOWN_MS = 3000;
const voiceFlagTimestamps = new Map<WebSocket, number>();
const VOICE_FLAG_COOLDOWN_MS = 1000;

/** Per-socket, per-channel typing throttle (broadcast-storm protection). */
function typingAllowed(socket: WebSocket, channelId: string): boolean {
  const now = Date.now();
  let perSocket = typingCooldown.get(socket);
  if (perSocket === undefined) {
    perSocket = new Map();
    typingCooldown.set(socket, perSocket);
  }
  const last = perSocket.get(channelId) ?? 0;
  if (now - last < TYPING_COOLDOWN_MS) {
    return false;
  }
  perSocket.set(channelId, now);
  return true;
}

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
      // No server-side event log: clients refetch the REST snapshot on
      // (re)connect, then consume live events. lastSeq is accepted for
      // future gap detection.
      break;
    }
    case "typing.start": {
      if (!typingAllowed(socket, intent.data.channelId)) {
        break;
      }
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
    case "voice.state.update": {
      // Client mic/deafen flags: accepted only for current participants of
      // that channel (forging someone else's state is impossible — the
      // user id always comes from the authenticated socket).
      const now = Date.now();
      const last = voiceFlagTimestamps.get(socket) ?? 0;
      if (now - last < VOICE_FLAG_COOLDOWN_MS) {
        break;
      }
      voiceFlagTimestamps.set(socket, now);
      const accepted = await setMyVoiceFlags(deps.db, userId, intent.data.channelId, {
        muted: intent.data.muted,
        deafened: intent.data.deafened,
      });
      if (!accepted) {
        app.log.debug("ignoring voice flags for non-participant");
      }
      break;
    }
  }
}

async function handleSocket(
  app: FastifyInstance,
  deps: AppDeps,
  socket: WebSocket,
  request: FastifyRequest<{ Querystring: { ticket?: string } }>,
): Promise<void> {
  // Auth is a single-use ticket minted via POST /api/v1/ws-ticket. Long-lived
  // JWTs never appear in the URL (and therefore never in access logs).
  const raw = request.query.ticket;
  if (typeof raw !== "string" || raw.length === 0) {
    socket.close(4401, "missing ticket");
    return;
  }
  let userId: string;
  try {
    const claims = await consumeWsTicket(deps.db, raw);
    userId = claims.userId;
  } catch (err) {
    if (err instanceof HttpError) {
      socket.close(4401, "invalid ticket");
      return;
    }
    app.log.error({ err }, "failed to consume WS ticket");
    socket.close(1011, "internal error");
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
    typingCooldown.delete(socket);
    voiceFlagTimestamps.delete(socket);
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
  // Cap inbound frame size (intents are tiny JSON); oversized frames are
  // dropped with code 1009 instead of buffering attacker-controlled memory.
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

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

  app.get<{ Querystring: { ticket?: string } }>(
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
