import { and, count, eq, max } from "drizzle-orm";
import type {
  Category,
  Channel,
  ChannelType,
} from "@vitality/shared";
import type { Db } from "../../db/client.js";
import {
  channelCategories,
  channels,
  type CategoryRow,
  type ChannelRow,
} from "../../db/schema.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { requirePermission } from "../../lib/permissions.js";
import { broadcastToServers } from "../../ws/hub.js";

function toApiCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    position: row.position,
  };
}

function toApiChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    serverId: row.serverId,
    categoryId: row.categoryId,
    name: row.name,
    type: row.type as ChannelType,
    position: row.position,
  };
}

async function nextCategoryPosition(db: Db, serverId: string): Promise<number> {
  const rows = await db
    .select({ value: max(channelCategories.position) })
    .from(channelCategories)
    .where(eq(channelCategories.serverId, serverId));
  return (rows[0]?.value ?? -1) + 1;
}

async function nextChannelPosition(db: Db, serverId: string): Promise<number> {
  const rows = await db
    .select({ value: max(channels.position) })
    .from(channels)
    .where(eq(channels.serverId, serverId));
  return (rows[0]?.value ?? -1) + 1;
}

export async function createCategory(
  db: Db,
  actorId: string,
  serverId: string,
  name: string,
): Promise<Category> {
  await requirePermission(db, actorId, serverId, "manage_channels");
  const rows = await db
    .insert(channelCategories)
    .values({ serverId, name, position: await nextCategoryPosition(db, serverId) })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("category insert returned no rows");
  }
  const category = toApiCategory(row);
  broadcastToServers([serverId], "category.create", { category });
  return category;
}

export async function patchCategory(
  db: Db,
  actorId: string,
  categoryId: string,
  patch: { name?: string; position?: number },
): Promise<Category> {
  const existing = await db
    .select()
    .from(channelCategories)
    .where(eq(channelCategories.id, categoryId))
    .limit(1);
  const row = existing[0];
  if (row === undefined) {
    throw notFound("Category not found");
  }
  await requirePermission(db, actorId, row.serverId, "manage_channels");
  const updated = await db
    .update(channelCategories)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
    })
    .where(eq(channelCategories.id, categoryId))
    .returning();
  const next = updated[0];
  if (next === undefined) {
    throw notFound("Category not found");
  }
  const category = toApiCategory(next);
  broadcastToServers([row.serverId], "category.update", { category });
  return category;
}

export async function deleteCategory(
  db: Db,
  actorId: string,
  categoryId: string,
): Promise<void> {
  const existing = await db
    .select()
    .from(channelCategories)
    .where(eq(channelCategories.id, categoryId))
    .limit(1);
  const row = existing[0];
  if (row === undefined) {
    throw notFound("Category not found");
  }
  await requirePermission(db, actorId, row.serverId, "manage_channels");
  const countRows = await db
    .select({ value: count() })
    .from(channels)
    .where(eq(channels.categoryId, categoryId));
  const channelCount = countRows[0]?.value ?? 0;
  if (channelCount > 0) {
    throw conflict(
      "CATEGORY_NOT_EMPTY",
      "Move or delete the channels first",
    );
  }
  await db.delete(channelCategories).where(eq(channelCategories.id, categoryId));
  broadcastToServers([row.serverId], "category.delete", {
    serverId: row.serverId,
    categoryId,
  });
}

async function assertCategoryInServer(
  db: Db,
  serverId: string,
  categoryId: string,
): Promise<void> {
  const rows = await db
    .select({ id: channelCategories.id })
    .from(channelCategories)
    .where(
      and(
        eq(channelCategories.id, categoryId),
        eq(channelCategories.serverId, serverId),
      ),
    )
    .limit(1);
  if (rows[0] === undefined) {
    throw badRequest("INVALID_CATEGORY", "Category does not belong to this server");
  }
}

export async function createChannel(
  db: Db,
  actorId: string,
  serverId: string,
  input: { name: string; type: ChannelType; categoryId?: string | null },
): Promise<Channel> {
  await requirePermission(db, actorId, serverId, "manage_channels");
  if (input.categoryId !== undefined && input.categoryId !== null) {
    await assertCategoryInServer(db, serverId, input.categoryId);
  }
  const rows = await db
    .insert(channels)
    .values({
      serverId,
      name: input.name,
      type: input.type,
      categoryId: input.categoryId ?? null,
      position: await nextChannelPosition(db, serverId),
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("channel insert returned no rows");
  }
  const channel = toApiChannel(row);
  broadcastToServers([serverId], "channel.create", { channel });
  return channel;
}

async function findChannelOr404(db: Db, channelId: string): Promise<ChannelRow> {
  const rows = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw notFound("Channel not found");
  }
  return row;
}

export async function patchChannel(
  db: Db,
  actorId: string,
  channelId: string,
  patch: { name?: string; position?: number; categoryId?: string | null },
): Promise<Channel> {
  const existing = await findChannelOr404(db, channelId);
  await requirePermission(db, actorId, existing.serverId, "manage_channels");
  if (patch.categoryId !== undefined && patch.categoryId !== null) {
    await assertCategoryInServer(db, existing.serverId, patch.categoryId);
  }
  const updated = await db
    .update(channels)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
    })
    .where(eq(channels.id, channelId))
    .returning();
  const next = updated[0];
  if (next === undefined) {
    throw notFound("Channel not found");
  }
  const channel = toApiChannel(next);
  broadcastToServers([existing.serverId], "channel.update", { channel });
  return channel;
}

export async function deleteChannel(
  db: Db,
  actorId: string,
  channelId: string,
): Promise<void> {
  const existing = await findChannelOr404(db, channelId);
  await requirePermission(db, actorId, existing.serverId, "manage_channels");
  await db.delete(channels).where(eq(channels.id, channelId));
  broadcastToServers([existing.serverId], "channel.delete", {
    serverId: existing.serverId,
    channelId,
  });
}

/** Resolve the owning server of a channel (used by the WS typing relay). */
export async function getChannelServerId(
  db: Db,
  channelId: string,
): Promise<string | null> {
  const rows = await db
    .select({ serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  return rows[0]?.serverId ?? null;
}
