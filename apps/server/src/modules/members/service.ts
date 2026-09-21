import { and, eq } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import { members, roles } from "../../db/schema.js";
import { HttpError, forbidden, notFound } from "../../lib/errors.js";
import { requireMembership, requirePermission } from "../../lib/permissions.js";
import { broadcastToServers, setSubscriptions } from "../../ws/hub.js";

export interface MemberTarget {
  id: string;
  serverId: string;
  userId: string;
  roleName: string;
}

export async function getMemberServerIds(
  db: DbOrTx,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ serverId: members.serverId })
    .from(members)
    .where(eq(members.userId, userId));
  return rows.map((row) => row.serverId);
}

export async function syncSubscriptions(
  db: DbOrTx,
  userId: string,
): Promise<void> {
  setSubscriptions(userId, await getMemberServerIds(db, userId));
}

/** The fixed `member` role of a server (seeded with every server). */
export async function getMemberRoleId(
  tx: DbOrTx,
  serverId: string,
): Promise<string> {
  const rows = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.serverId, serverId), eq(roles.name, "member")))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`member role missing for server ${serverId}`);
  }
  return row.id;
}

async function findMemberOr404(db: DbOrTx, memberId: string): Promise<MemberTarget> {
  const rows = await db
    .select({ member: members, role: roles })
    .from(members)
    .innerJoin(roles, eq(members.roleId, roles.id))
    .where(eq(members.id, memberId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw notFound("Member not found");
  }
  return {
    id: row.member.id,
    serverId: row.member.serverId,
    userId: row.member.userId,
    roleName: row.role.name,
  };
}

async function findRoleInServer(
  db: DbOrTx,
  serverId: string,
  roleId: string,
): Promise<{ id: string; name: string }> {
  const rows = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.serverId, serverId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw notFound("Role not found on this server");
  }
  return row;
}

export async function updateRole(
  db: Db,
  actorId: string,
  memberId: string,
  roleId: string,
): Promise<{ serverId: string; userId: string; roleId: string }> {
  const target = await findMemberOr404(db, memberId);
  const membership = await requirePermission(
    db,
    actorId,
    target.serverId,
    "manage_members",
  );
  if (target.roleName === "owner") {
    throw forbidden("The server owner cannot be modified");
  }
  const newRole = await findRoleInServer(db, target.serverId, roleId);
  if (newRole.name === "owner") {
    throw forbidden("Ownership transfer is not supported");
  }
  if (
    (newRole.name === "admin" || target.roleName === "admin") &&
    !membership.isOwner
  ) {
    throw forbidden("Only the owner can manage admins");
  }
  if (target.userId === actorId && membership.isOwner) {
    throw forbidden("Owners cannot change their own role");
  }
  await db.update(members).set({ roleId }).where(eq(members.id, memberId));
  await syncSubscriptions(db, target.userId);
  broadcastToServers([target.serverId], "member.role_update", {
    serverId: target.serverId,
    userId: target.userId,
    roleId,
  });
  return { serverId: target.serverId, userId: target.userId, roleId };
}

export async function kickMember(
  db: Db,
  actorId: string,
  memberId: string,
): Promise<void> {
  const target = await findMemberOr404(db, memberId);
  await requirePermission(db, actorId, target.serverId, "manage_members");
  if (target.roleName === "owner") {
    throw forbidden("The server owner cannot be kicked");
  }
  if (target.userId === actorId) {
    throw forbidden("Use leave to remove yourself");
  }
  await db.delete(members).where(eq(members.id, memberId));
  await syncSubscriptions(db, target.userId);
  broadcastToServers([target.serverId], "member.leave", {
    serverId: target.serverId,
    userId: target.userId,
  });
}

export async function leaveServer(
  db: Db,
  userId: string,
  serverId: string,
): Promise<void> {
  const membership = await requireMembership(db, userId, serverId);
  if (membership.isOwner) {
    throw new HttpError(
      409,
      "OWNER_MUST_DELETE",
      "The owner cannot leave: delete the server instead",
    );
  }
  await db.delete(members).where(eq(members.id, membership.memberId));
  await syncSubscriptions(db, userId);
  broadcastToServers([serverId], "member.leave", { serverId, userId });
}
