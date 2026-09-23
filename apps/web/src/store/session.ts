import { create } from "zustand";
import type { LoginBody, RegisterBody, User } from "@vitality/shared";
import { login, logoutServer, register } from "../api/resources.js";
import {
  getAccessToken,
  setAccessToken,
  setRefreshHandler,
} from "../api/http.js";
import { createSingleFlight, performRefresh } from "../api/refresh.js";
import { startSettingsSync, stopSettingsSync } from "../voice/settings-sync.js";
import { leaveVoiceChannel } from "../voice/room.js";
import { connectSocket, disconnectSocket } from "../ws/socket.js";

type SessionStatus = "loading" | "authed" | "guest";

interface SessionState {
  user: User | null;
  accessToken: string | null;
  status: SessionStatus;
  boot: () => Promise<void>;
  login: (input: LoginBody) => Promise<void>;
  register: (input: RegisterBody) => Promise<void>;
  logout: () => Promise<void>;
}

function applyAuth(user: User, token: string): void {
  setAccessToken(token);
  useSessionStore.setState({ user, accessToken: token, status: "authed" });
  connectSocket();
  startSettingsSync(user.id);
}

function applyGuest(): void {
  setAccessToken(null);
  disconnectSocket();
  stopSettingsSync();
  void leaveVoiceChannel();
  useSessionStore.setState({ user: null, accessToken: null, status: "guest" });
}

const singleFlightRefresh = createSingleFlight<string | null>();

/** One refresh attempt; `null` only when the server rejected the session. */
async function refreshOnce(): Promise<string | null> {
  return performRefresh({
    fetchRefresh: () => fetch("/api/v1/auth/refresh", { method: "POST" }),
    currentToken: getAccessToken,
    onAuthenticated: (parsed) => {
      applyAuth(parsed.user as User, parsed.accessToken);
    },
  });
}

/**
 * Every concurrent 401 handler (queries, WS ticket, settings sync, a
 * backgrounded app resuming) shares ONE in-flight refresh — the rotating
 * refresh cookie must never see two racing requests from this tab. Cross-tab
 * races are absorbed by the server's rotation grace window (REFRESH_REUSE_GRACE_MS).
 */
function silentRefresh(): Promise<string | null> {
  return singleFlightRefresh(refreshOnce);
}

setRefreshHandler(async () => {
  const token = await silentRefresh();
  if (token === null) {
    // Explicit 401/403 from the server only — transient failures return the
    // current token above and must NOT end the session.
    applyGuest();
  }
  return token;
});

export const useSessionStore = create<SessionState>()(() => ({
  user: null,
  accessToken: null,
  status: "loading",

  boot: async () => {
    // Cold start: nothing in memory yet, so a transient failure here still
    // lands on guest (we cannot verify a session offline). Mid-session
    // refreshes no longer do that — see api/refresh.ts.
    const token = await silentRefresh();
    if (token === null) {
      applyGuest();
    }
  },

  login: async (input) => {
    const result = await login(input);
    applyAuth(result.user, result.accessToken);
  },

  register: async (input) => {
    const result = await register(input);
    applyAuth(result.user, result.accessToken);
  },

  logout: async () => {
    try {
      await logoutServer();
    } catch {
      // Server already forgot us or is unreachable; clear local state anyway.
    }
    applyGuest();
  },
}));
