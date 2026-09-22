import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { describe } from "vitest";
import { buildApp } from "../../src/app.js";
import { createDb, type DbHandle } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadEnv, type Env } from "../../src/env.js";
import { voiceStore } from "../../src/modules/voice/store.js";
import type { LiveKitAdmin } from "../../src/lib/livekit.js";

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

export async function setup(overrides?: {
  uploadMaxBytes?: number;
  uploadDir?: string;
  voiceMaxParticipants?: number;
  voiceMaxSharers?: number;
  livekit?: LiveKitAdmin;
}): Promise<TestContext> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    JWT_ACCESS_SECRET: "integration-secret-32-chars-minimum",
    REGISTRATION_MODE: "invite-only",
    // Integration suites register far more users per minute than the
    // production auth limits allow (per-IP buckets); raise them so the
    // tests exercise logic, not the limiter (which has its own unit tests).
    RATE_LIMIT_REGISTER_MAX: "1000",
    RATE_LIMIT_LOGIN_MAX: "1000",
    RATE_LIMIT_REFRESH_MAX: "1000",
    ...(overrides?.uploadMaxBytes === undefined
      ? {}
      : { UPLOAD_MAX_BYTES: String(overrides.uploadMaxBytes) }),
    ...(overrides?.uploadDir === undefined
      ? {}
      : { UPLOAD_DIR: overrides.uploadDir }),
    ...(overrides?.voiceMaxParticipants === undefined
      ? {}
      : { VOICE_MAX_PARTICIPANTS: String(overrides.voiceMaxParticipants) }),
    ...(overrides?.voiceMaxSharers === undefined
      ? {}
      : { VOICE_MAX_SHARERS: String(overrides.voiceMaxSharers) }),
  });
  const db = createDb(databaseUrl);
  await runMigrations(db.db);
  await db.db.execute(sql`TRUNCATE users, servers CASCADE`);
  const app = await buildApp({
    env,
    db: db.db,
    ...(overrides?.livekit === undefined ? {} : { livekit: overrides.livekit }),
  });
  return { app, db, env };
}

/** Wipe all domain data between tests (schema_meta and migrations survive). */
export async function resetDatabase(ctx: TestContext): Promise<void> {
  await ctx.db.db.execute(sql`TRUNCATE users, servers CASCADE`);
  // The voice presence store is an in-memory singleton: without a reset,
  // seats leak across tests (ghost participants) even though the DB is clean.
  voiceStore.reset();
}

export async function teardown(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.db.close();
}

export function extractRefreshCookie(headers: unknown): string {  const record = headers as Record<string, string | string[] | undefined>;
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

/** In-memory LiveKit stand-in (CI has no LiveKit service). */
export class FakeLiveKitAdmin implements LiveKitAdmin {
  readonly rooms = new Map<string, Map<string, { audioTrackSid: string | null; screenTrackSids: string[] }>>();
  readonly removed: { room: string; identity: string }[] = [];
  readonly muted: { room: string; identity: string; trackSid: string; muted: boolean }[] = [];
  failList = false;
  failRemove = false;
  failMute = false;

  join(
    room: string,
    identity: string,
    audioTrackSid: string | null = "audio-sid",
    screenTrackSids: string[] = [],
  ): void {
    let participants = this.rooms.get(room);
    if (participants === undefined) {
      participants = new Map();
      this.rooms.set(room, participants);
    }
    participants.set(identity, { audioTrackSid, screenTrackSids });
  }

  async listParticipants(
    room: string,
  ): Promise<{ identity: string; audioTrackSid: string | null; screenTrackSids: string[] }[]> {
    if (this.failList) {
      throw new Error("livekit down");
    }
    const participants = this.rooms.get(room);
    if (participants === undefined) {
      return [];
    }
    return [...participants.entries()].map(([identity, info]) => ({
      identity,
      audioTrackSid: info.audioTrackSid,
      screenTrackSids: info.screenTrackSids,
    }));
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    if (this.failRemove) {
      throw new Error("livekit down");
    }
    this.rooms.get(room)?.delete(identity);
    this.removed.push({ room, identity });
  }

  async mutePublishedTrack(
    room: string,
    identity: string,
    trackSid: string,
    muted: boolean,
  ): Promise<void> {
    if (this.failMute) {
      throw new Error("livekit down");
    }
    this.muted.push({ room, identity, trackSid, muted });
  }
}

/**
 * Sign a webhook body the way LiveKit does: JWT (iss = api key, exp
 * required) whose sha256 claim is the base64 body digest.
 */
export function signWebhookBody(
  body: string,
  apiKey: string,
  apiSecret: string,
): string {
  const digest = createHash("sha256").update(body).digest();
  const sha256 = Buffer.from(digest).toString("base64");
  return jwt.sign(
    { iss: apiKey, sha256, exp: Math.floor(Date.now() / 1000) + 60 },
    apiSecret,
    { algorithm: "HS256" },
  );
}

export function webhookHeaders(body: string): Record<string, string> {
  return {
    "content-type": "application/webhook+json",
    authorization: signWebhookBody(body, "devkey", "devsecret"),
  };
}
