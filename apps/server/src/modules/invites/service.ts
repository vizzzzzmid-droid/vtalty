import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { CreateInviteBody, Invite } from "@vitality/shared";
import type { Db, DbOrTx } from "../../db/client.js";
import { invites, type InviteRow } from "../../db/schema.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { isUniqueViolation } from "../../lib/db-errors.js";
import { requirePermission } from "../../lib/permissions.js";

export function generateInviteCode(): string {
  return randomBytes(9).toString("base64url");
}

function toApiInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    serverId: row.serverId,
    code: row.code,
    maxUses: row.maxUses,
    uses: row.uses,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createInvite(
  db: Db,
  actorId: string,
  serverId: string,
  input: CreateInviteBody,
): Promise<Invite> {
  await requirePermission(db, actorId, serverId, "manage_members");
  const expiresAt =
    input.expiresInHours === undefined || input.expiresInHours === null
      ? null
      : new Date(Date.now() + input.expiresInHours * 3600 * 1000);
  // Code space (12 base64url chars) makes collisions ~impossible; retry anyway.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const rows = await db
        .insert(invites)
        .values({
          serverId,
          code: generateInviteCode(),
          createdBy: actorId,
          maxUses: input.maxUses ?? null,
          expiresAt,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error("invite insert returned no rows");
      }
      return toApiInvite(row);
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
    }
  }
  throw new Error("failed to generate a unique invite code");
}

export async function listInvites(
  db: Db,
  actorId: string,
  serverId: string,
): Promise<Invite[]> {
  await requirePermission(db, actorId, serverId, "manage_members");
  const rows = await db
    .select()
    .from(invites)
    .where(eq(invites.serverId, serverId))
    .orderBy(asc(invites.createdAt));
  return rows.map(toApiInvite);
}

export async function deleteInvite(
  db: Db,
  actorId: string,
  inviteId: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(invites)
    .where(eq(invites.id, inviteId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw notFound("Invite not found");
  }
  await requirePermission(db, actorId, row.serverId, "manage_members");
  await db.delete(invites).where(eq(invites.id, inviteId));
}

/** Validate + redeem an invite during registration. Returns the server id. */
export async function consumeInvite(
  tx: DbOrTx,
  code: string,
): Promise<string> {
  const rows = await tx
    .select()
    .from(invites)
    .where(eq(invites.code, code))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw badRequest("INVITE_INVALID", "Invite code is invalid");
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    throw badRequest("INVITE_EXPIRED", "Invite code has expired");
  }
  if (row.maxUses !== null && row.uses >= row.maxUses) {
    throw badRequest("INVITE_EXHAUSTED", "Invite code has no uses left");
  }
  await tx
    .update(invites)
    .set({ uses: row.uses + 1 })
    .where(eq(invites.id, row.id));
  return row.serverId;
}
