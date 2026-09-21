import { and, asc, eq } from "drizzle-orm";
import {
  serverStateSchema,
  type Category,
  type Channel,
  type MemberWithUser,
  type Role,
  type ServerState,
} from "@vitality/shared";
import type { Db, DbOrTx } from "../../db/client.js";
import {
  channelCategories,
  channels,
  members,
  roles,
  servers,
  users,
} from "../../db/schema.js";
import { HttpError, forbidden, notFound } from "../../lib/errors.js";
import { requireMembership } from "../../lib/permissions.js";
import {
  broadcastToServers,
  getPresenceStatus,
} from "../../ws/hub.js";
import { syncSubscriptions } from "../members/service.js";

export interface ServerSummary {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

function toSummary(row: {
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
}): ServerSummary {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    createdAt: row.createdAt.toISOString(),
  };
}

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

/** Create a server with default roles, membership, categories and channels. */
export async function createServerWithDefaults(
  tx: DbOrTx,
  name: string,
  ownerId: string,
): Promise<string> {
  const serverRows = await tx.insert(servers).values({ name, ownerId }).returning();
  const server = serverRows[0];
  if (server === undefined) {
    throw new Error("server insert returned no rows");
  }

  const roleSeeds = [
    {
      name: "owner",
      manageChannels: true,
      manageMembers: true,
      sendMessages: true,
      connect: true,
      speak: true,
      shareScreen: true,
      position: 0,
    },
    {
      name: "admin",
      manageChannels: true,
      manageMembers: true,
      sendMessages: true,
      connect: true,
      speak: true,
      shareScreen: true,
      position: 1,
    },
    {
      name: "member",
      manageChannels: false,
      manageMembers: false,
      sendMessages: true,
      connect: true,
      speak: true,
      shareScreen: true,
      position: 2,
    },
  ];
  const roleRows = await tx
    .insert(roles)
    .values(roleSeeds.map((seed) => ({ ...seed, serverId: server.id })))
    .returning();
  const ownerRole = roleRows.find((role) => role.name === "owner");
  if (ownerRole === undefined) {
    throw new Error("owner role was not created");
  }
  await tx
    .insert(members)
    .values({ serverId: server.id, userId: ownerId, roleId: ownerRole.id });

  const categoryRows = await tx
    .insert(channelCategories)
    .values([
      { serverId: server.id, name: "Text", position: 0 },
      { serverId: server.id, name: "Voice", position: 1 },
    ])
    .returning();
  const textCategory = categoryRows.find((cat) => cat.name === "Text");
  const voiceCategory = categoryRows.find((cat) => cat.name === "Voice");
  if (textCategory === undefined || voiceCategory === undefined) {
    throw new Error("seed categories were not created");
  }
  await tx.insert(channels).values([
    {
      serverId: server.id,
      categoryId: textCategory.id,
      name: "general",
      type: "text",
      position: 0,
    },
    {
      serverId: server.id,
      categoryId: voiceCategory.id,
      name: "General",
      type: "voice",
      position: 1,
    },
  ]);

  return server.id;
}

export async function listServers(
  db: Db,
  userId: string,
): Promise<ServerSummary[]> {
  const rows = await db
    .select({ server: servers })
    .from(members)
    .innerJoin(servers, eq(members.serverId, servers.id))
    .where(eq(members.userId, userId))
    .orderBy(asc(servers.createdAt));
  return rows.map((row) => toSummary(row.server));
}

export async function createServer(
  db: Db,
  userId: string,
  name: string,
): Promise<ServerSummary> {
  const serverId = await db.transaction(async (tx) =>
    createServerWithDefaults(tx, name, userId),
  );
  await syncSubscriptions(db, userId);
  broadcastToServers([serverId], "member.join", { serverId, userId });
  const rows = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("server was not created");
  }
  return toSummary(row);
}

export async function getServerState(
  db: Db,
  userId: string,
  serverId: string,
): Promise<ServerState> {
  await requireMembership(db, userId, serverId);

  const serverRows = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  const server = serverRows[0];
  if (server === undefined) {
    throw notFound("Server not found");
  }

  const roleRows = await db
    .select()
    .from(roles)
    .where(eq(roles.serverId, serverId))
    .orderBy(asc(roles.position));
  const memberRows = await db
    .select({ member: members, user: users })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(eq(members.serverId, serverId));
  const categoryRows = await db
    .select()
    .from(channelCategories)
    .where(eq(channelCategories.serverId, serverId))
    .orderBy(asc(channelCategories.position));
  const channelRows = await db
    .select()
    .from(channels)
    .where(eq(channels.serverId, serverId))
    .orderBy(asc(channels.position));

  const memberList: MemberWithUser[] = memberRows.map((row) => ({
    id: row.member.id,
    serverId: row.member.serverId,
    userId: row.member.userId,
    roleId: row.member.roleId,
    joinedAt: row.member.joinedAt.toISOString(),
    user: {
      id: row.user.id,
      username: row.user.username,
      displayName: row.user.displayName,
      avatarUrl: row.user.avatarUrl ?? null,
    },
    presence: {
      userId: row.member.userId,
      status: getPresenceStatus(row.member.userId),
    },
  }));

  const categories: Category[] = categoryRows.map((row) => ({
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    position: row.position,
  }));
  const channelList: Channel[] = channelRows.map((row) => ({
    id: row.id,
    serverId: row.serverId,
    categoryId: row.categoryId,
    name: row.name,
    type: row.type,
    position: row.position,
  }));

  try {
    return serverStateSchema.parse({
      server: {
        id: server.id,
        name: server.name,
        ownerId: server.ownerId,
        createdAt: server.createdAt.toISOString(),
      },
      roles: roleRows.map(toApiRole),
      members: memberList,
      categories,
      channels: channelList,
      voice: [],
      readStates: [],
    });
  } catch {
    throw new HttpError(
      500,
      "SNAPSHOT_FAILED",
      "Failed to build server snapshot",
    );
  }
}

export async function patchServer(
  db: Db,
  userId: string,
  serverId: string,
  patch: { name: string },
): Promise<ServerSummary> {
  const membership = await requireMembership(db, userId, serverId);
  if (!membership.isOwner) {
    throw forbidden("Only the owner can rename the server");
  }
  const rows = await db
    .update(servers)
    .set({ name: patch.name })
    .where(and(eq(servers.id, serverId)))
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw notFound("Server not found");
  }
  return toSummary(row);
}

export async function deleteServer(
  db: Db,
  userId: string,
  serverId: string,
): Promise<void> {
  const membership = await requireMembership(db, userId, serverId);
  if (!membership.isOwner) {
    throw forbidden("Only the owner can delete the server");
  }
  const memberRows = await db
    .select({ userId: members.userId })
    .from(members)
    .where(eq(members.serverId, serverId));
  await db.delete(servers).where(eq(servers.id, serverId));
  for (const row of memberRows) {
    await syncSubscriptions(db, row.userId);
  }
}
