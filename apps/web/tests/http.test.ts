import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  get,
  post,
  setAccessToken,
  setRefreshHandler,
} from "../src/api/http.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
  setRefreshHandler(() => Promise.resolve(null));
});

describe("request", () => {
  it("sends the bearer token", async () => {
    setAccessToken("token-123");
    let seen: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen = { ...(init?.headers as Record<string, string>) };
        return jsonResponse(200, { ok: true });
      }),
    );
    await expect(get<{ ok: boolean }>("/servers")).resolves.toEqual({ ok: true });
    expect(seen["Authorization"]).toBe("Bearer token-123");
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    setAccessToken("stale");
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
        seen.push(auth);
        if (auth === "Bearer stale") {
          return jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "expired" } });
        }
        return jsonResponse(200, { ok: true });
      }),
    );
    setRefreshHandler(() => {
      setAccessToken("fresh");
      return Promise.resolve("fresh");
    });
    await expect(get<{ ok: boolean }>("/servers")).resolves.toEqual({ ok: true });
    expect(seen).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("throws ApiError with the server code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(403, { error: { code: "FORBIDDEN", message: "nope" } }),
      ),
    );
    const err = await get("/servers").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("FORBIDDEN");
    expect((err as ApiError).status).toBe(403);
  });

  it("does not attempt refresh for auth paths", async () => {
    let refreshCalls = 0;
    setRefreshHandler(() => {
      refreshCalls += 1;
      return Promise.resolve(null);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: { code: "X", message: "y" } })),
    );
    await expect(get("/auth/me")).rejects.toBeInstanceOf(ApiError);
    expect(refreshCalls).toBe(0);
  });

  it("omits content-type on bodiless POSTs (Fastify 400s empty JSON)", async () => {
    let seen: Record<string, string> = {};
    let seenBody: unknown = "unset";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen = { ...(init?.headers as Record<string, string>) };
        seenBody = init?.body;
        return jsonResponse(200, { ok: true });
      }),
    );
    await post("/ws-ticket");
    expect(seen["Content-Type"]).toBeUndefined();
    expect(seenBody).toBeUndefined();
  });

  it("sends content-type with a JSON body", async () => {
    let seen: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen = { ...(init?.headers as Record<string, string>) };
        return jsonResponse(200, { ok: true });
      }),
    );
    await post("/auth/login", { username: "u", password: "p" });
    expect(seen["Content-Type"]).toBe("application/json");
  });
});
