/**
 * Refresh plumbing extracted from the session store so the two behaviours that
 * caused the "kicked out during active use" report are unit-testable:
 *
 *  1. single-flight: a burst of 401s (access TTL 900s — resume from
 *     background, long-idle WS reconnect, several queries at once) must issue
 *     ONE refresh request instead of racing several against the rotating
 *     refresh cookie;
 *  2. classification: only an explicit 401/403 from the server ends the
 *     session. Network blips and 5xx are transient — the cookie may be
 *     perfectly valid and logging the user out for it is the "aggressively
 *     killed" bug.
 */

export type RefreshClassification = "invalid" | "transient";

export function classifyRefreshFailure(status: number): RefreshClassification {
  return status === 401 || status === 403 ? "invalid" : "transient";
}

export interface ParsedRefresh {
  accessToken: string;
  user: unknown;
}

export function parseRefreshBody(body: unknown): ParsedRefresh | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const accessToken = record["accessToken"];
  const user = record["user"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return null;
  }
  if (typeof user !== "object" || user === null) {
    return null;
  }
  return { accessToken, user };
}

export interface RefreshDeps {
  fetchRefresh: () => Promise<Response>;
  /** Token currently held in memory (possibly expired). */
  currentToken: () => string | null;
  onAuthenticated: (parsed: ParsedRefresh) => void;
}

/**
 * One refresh attempt. Returns the token a caller may retry with, or `null`
 * ONLY when the server explicitly rejected the session.
 */
export async function performRefresh(deps: RefreshDeps): Promise<string | null> {
  let res: Response;
  try {
    res = await deps.fetchRefresh();
  } catch {
    // Network failure: keep the session — retrying on the next 401 is safe,
    // logging the user out over a blip is not.
    return deps.currentToken();
  }
  if (res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return deps.currentToken(); // malformed body: transient
    }
    const parsed = parseRefreshBody(body);
    if (parsed === null) {
      return deps.currentToken();
    }
    deps.onAuthenticated(parsed);
    return parsed.accessToken;
  }
  if (classifyRefreshFailure(res.status) === "invalid") {
    return null;
  }
  return deps.currentToken(); // 5xx / 429 / etc.: transient
}

/**
 * Collapses concurrent callers onto one in-flight promise (and runs `run`
 * again for the next, later call). `T` must not reject for the session store —
 * `performRefresh` already converts failures into values.
 */
export function createSingleFlight<T>(): (run: () => Promise<T>) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (run: () => Promise<T>): Promise<T> => {
    if (inFlight !== null) {
      return inFlight;
    }
    const started = (async (): Promise<T> => run())().finally(() => {
      inFlight = null;
    });
    inFlight = started;
    return started;
  };
}
