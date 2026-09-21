import { and, eq } from "drizzle-orm";
import type { Permission } from "@vitality/shared";
import type { Db } from "../db/client.js";
import { members, roles } from "../db/schema.js";
import { forbidden } from "./errors.js";

export interface Membership {
  memberId: string;
  roleId: string;
  roleName: string;
  isOwner: boolean;
  flags: Record<Permission, boolean>;
}

export async function getMembership(
  db: Db,
  userId: string,
  serverId: string,
): Promise<Membership | null> {
  const rows = await db
    .select({ member: members, role: roles })
    .from(members)
    .innerJoin(roles, eq(members.roleId, roles.id))
    .where(and(eq(members.serverId, serverId), eq(members.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    memberId: row.member.id,
    roleId: row.role.id,
    roleName: row.role.name,
    isOwner: row.role.name === "owner",
    flags: {
      manage_channels: row.role.manageChannels,
      manage_members: row.role.manageMembers,
      send_messages: row.role.sendMessages,
      connect: row.role.connect,
      speak: row.role.speak,
      share_screen: row.role.shareScreen,
    },
  };
}

export async function requireMembership(
  db: Db,
  userId: string,
  serverId: string,
): Promise<Membership> {
  const membership = await getMembership(db, userId, serverId);
  if (membership === null) {
    throw forbidden("Not a member of this server");
  }
  return membership;
}

export function hasPermission(membership: Membership, perm: Permission): boolean {
  return membership.isOwner || membership.flags[perm];
}

export async function requirePermission(
  db: Db,
  userId: string,
  serverId: string,
  perm: Permission,
): Promise<Membership> {
  const membership = await requireMembership(db, userId, serverId);
  if (!hasPermission(membership, perm)) {
    throw forbidden(`Missing permission: ${perm}`);
  }
  return membership;
}
