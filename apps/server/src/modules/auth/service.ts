import { createHash, randomBytes, randomUUID } from "node:crypto";
import { count, eq, sql } from "drizzle-orm";
import type { LoginBody, RegisterBody, User } from "@vitality/shared";
import type { Db, DbOrTx } from "../../db/client.js";
import {
  members,
  refreshTokens,
  servers,
  users,
  type UserRow,
} from "../../db/schema.js";
import type { Env } from "../../env.js";
import {
  HttpError,
  conflict,
  notFound,
  unauthorized,
} from "../../lib/errors.js";
import { isUniqueViolation } from "../../lib/db-errors.js";
import { signAccessToken } from "../../lib/jwt.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { broadcastToServers, setSubscriptions } from "../../ws/hub.js";
import { consumeInvite } from "../invites/service.js";
import { getMemberRoleId } from "../members/service.js";
import { createServerWithDefaults } from "../servers/service.js";
import { toSafeUser } from "../users/service.js";

export const REFRESH_COOKIE = "vitality_refresh";

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  refreshMaxAgeSeconds: number;
}

export interface AuthResult {
  user: User;
  tokens: SessionTokens;
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function insertUser(tx: DbOrTx, input: RegisterBody): Promise<UserRow> {
  const passwordHash = await hashPassword(input.password);
  try {
    const rows = await tx
      .insert(users)
      .values({
        username: input.username,
        displayName: input.displayName ?? input.username,
        passwordHash,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("user insert returned no rows");
    }
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict("USERNAME_TAKEN", "Username is already taken");
    }
    throw err;
  }
}

async function issueSession(
  tx: DbOrTx,
  env: Env,
  userId: string,
  familyId: string,
): Promise<SessionTokens> {
  const refreshToken = randomBytes(48).toString("base64url");
  const refreshMaxAgeSeconds = env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600;
  await tx.insert(refreshTokens).values({
    userId,
    tokenHash: hashToken(refreshToken),
    familyId,
    expiresAt: new Date(Date.now() + refreshMaxAgeSeconds * 1000),
  });
  return {
    accessToken: signAccessToken(
      userId,
      env.JWT_ACCESS_SECRET,
      env.ACCESS_TOKEN_TTL_SECONDS,
      familyId,
    ),
    refreshToken,
    refreshMaxAgeSeconds,
  };
}

async function syncSubscriptionsTx(tx: DbOrTx, userId: string): Promise<void> {
  const rows = await tx
    .select({ serverId: members.serverId })
    .from(members)
    .where(eq(members.userId, userId));
  setSubscriptions(
    userId,
    rows.map((row) => row.serverId),
  );
}

/** First user registers freely and becomes owner of a seeded server. */
async function registerFirstUser(
  tx: DbOrTx,
  env: Env,
  input: RegisterBody,
): Promise<AuthResult> {
  const user = await insertUser(tx, input);
  const serverId = await createServerWithDefaults(tx, "vitality", user.id);
  await syncSubscriptionsTx(tx, user.id);
  const tokens = await issueSession(tx, env, user.id, randomUUID());
  broadcastToServers([serverId], "member.join", { serverId, userId: user.id });
  return { user: toSafeUser(user), tokens };
}

async function defaultServerId(tx: DbOrTx): Promise<string> {
  const rows = await tx
    .select({ id: servers.id })
    .from(servers)
    .orderBy(servers.createdAt)
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw notFound("No server exists yet");
  }
  return row.id;
}

export async function register(
  db: Db,
  env: Env,
  input: RegisterBody,
): Promise<AuthResult> {
  return db.transaction(async (tx) => {
    // Serializes concurrent first-user registrations.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('vitality-first-user'))`,
    );
    const countRows = await tx.select({ value: count() }).from(users);
    const userCount = countRows[0]?.value ?? 0;

    if (userCount === 0) {
      return registerFirstUser(tx, env, input);
    }

    const user = await insertUser(tx, input);
    let serverId: string;
    if (input.inviteCode !== undefined) {
      serverId = await consumeInvite(tx, input.inviteCode);
    } else if (env.REGISTRATION_MODE === "invite-only") {
      throw new HttpError(403, "INVITE_REQUIRED", "Invite code is required");
    } else {
      serverId = await defaultServerId(tx);
    }
    const roleId = await getMemberRoleId(tx, serverId);
    await tx.insert(members).values({ serverId, userId: user.id, roleId });
    await syncSubscriptionsTx(tx, user.id);

    const tokens = await issueSession(tx, env, user.id, randomUUID());
    broadcastToServers([serverId], "member.join", {
      serverId,
      userId: user.id,
    });
    return { user: toSafeUser(user), tokens };
  });
}

export async function login(
  db: Db,
  env: Env,
  input: LoginBody,
): Promise<AuthResult> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.username, input.username))
    .limit(1);
  const row = rows[0];
  const ok =
    row !== undefined &&
    (await verifyPassword(row.passwordHash, input.password));
  if (!ok) {
    // Same error for unknown users and wrong passwords (no enumeration).
    throw unauthorized("Invalid username or password");
  }
  const user = row as UserRow;
  const tokens = await issueSession(db, env, user.id, randomUUID());
  return { user: toSafeUser(user), tokens };
}

export async function refresh(
  db: Db,
  env: Env,
  rawToken: string,
): Promise<AuthResult> {
  const digest = hashToken(rawToken);
  const rows = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, digest))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw unauthorized("Invalid refresh token");
  }
  if (row.revokedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    if (row.revokedAt !== null) {
      // Reuse of a rotated token: revoke the whole family (possible theft).
      await db
        .delete(refreshTokens)
        .where(eq(refreshTokens.familyId, row.familyId));
      throw unauthorized("Session was revoked");
    }
    await db.delete(refreshTokens).where(eq(refreshTokens.id, row.id));
    throw unauthorized("Refresh token expired");
  }
  const tokens = await db.transaction(async (tx) => {
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, row.id));
    return issueSession(tx, env, row.userId, row.familyId);
  });
  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  const user = userRows[0];
  if (user === undefined) {
    throw unauthorized("User no longer exists");
  }
  return { user: toSafeUser(user), tokens };
}

export async function logout(db: Db, rawToken: string | null): Promise<void> {
  if (rawToken === null) {
    return;
  }
  const rows = await db
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(rawToken)))
    .limit(1);
  const row = rows[0];
  if (row !== undefined) {
    await db
      .delete(refreshTokens)
      .where(eq(refreshTokens.familyId, row.familyId));
  }
}
