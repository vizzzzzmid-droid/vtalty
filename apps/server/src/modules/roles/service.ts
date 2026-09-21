import { and, eq } from "drizzle-orm";
import type { Role, RoleFlags } from "@vitality/shared";
import type { Db } from "../../db/client.js";
import { roles } from "../../db/schema.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { requireMembership } from "../../lib/permissions.js";

function toApiRole(row: {
  id: string;
  serverId: string;
  name: string;
  manageChannels: boolean;
  manageMembers: boolean;
  sendMessages: boolean;
  connect: boolean;
  speak: boolean;
  shareScreen: boolean;
}): Role {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name as Role["name"],
    flags: {
      manage_channels: row.manageChannels,
      manage_members: row.manageMembers,
      send_messages: row.sendMessages,
      connect: row.connect,
      speak: row.speak,
      share_screen: row.shareScreen,
    },
  };
}

export async function updateRoleFlags(
  db: Db,
  actorId: string,
  serverId: string,
  roleId: string,
  flags: Partial<RoleFlags>,
): Promise<Role> {
  const membership = await requireMembership(db, actorId, serverId);
  if (!membership.isOwner) {
    throw forbidden("Only the owner can edit roles");
  }
  const rows = await db
    .select()
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.serverId, serverId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw notFound("Role not found");
  }
  if (row.name === "owner") {
    throw forbidden("The owner role cannot be edited");
  }
  const updated = await db
    .update(roles)
    .set({
      ...(flags.manage_channels !== undefined
        ? { manageChannels: flags.manage_channels }
        : {}),
      ...(flags.manage_members !== undefined
        ? { manageMembers: flags.manage_members }
        : {}),
      ...(flags.send_messages !== undefined
        ? { sendMessages: flags.send_messages }
        : {}),
      ...(flags.connect !== undefined ? { connect: flags.connect } : {}),
      ...(flags.speak !== undefined ? { speak: flags.speak } : {}),
      ...(flags.share_screen !== undefined
        ? { shareScreen: flags.share_screen }
        : {}),
    })
    .where(eq(roles.id, roleId))
    .returning();
  const next = updated[0];
  if (next === undefined) {
    throw notFound("Role not found");
  }
  return toApiRole(next);
}
