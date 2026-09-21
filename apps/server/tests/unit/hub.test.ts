import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  addConnection,
  broadcastToServers,
  getPresenceStatus,
  removeConnection,
  setSubscriptions,
} from "../../src/ws/hub.js";

interface FakeSocket {
  socket: WebSocket;
  messages: string[];
}

let counter = 0;

function fakeSocket(): FakeSocket {
  counter += 1;
  const messages: string[] = [];
  void counter;
  const socket = {
    readyState: WebSocket.OPEN,
    send: vi.fn((data: string) => {
      messages.push(data);
    }),
    ping: vi.fn(),
    terminate: vi.fn(),
    close: vi.fn(),
  };
  return { socket: socket as unknown as WebSocket, messages };
}

function types(messages: string[]): string[] {
  return messages.map((raw) => {
    const parsed = JSON.parse(raw) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : "?";
  });
}

describe("presence hub fan-out", () => {
  beforeEach(() => {
    counter = 0;
  });

  it("isolates broadcasts per server", () => {
    const a = fakeSocket();
    const b = fakeSocket();
    addConnection(a.socket, "user-iso-a", ["server-iso-a"]);
    addConnection(b.socket, "user-iso-b", ["server-iso-b"]);
    a.messages.length = 0;
    b.messages.length = 0;

    broadcastToServers(["server-iso-a"], "typing.start", {
      channelId: "chan-a",
      userId: "user-iso-a",
    });

    expect(types(a.messages)).toEqual(["typing.start"]);
    expect(b.messages).toHaveLength(0);
    removeConnection(a.socket);
    removeConnection(b.socket);
  });

  it("stops delivering after subscriptions are pruned (kick/leave)", () => {
    const a = fakeSocket();
    addConnection(a.socket, "user-prune-a", ["server-prune-a"]);
    setSubscriptions("user-prune-a", []);
    a.messages.length = 0;

    broadcastToServers(["server-prune-a"], "typing.start", {
      channelId: "chan-a",
      userId: "user-x",
    });
    expect(a.messages).toHaveLength(0);
    removeConnection(a.socket);
  });

  it("tracks online/offline across sockets", () => {
    const a = fakeSocket();
    expect(getPresenceStatus("user-track-a")).toBe("offline");
    addConnection(a.socket, "user-track-a", ["server-track-a"]);
    expect(getPresenceStatus("user-track-a")).toBe("online");
    removeConnection(a.socket);
    expect(getPresenceStatus("user-track-a")).toBe("offline");
  });
});
