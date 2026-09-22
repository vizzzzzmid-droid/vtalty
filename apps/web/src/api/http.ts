import { REST_API_BASE } from "@vitality/shared";

let accessToken: string | null = null;
let refreshHandler: (() => Promise<string | null>) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Registered once by the session store (avoids a store->http import cycle). */
export function setRefreshHandler(handler: () => Promise<string | null>): void {
  refreshHandler = handler;
}

/** Run the registered refresh handler (used by non-JSON callers). */
export async function ensureFreshSession(): Promise<boolean> {
  if (refreshHandler === null) {
    return false;
  }
  return (await refreshHandler()) !== null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown };
}

async function parseError(res: Response, fallback: string): Promise<ApiError> {
  let code = "REQUEST_FAILED";
  let message = fallback;
  try {
    const data = (await res.json()) as ErrorBody;
    if (typeof data.error?.code === "string") {
      code = data.error.code;
    }
    if (typeof data.error?.message === "string") {
      message = data.error.message;
    }
  } catch {
    // Non-JSON error body; keep the fallback message.
  }
  return new ApiError(res.status, code, message);
}

async function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  const base = init?.headers;
  const headers: Record<string, string> =
    base instanceof Headers
      ? Object.fromEntries(base.entries())
      : Array.isArray(base)
        ? Object.fromEntries(base)
        : { ...(base ?? {}) };
  // Never claim JSON without a body: Fastify rejects empty application/json
  // payloads with 400 (this broke bodiless POSTs like ws-ticket, logout and
  // voice-token in real browsers; inject-based tests never set the header
  // and stayed green).
  if (
    init?.body !== undefined &&
    headers["Content-Type"] === undefined &&
    headers["content-type"] === undefined
  ) {
    headers["Content-Type"] = "application/json";
  }
  if (
    accessToken !== null &&
    headers["Authorization"] === undefined &&
    headers["authorization"] === undefined
  ) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }
  return fetch(`${REST_API_BASE}${path}`, { ...init, headers });
}

/**
 * Authenticated JSON request. On 401 (non-auth paths) tries one silent
 * refresh and retries once. Parallel 401s may trigger parallel refreshes;
 * acceptable for a 50-user instance (server rotation is idempotent-safe:
 * only the first refresh wins, others re-login).
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res = await rawRequest(path, init);
  if (res.status === 401 && refreshHandler !== null && !path.startsWith("/auth/")) {
    const renewed = await refreshHandler();
    if (renewed !== null) {
      res = await rawRequest(path, init);
    }
  }
  if (!res.ok) {
    throw await parseError(res, `Request failed with status ${res.status}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  const data: unknown = await res.json();
  return data as T;
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export async function del(path: string): Promise<void> {
  await request<undefined>(path, { method: "DELETE" });
}
