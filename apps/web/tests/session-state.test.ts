// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, setAccessToken } from "../src/api/http.js";
import { queryClient } from "../src/api/queryClient.js";

const USER = { id: "user-1", username: "alice", displayName: "Alice", avatarUrl: null };

/** Call counters for the mocked side effects of a session change. */
const counts = vi.hoisted(() => ({
  connectSocket: 0,
  disconnectSocket: 0,
  startSettingsSync: 0,
  stopSettingsSync: 0,
  refresh: 0,
}));

vi.mock("../src/api/resources.js", () => ({
  login: vi.fn(async () => ({ user: USER, accessToken: "login-token" })),
  logoutServer: vi.fn(async () => undefined),
  register: vi.fn(async () => ({ user: USER, accessToken: "login-token" })),
}));

vi.mock("../src/ws/socket.js", () => ({
  connectSocket: () => {
    counts.connectSocket += 1;
  },
  disconnectSocket: () => {
    counts.disconnectSocket += 1;
  },
}));

vi.mock("../src/voice/settings-sync.js", () => ({
  startSettingsSync: () => {
    counts.startSettingsSync += 1;
  },
  stopSettingsSync: () => {
    counts.stopSettingsSync += 1;
  },
}));

vi.mock("../src/voice/room.js", () => ({
  leaveVoiceChannel: () => Promise.resolve(),
}));

import { useSessionStore } from "../src/store/session.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/auth/refresh")) {
        counts.refresh += 1;
        return jsonResponse(200, { accessToken: "rotated", user: USER });
      }
      if (path.endsWith("/servers")) {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
        if (auth === "Bearer stale") {
          return jsonResponse(401, {
            error: { code: "UNAUTHORIZED", message: "expired" },
          });
        }
        return jsonResponse(200, []);
      }
      return jsonResponse(404, { error: { code: "NOT_FOUND", message: "nope" } });
    }),
  );
}

beforeEach(() => {
  counts.connectSocket = 0;
  counts.disconnectSocket = 0;
  counts.startSettingsSync = 0;
  counts.stopSettingsSync = 0;
  counts.refresh = 0;
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
  setAccessToken(null);
  useSessionStore.setState({ user: null, accessToken: null, status: "loading" });
});

describe("session establishment vs. token rotation", () => {
  it("connects the socket once at boot and does NOT reconnect on a mid-session refresh", async () => {
    // Cold start: the socket is established exactly once.
    await useSessionStore.getState().boot();
    expect(counts.connectSocket).toBe(1);
    expect(counts.refresh).toBe(1);

    // The access JWT expired (900 s TTL); the next REST call goes 401 and the
    // shared single-flight refresh rotates it. That is a token rotation, not a
    // new session — the live socket must keep running.
    setAccessToken("stale");
    await expect(get("/servers")).resolves.toEqual([]);
    expect(counts.refresh).toBe(2);
    expect(counts.connectSocket).toBe(1);
    expect(counts.startSettingsSync).toBe(1);
    expect(counts.disconnectSocket).toBe(0);
  });

  it("connects the socket on a fresh login", async () => {
    await useSessionStore.getState().login({ username: "alice", password: "password-123" });
    expect(counts.connectSocket).toBe(1);
    expect(useSessionStore.getState().status).toBe("authed");
    expect(useSessionStore.getState().accessToken).toBe("login-token");
  });
});

describe("logout clears the renderer cache", () => {
  it("drops the previous account's cached queries so they cannot leak into the next session", async () => {
    await useSessionStore.getState().login({ username: "alice", password: "password-123" });
    queryClient.setQueryData(["messages", "ch-1"], {
      pages: [{ messages: [{ id: "secret-message" }], hasMoreBefore: false, hasMoreAfter: false }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(["state", "srv-1"], { server: { id: "srv-1" } });
    expect(queryClient.getQueryData(["messages", "ch-1"])).toBeDefined();

    await useSessionStore.getState().logout();

    // Without this the next login (possibly a DIFFERENT user on a shared
    // browser) renders the previous account's messages before the refetch.
    expect(queryClient.getQueryData(["messages", "ch-1"])).toBeUndefined();
    expect(queryClient.getQueryData(["state", "srv-1"])).toBeUndefined();
    expect(counts.disconnectSocket).toBe(1);
    expect(useSessionStore.getState().status).toBe("guest");
  });
});
