import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Db } from "../../src/db/client.js";
import { loadEnv } from "../../src/env.js";

function testEnv() {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://vitality:pw@127.0.0.1:5432/vitality",
    JWT_ACCESS_SECRET: "x".repeat(32),
  });
}

describe("health routes", () => {
  it("GET /healthz and /api/v1/health return ok without touching the DB", async () => {
    const db = { execute: () => Promise.resolve([]) } as unknown as Db;
    const app = await buildApp({ env: testEnv(), db });
    try {
      for (const url of ["/healthz", "/api/v1/health"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ status: "ok" });
      }
    } finally {
      await app.close();
    }
  });

  it("GET /readyz returns ready when the DB answers", async () => {
    const db = { execute: () => Promise.resolve([]) } as unknown as Db;
    const app = await buildApp({ env: testEnv(), db });
    try {
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "ready" });
    } finally {
      await app.close();
    }
  });

  it("GET /readyz returns 503 when the DB is down", async () => {
    const db = {
      execute: () => Promise.reject(new Error("connection refused")),
    } as unknown as Db;
    const app = await buildApp({ env: testEnv(), db });
    try {
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: "not-ready" });
    } finally {
      await app.close();
    }
  });
});
