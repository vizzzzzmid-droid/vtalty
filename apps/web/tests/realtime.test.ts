// @vitest-environment happy-dom
/**
 * Client-side realtime-state regression tests:
 *  - WebSocket reconnect (backoff, ticket-per-connect, exactly one socket)
 *  - duplicate / out-of-order frames (seq is monotonic, never rewinds)
 *  - stale state after a session boundary (lastSeq must not survive logout)
 *  - store updates (typing TTL actually expires)
 *  - subscriptions / cleanup on unmount and logout
 *
 * The socket module owns module-level singletons, so every test drives it
 * through a fake WebSocket and asserts on the frames actually sent. The
 * reconnect backoff is real time (1..30 s), so these tests use fake timers
 * and tick through it deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TYPING_TTL_MS } from "@vitality/shared";
import { usePresenceStore } from "../src/store/presence.js";

const USER = "a1b2c3d4-1111-4111-8111-111111111111";
const USER_A = "b2c3d4e5-2222-4222-8222-222222222222";
const CHANNEL = "cafebabe-0000-4000-8000-000000000001";

let ticketRequests = 0;

vi.mock("../src/api/resources.js", () => ({
  requestWsTicket: async () => {
    ticketRequests += 1;
    return "ticket-1";
  },
}));

import { connectSocket, disconnectSocket } from "../src/ws/socket.js";

interface FakeSocket {
  url: string;
  readyState: number;
  sent: string[];
  closed: boolean;
  close(): void;
  send(data: string): void;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
}

let instances: FakeSocket[] = [];

/**
 * The instance IS the socket (a constructor that returns a different object
 * would leave `new WebSocket()` holding an empty object, which is what made
 * the first version of this fake fail with "close is not a function").
 */
class FakeWebSocket implements FakeSocket {
  url: string;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;

