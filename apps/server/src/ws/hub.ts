import { WebSocket } from "ws";
import {
  WS_PROTOCOL_VERSION,
  type PresenceStatus,
  type WsServerEvent,
  type WsServerEventName,
} from "@vitality/shared";

interface ConnRecord {
  socket: WebSocket;
  userId: string;
  serverIds: Set<string>;
  seq: number;
  alive: boolean;
}

type EventData<T extends WsServerEventName> = Extract<
  WsServerEvent,
  { type: T }
>["data"];

const connections = new Map<WebSocket, ConnRecord>();
const userConnections = new Map<string, Set<WebSocket>>();
const presence = new Map<string, PresenceStatus>();

export function getPresenceStatus(userId: string): PresenceStatus {
  return presence.get(userId) ?? "offline";
}

/** Per-connection sequence numbers (used for resume gap detection). */
export function sendEvent<T extends WsServerEventName>(
  socket: WebSocket,
  type: T,
  data: EventData<T>,
): void {
  const rec = connections.get(socket);
  if (rec === undefined || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  rec.seq += 1;
  socket.send(
    JSON.stringify({
      v: WS_PROTOCOL_VERSION,
      seq: rec.seq,
      type,
      data,
      at: new Date().toISOString(),
    }),
  );
}

export function broadcastToServers<T extends WsServerEventName>(
  serverIds: readonly string[],
  type: T,
  data: EventData<T>,
): void {
  if (serverIds.length === 0) {
    return;
  }
  const wanted = new Set(serverIds);
  for (const rec of connections.values()) {
    for (const id of rec.serverIds) {
      if (wanted.has(id)) {
        sendEvent(rec.socket, type, data);
        break;
      }
    }
  }
}

function broadcastPresence(userId: string, status: PresenceStatus): void {
  const serverIds = new Set<string>();
  for (const socket of userConnections.get(userId) ?? []) {
    const rec = connections.get(socket);
    if (rec !== undefined) {
      for (const id of rec.serverIds) {
        serverIds.add(id);
      }
    }
  }
  broadcastToServers([...serverIds], "presence.update", { userId, status });
}

export function addConnection(
  socket: WebSocket,
  userId: string,
  serverIds: string[],
): void {
  const record: ConnRecord = {
    socket,
    userId,
    serverIds: new Set(serverIds),
    seq: 0,
    alive: true,
  };
  connections.set(socket, record);
  let set = userConnections.get(userId);
  if (set === undefined) {
    set = new Set();
    userConnections.set(userId, set);
  }
  const first = set.size === 0;
  set.add(socket);
  if (first || presence.get(userId) !== "online") {
    presence.set(userId, "online");
    broadcastPresence(userId, "online");
  }
}

/** Returns the user id when their last socket closed. */
export function removeConnection(socket: WebSocket): string | null {
  const rec = connections.get(socket);
  if (rec === undefined) {
    return null;
  }
  connections.delete(socket);
  const set = userConnections.get(rec.userId);
  if (set !== undefined) {
    set.delete(socket);
    if (set.size === 0) {
      userConnections.delete(rec.userId);
      presence.set(rec.userId, "offline");
      broadcastPresence(rec.userId, "offline");
      return rec.userId;
    }
  }
  return null;
}

export function setUserStatus(
  userId: string,
  status: Extract<PresenceStatus, "online" | "idle">,
): boolean {
  if (!userConnections.has(userId)) {
    return false;
  }
  if (presence.get(userId) === status) {
    return false;
  }
  presence.set(userId, status);
  broadcastPresence(userId, status);
  return true;
}

export function setSubscriptions(userId: string, serverIds: string[]): void {
  for (const socket of userConnections.get(userId) ?? []) {
    const rec = connections.get(socket);
    if (rec !== undefined) {
      rec.serverIds = new Set(serverIds);
    }
  }
}

export function markAlive(socket: WebSocket): void {
  const rec = connections.get(socket);
  if (rec !== undefined) {
    rec.alive = true;
  }
}

/** Ping/pong sweep: terminates sockets that missed their pong. */
export function heartbeatTick(): void {
  for (const [socket, rec] of connections) {
    if (!rec.alive) {
      socket.terminate();
      continue;
    }
    rec.alive = false;
    socket.ping();
  }
}
