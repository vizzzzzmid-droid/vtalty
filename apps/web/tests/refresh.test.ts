import { describe, expect, it, vi } from "vitest";
import {
  classifyRefreshFailure,
  createSingleFlight,
  parseRefreshBody,
  performRefresh,
  type RefreshDeps,
} from "../src/api/refresh.js";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function deps(overrides: Partial<RefreshDeps> = {}): RefreshDeps {
  return {
    fetchRefresh: () => Promise.resolve(response(200, { accessToken: "t", user: { id: "u" } })),
    currentToken: () => "current",
    onAuthenticated: () => undefined,
    ...overrides,
  };
}

describe("classifyRefreshFailure", () => {
  it("treats 401/403 as a real session rejection", () => {
    expect(classifyRefreshFailure(401)).toBe("invalid");
    expect(classifyRefreshFailure(403)).toBe("invalid");
  });

  it("treats server errors and rate limits as transient", () => {
    for (const status of [500, 502, 503, 429, 418]) {
      expect(classifyRefreshFailure(status)).toBe("transient");
    }
  });
});

describe("parseRefreshBody", () => {
  it("accepts a well-formed body", () => {
    expect(parseRefreshBody({ accessToken: "t", user: { id: "u" } })).toEqual({
      accessToken: "t",
      user: { id: "u" },
    });
  });

  it("rejects malformed bodies", () => {
    expect(parseRefreshBody(null)).toBeNull();
    expect(parseRefreshBody("nope")).toBeNull();
    expect(parseRefreshBody({ user: {} })).toBeNull();
    expect(parseRefreshBody({ accessToken: "", user: {} })).toBeNull();
    expect(parseRefreshBody({ accessToken: 1, user: {} })).toBeNull();
    expect(parseRefreshBody({ accessToken: "t", user: null })).toBeNull();
  });
});

describe("performRefresh", () => {
  it("returns the new token and reports the authentication", async () => {
    const onAuthenticated = vi.fn();
    const token = await performRefresh(deps({ onAuthenticated }));
    expect(token).toBe("t");
    expect(onAuthenticated).toHaveBeenCalledExactlyOnceWith({
      accessToken: "t",
      user: { id: "u" },
    });
  });

  it("returns null ONLY on an explicit 401 (real logout)", async () => {
    const onAuthenticated = vi.fn();
    const token = await performRefresh(
      deps({
        fetchRefresh: () =>
          Promise.resolve(response(401, { error: { code: "UNAUTHORIZED", message: "gone" } })),
        onAuthenticated,
      }),
    );
    expect(token).toBeNull();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("keeps the session on network failures (the reported bug: blip = logout)", async () => {
    const onAuthenticated = vi.fn();
    const token = await performRefresh(
      deps({
        fetchRefresh: () => Promise.reject(new TypeError("Failed to fetch")),
        onAuthenticated,
      }),
    );
    expect(token).toBe("current");
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("keeps the session on 5xx and rate limits", async () => {
    for (const status of [500, 503, 429]) {
      const token = await performRefresh(
        deps({ fetchRefresh: () => Promise.resolve(response(status, {})) }),
      );
      expect(token).toBe("current");
    }
  });

  it("keeps the session when the success body is malformed", async () => {
    const token = await performRefresh(
      deps({
        fetchRefresh: () => Promise.resolve(response(200, { accessToken: 42, user: null })),
      }),
    );
    expect(token).toBe("current");
  });

  it("keeps the session when the body cannot be parsed as JSON", async () => {
    const token = await performRefresh(
      deps({
        fetchRefresh: () =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.reject(new SyntaxError("bad json")),
          } as Response),
      }),
    );
    expect(token).toBe("current");
  });
});

describe("createSingleFlight", () => {
  it("collapses concurrent callers onto one run", async () => {
    const flight = createSingleFlight<string>();
    let runs = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async (): Promise<string> => {
      runs += 1;
      await gate;
      return `result-${runs}`;
    };

    const first = flight(run);
    const others = [flight(run), flight(run), flight(run), flight(run)];
    release?.();
    const results = await Promise.all([first, ...others]);
    expect(runs).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("runs again for a later call once the first settled", async () => {
    const flight = createSingleFlight<number>();
    let runs = 0;
    const run = (): Promise<number> => Promise.resolve((runs += 1));
    await expect(flight(run)).resolves.toBe(1);
    await expect(flight(run)).resolves.toBe(2);
    expect(runs).toBe(2);
  });

  it("clears the slot after a failure so the next call retries", async () => {
    const flight = createSingleFlight<string>();
    await expect(
      flight(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    await expect(flight(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});
