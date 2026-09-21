import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe } from "vitest";
import { buildApp } from "../../src/app.js";
import { createDb, type DbHandle } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadEnv, type Env } from "../../src/env.js";

export interface TestContext {
  app: FastifyInstance;
  db: DbHandle;
  env: Env;
}

export interface TestUser {
  id: string;
  username: string;
  accessToken: string;
  refreshCookie: string;
}

const DATABASE_URL = process.env["DATABASE_URL"];
const describeIf = DATABASE_URL ? describe : describe.skip;

export { describeIf };

export async function setup(): Promise<TestContext> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    JWT_ACCESS_SECRET: "integration-secret-32-chars-minimum",
    REGISTRATION_MODE: "invite-only",
  });
  const db = createDb(databaseUrl);
  await runMigrations(db.db);
  await db.db.execute(sql`TRUNCATE users, servers CASCADE`);
  const app = await buildApp({ env, db: db.db });
  return { app, db, env };
}

/** Wipe all domain data between tests (schema_meta and migrations survive). */
export async function resetDatabase(ctx: TestContext): Promise<void> {
  await ctx.db.db.execute(sql`TRUNCATE users, servers CASCADE`);
}

export async function teardown(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.db.close();
}

export function extractRefreshCookie(headers: unknown): string {
  const record = headers as Record<string, string | string[] | undefined>;
  const raw = record["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const match = cookies
    .map((entry) => entry.split(";")[0] ?? "")
    .find((entry) => entry.startsWith("vitality_refresh="));
  if (match === undefined) {
    throw new Error("refresh cookie missing in response");
  }
  return match;
}

export async function registerUser(
  ctx: TestContext,
  username: string,
  inviteCode?: string,
): Promise<TestUser> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      username,
      password: "password-123",
      ...(inviteCode === undefined ? {} : { inviteCode }),
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as { user: { id: string }; accessToken: string };
  return {
    id: body.user.id,
    username,
    accessToken: body.accessToken,
    refreshCookie: extractRefreshCookie(res.headers),
  };
}

export function authHeader(user: TestUser): Record<string, string> {
  return { authorization: `Bearer ${user.accessToken}` };
}