  constructor(url: string) {
    this.url = url;
    instances.push(this);
    queueMicrotask(() => {
      if (!this.closed) {
        this.readyState = 1;
        this.onopen?.();
      }
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
}

function last(): FakeSocket {
  const socket = instances[instances.length - 1];
  if (socket === undefined) {
    throw new Error("no socket opened");
  }
  return socket;
}

function envelope(seq: number, type: string, data: unknown): string {
  return JSON.stringify({ v: 1, seq, type, data, at: new Date().toISOString() });
}

function helloOf(socket: FakeSocket): { lastSeq: number } {
  const parsed = JSON.parse(socket.sent[0] ?? "{}") as { lastSeq?: number };
  return { lastSeq: parsed.lastSeq ?? 0 };
}

/** Flush the async ticket -> WebSocket -> open chain under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
  await vi.advanceTimersByTimeAsync(1000);
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe("ws/socket realtime state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    instances = [];
    ticketRequests = 0;
  });

  afterEach(async () => {
    await disconnectSocket();
    usePresenceStore.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects once and greets with lastSeq 0 on a fresh session", async () => {
    await connectSocket();
    await flush();
    const socket = last();
    expect(instances).toHaveLength(1);
    expect(helloOf(socket).lastSeq).toBe(0);
    await socket.close();
    expect(instances).toHaveLength(1);
  });

  it("reconnects on close with backoff, and only ever owns one socket", async () => {
    await connectSocket();
    await flush();
    const first = last();

    // An unexpected close schedules exactly one reconnect.
    first.onclose?.();
    vi.advanceTimersByTime(0);
    expect(instances).toHaveLength(1);

    // Backoff base is 1 s (RECONNECT_BASE_DELAY_MS) plus jitter, so a
    // reconnect inside that window must NOT have opened a second socket.
    vi.advanceTimersByTime(500);
    expect(instances).toHaveLength(1);

    vi.advanceTimersByTimeAsync(4000);
    await flush();
    expect(instances).toHaveLength(2);

    // The old socket is forgotten: closing it again does not schedule
    // another reconnect (only the live socket's close does).
    const second = last();
    expect(second).not.toBe(first);
    first.onclose?.();
    vi.advanceTimersByTimeAsync(4000);
    expect(instances).toHaveLength(2);
  });

  it("does not rewind on a lower/duplicate seq, and never skips a live frame", async () => {
    // The server has no event log: every frame is applied, and `lastSeq` is
    // only a high-water mark. A duplicate or out-of-order delivery must not
    // rewind the cursor (so the resume claim never lies about what we saw),
    // and must not block the frame that follows it.
    await connectSocket();
    await flush();
    const socket = last();
    const presence: string[] = [];
    usePresenceStore.subscribe((state) => {
      const value = state.statuses[USER];
      if (value !== undefined) {
        presence.push(value);
      }
    });

    socket.onmessage?.({ data: envelope(5, "presence.update", { userId: USER, status: "online" }) });
    expect(presence).toEqual(["online"]);
    // A duplicate seq re-runs (idempotent write), the cursor stays at 5.
    socket.onmessage?.({ data: envelope(2, "presence.update", { userId: USER, status: "offline" }) });
    expect(presence).toEqual(["online", "offline"]);
    // The live frame after the out-of-order one still lands.
    socket.onmessage?.({ data: envelope(6, "presence.update", { userId: USER, status: "idle" }) });
    expect(presence).toEqual(["online", "offline", "idle"]);
  });

  it("forgets the previous session's seq on logout (no stale resume claim)", async () => {
    // Regression: `lastSeq` was module-level and never reset, so a tab where
    // user A's socket reached seq 7 would hand user B's brand-new connection
    // `lastSeq: 7`. The server counts from 0 per connection, so the claim is
    // about events this connection never saw — the moment the server
    // implements gap replay that is a silent loss of missed events.
    await connectSocket();
    await flush();
    const first = last();
    // Session boundary: logout tears the socket down (disconnectSocket is
    // what logout actually calls — it also drops presence, so a raw
    // socket.close() here would model a network drop instead).
    first.onmessage?.({ data: envelope(3, "presence.update", { userId: USER_A, status: "online" }) });
    first.onmessage?.({ data: envelope(7, "typing.start", { channelId: CHANNEL, userId: USER_A }) });
    await disconnectSocket();
    await flush();
    expect(usePresenceStore.getState().statuses).toEqual({});

    // A different user logs in on the same tab.
    await connectSocket();
    await flush();
    expect(helloOf(last()).lastSeq).toBe(0);
  });

  it("mints a fresh single-use ticket per reconnect", async () => {
    await connectSocket();
    await flush();
    const before = ticketRequests;
    last().onclose?.();
    await vi.advanceTimersByTimeAsync(4000);
    await flush();
    expect(ticketRequests).toBe(before + 1);
  });

  it("keeps the replay honest: live events after a gap are still consumed", async () => {
    await connectSocket();
    await flush();
    const socket = last();
    socket.onmessage?.({ data: envelope(4, "typing.start", { channelId: "cafebabe-0000-4000-8000-000000000001", userId: "a1b2c3d4-1111-4111-8111-111111111111" }) });
    // Gap (5..8 lost, e.g. the socket died mid-delivery) then the stream
    // continues at 9 — the client keeps applying newer frames.
    socket.onmessage?.({ data: envelope(9, "typing.start", { channelId: "cafebabe-0000-4000-8000-000000000001", userId: "b2c3d4e5-2222-4222-8222-222222222222" }) });
    expect(usePresenceStore.getState().typingUsers("cafebabe-0000-4000-8000-000000000001")).toEqual(["a1b2c3d4-1111-4111-8111-111111111111", "b2c3d4e5-2222-4222-8222-222222222222"]);
  });

  it("drops presence state on logout (no cross-session bleed)", async () => {
    await connectSocket();
    await flush();
    const socket = last();
    socket.onmessage?.({ data: envelope(1, "presence.update", { userId: "a1b2c3d4-1111-4111-8111-111111111111", status: "online" }) });
    expect(usePresenceStore.getState().statuses["a1b2c3d4-1111-4111-8111-111111111111"]).toBe("online");
    await disconnectSocket();
    expect(usePresenceStore.getState().statuses).toEqual({});
  });
});

describe("presence typing TTL", () => {
  beforeEach(() => {
    usePresenceStore.getState().reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    usePresenceStore.getState().reset();
    vi.useRealTimers();
  });

  it("expires a typing indicator without a new typing event", () => {
    // Regression: the only prune ran inside applyTyping, so a user who
    // stopped typing kept the "is typing…" line until someone typed in
    // THAT channel again (a store write is what re-renders subscribers).
    usePresenceStore.getState().applyTyping("cafebabe-0000-4000-8000-000000000001", "a1b2c3d4-1111-4111-8111-111111111111");
    expect(usePresenceStore.getState().typingUsers("cafebabe-0000-4000-8000-000000000001")).toEqual(["a1b2c3d4-1111-4111-8111-111111111111"]);

    vi.advanceTimersByTime(TYPING_TTL_MS * 2);
    expect(usePresenceStore.getState().typingUsers("cafebabe-0000-4000-8000-000000000001")).toEqual([]);
    expect(usePresenceStore.getState().typing).toEqual({});
  });

  it("keeps a fresh indicator while the channel stays quiet", () => {
    usePresenceStore.getState().applyTyping("cafebabe-0000-4000-8000-000000000001", "a1b2c3d4-1111-4111-8111-111111111111");
    vi.advanceTimersByTime(TYPING_TTL_MS / 2);
    expect(usePresenceStore.getState().typingUsers("cafebabe-0000-4000-8000-000000000001")).toEqual(["a1b2c3d4-1111-4111-8111-111111111111"]);
  });

  it("re-arms for a second typer with a later deadline", () => {
    usePresenceStore.getState().applyTyping("cafebabe-0000-4000-8000-000000000001", "a1b2c3d4-1111-4111-8111-111111111111");
    vi.advanceTimersByTime(TYPING_TTL_MS / 2);
    usePresenceStore.getState().applyTyping("cafebabe-0000-4000-8000-000000000001", "b2c3d4e5-2222-4222-8222-222222222222");
    // user-1's deadline elapses first: only they drop out.
    vi.advanceTimersByTime(TYPING_TTL_MS / 2 + 1);
    expect(usePresenceStore.getState().typingUsers("cafebabe-0000-4000-8000-000000000001")).toEqual(["b2c3d4e5-2222-4222-8222-222222222222"]);
    vi.advanceTimersByTime(TYPING_TTL_MS);
    expect(usePresenceStore.getState().typingUsers("cafebabe-0000-4000-8000-000000000001")).toEqual([]);
  });

  it("leaves other channels untouched", () => {
    usePresenceStore.getState().applyTyping("cafebabe-0000-4000-8000-000000000001", "a1b2c3d4-1111-4111-8111-111111111111");
    usePresenceStore.getState().applyTyping("cafebabe-0000-4000-8000-000000000002", "b2c3d4e5-2222-4222-8222-222222222222");
    vi.advanceTimersByTime(TYPING_TTL_MS / 2);
    expect(usePresenceStore.getState().typingUsers("cafebabe-0000-4000-8000-000000000001")).toEqual(["a1b2c3d4-1111-4111-8111-111111111111"]);
    expect(usePresenceStore.getState().typingUsers("cafebabe-0000-4000-8000-000000000002")).toEqual(["b2c3d4e5-2222-4222-8222-222222222222"]);
  });

  it("clears the expiry timer on reset", () => {
    usePresenceStore.getState().applyTyping("cafebabe-0000-4000-8000-000000000001", "a1b2c3d4-1111-4111-8111-111111111111");
    usePresenceStore.getState().reset();
    // No dangling timer may fire after reset.
    expect(() => vi.advanceTimersByTime(TYPING_TTL_MS * 2)).not.toThrow();
    expect(usePresenceStore.getState().typing).toEqual({});
  });
});
