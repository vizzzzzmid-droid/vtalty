// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/queryClient.js";

vi.mock("../src/api/resources.js", () => ({
  requestWsTicket: vi.fn(async () => "ticket-1"),
}));

/** Minimal WebSocket stand-in: the test drives the lifecycle callbacks. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static last: FakeWebSocket | null = null;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

vi.stubGlobal("WebSocket", FakeWebSocket);

import { connectSocket, disconnectSocket, sendVoiceFlags } from "../src/ws/socket.js";
import { useVoiceConnection } from "../src/voice/store.js";

const MESSAGE_CHANNEL = "11111111-1111-1111-8111-111111111111";
const MESSAGES_KEY = ["messages", MESSAGE_CHANNEL] as const;

/** Every queryKey the socket asked to refetch, in order. */
let invalidated: unknown[] = [];

beforeEach(() => {
  invalidated = [];
  FakeWebSocket.last = null;
  vi.spyOn(queryClient, "invalidateQueries").mockImplementation(
    async (filters?: { queryKey?: unknown }) => {
      invalidated.push(filters?.queryKey ?? []);
      return undefined as never;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  disconnectSocket();
  useVoiceConnection.getState().reset();
});

async function connected(): Promise<FakeWebSocket> {
  connectSocket();
  for (let i = 0; i < 50 && FakeWebSocket.last === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const ws = FakeWebSocket.last;
  if (ws === null) {
    throw new Error("socket was never opened");
  }
  ws.readyState = FakeWebSocket.OPEN;
  ws.onopen?.();
  return ws;
}

function invalidatedKeysStartingWith(prefix: string): unknown[] {
  return invalidated.filter((key) => Array.isArray(key) && key[0] === prefix);
}

describe("WS (re)connect state recovery", () => {
  it("refetches the open channel's message history on reconnect", async () => {
    // Regression: a transient WS drop while reading a channel lost every
    // message created during the outage. state/servers/unread were refetched
    // but the ["messages"] cache never was, so the list rendered stale until
    // the user switched channels and back.
    await connected();

    expect(invalidatedKeysStartingWith("messages")).not.toEqual([]);
    expect(invalidatedKeysStartingWith("state")).not.toEqual([]);
    expect(invalidatedKeysStartingWith("servers")).not.toEqual([]);
    expect(invalidatedKeysStartingWith("unread")).not.toEqual([]);
  });

  it("sends client.hello and re-announces nothing while idle", async () => {
    const ws = await connected();
    const hello = ws.sent.find((frame) => frame.includes("client.hello"));
    expect(hello).toBeDefined();
    // No voice flags are announced when the user is not in a voice channel.
    expect(ws.sent.some((frame) => frame.includes("voice.state.update"))).toBe(false);
  });

  it("re-announces the effective mic state on reconnect", async () => {
    useVoiceConnection.setState({
      status: "connected",
      channelId: "voice-1",
      selfMuted: true,
      selfDeafened: false,
    });
    const ws = await connected();
    const flags = ws.sent.find((frame) => frame.includes("voice.state.update"));
    expect(flags).toBeDefined();
    expect(flags).toContain('"muted":true');
  });

  it("stops reconnecting after logout", async () => {
    const ws = await connected();
    disconnectSocket();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    const closedAt = invalidated.length;
    // Nothing left to schedule: running is false, so an onclose must not
    // re-arm a reconnect loop for a logged-out session.
    ws.onclose?.();
    expect(invalidated.length).toBe(closedAt);
  });

  it("applies a message.create frame exactly once", async () => {
    const ws = await connected();
    const message = {
      id: "01H8XGJWBWBAQ4TPF9KQZ3XVWJ",
      channelId: MESSAGE_CHANNEL,
      authorId: "22222222-2222-2222-8222-222222222222",
      content: "hello",
      createdAt: new Date(0).toISOString(),
      editedAt: null,
      deletedAt: null,
      attachments: [],
      mentions: [],
    };
    queryClient.setQueryData(MESSAGES_KEY, {
      pages: [{ messages: [], hasMoreBefore: false, hasMoreAfter: false }],
      pageParams: [undefined],
    });
    const frame = (extra: string): string =>
      JSON.stringify({
        v: 1,
        seq: 1,
        type: "message.create",
        data: { channelId: MESSAGE_CHANNEL, message },
        at: new Date(0).toISOString(),
      }) + extra;
    ws.onmessage?.({ data: frame("") });
    ws.onmessage?.({ data: frame("") }); // duplicate frame (replay/echo)
    const data = queryClient.getQueryData<{
      pages: { messages: { id: string }[] }[];
    }>(MESSAGES_KEY);
    expect(data?.pages[0]?.messages).toHaveLength(1);
  });

  it("drops unknown payloads without touching the cache", async () => {
    const ws = await connected();
    queryClient.setQueryData(MESSAGES_KEY, {
      pages: [{ messages: [], hasMoreBefore: false, hasMoreAfter: false }],
      pageParams: [undefined],
    });
    const before = invalidated.length;
    ws.onmessage?.({ data: "not json at all" });
    ws.onmessage?.({ data: JSON.stringify({ v: 1, seq: 2, type: "message.create", data: {} }) });
    expect(invalidated.length).toBe(before);
  });
});

describe("typing and voice flag sends", () => {
  it("does not send over a closed socket", () => {
    disconnectSocket();
    expect(sendVoiceFlags("ch-1", true, false)).toBeUndefined();
  });
});
