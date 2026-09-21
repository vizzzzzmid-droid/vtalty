import { create } from "zustand";
import type { LoginBody, RegisterBody, User } from "@vitality/shared";
import { login, logoutServer, register } from "../api/resources.js";
import { setAccessToken, setRefreshHandler } from "../api/http.js";
import { disconnectSocket } from "../ws/socket.js";

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
}

function applyGuest(): void {
  setAccessToken(null);
  disconnectSocket();
  useSessionStore.setState({ user: null, accessToken: null, status: "guest" });
}

async function silentRefresh(): Promise<string | null> {
  try {
    const res = await fetch("/api/v1/auth/refresh", { method: "POST" });
    if (!res.ok) {
      return null;
    }
    const data: unknown = await res.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("accessToken" in data) ||
      !("user" in data)
    ) {
      return null;
    }
    const { accessToken, user } = data as { accessToken: unknown; user: unknown };
    if (typeof accessToken !== "string" || typeof user !== "object" || user === null) {
      return null;
    }
    applyAuth(user as User, accessToken);
    return accessToken;
  } catch {
    return null;
  }
}

setRefreshHandler(async () => {
  const token = await silentRefresh();
  if (token === null) {
    applyGuest();
  }
  return token;
});

export const useSessionStore = create<SessionState>()(() => ({
  user: null,
  accessToken: null,
  status: "loading",

  boot: async () => {
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
