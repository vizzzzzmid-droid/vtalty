import { ulid } from "ulid";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
} from "drizzle-orm";
import {
  messageSchema,
  MENTION_PATTERN_SOURCE,
  type ChatMessage,
  type CreateMessageBody,
  type HistoryQuery,
  type UnreadEntry,
} from "@vitality/shared";
import type { Db, DbOrTx } from "../../db/client.js";
import {
  attachments,
  channels,
  members,
  messageMentions,
  messages,
  readStates,
  users,
  type ChannelRow,
  type MessageRow,
} from "../../db/schema.js";
import {
  badRequest,
  forbidden,
  notFound,
} from "../../lib/errors.js";
import {
  getMembership,
  requireMembership,
  requirePermission,
} from "../../lib/permissions.js";
import { checkUserRateLimit } from "../../lib/rate-limit.js";
import type { AttachmentUrlSigner } from "../uploads/signed-urls.js";
import { broadcastToServers } from "../../ws/hub.js";

const MENTION_RE = new RegExp(MENTION_PATTERN_SOURCE, "g");

/** Extract unique @usernames from content (pure, unit-tested). */
export function extractMentionUsernames(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(MENTION_RE)) {
    const name = match[1];
    if (name !== undefined) {
      found.add(name);
    }
  }
  return [...found];
}

async function findChannelOr404(db: DbOrTx, channelId: string): Promise<ChannelRow> {
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

async function resolveMentionIds(
  tx: DbOrTx,
  serverId: string,
  authorId: string,
  content: string,
): Promise<string[]> {
  const names = extractMentionUsernames(content);
  if (names.length === 0) {
    return [];
  }
  // Resolve against members of this server only (no cross-server leaks).
  const memberNames = await tx
    .select({ userId: members.userId, username: users.username })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(eq(members.serverId, serverId));
  const wanted = new Set(names);
  const ids: string[] = [];
  for (const row of memberNames) {
    if (wanted.has(row.username) && row.userId !== authorId && !ids.includes(row.userId)) {
      ids.push(row.userId);
    }
  }
  return ids;
}

async function hydrateMessages(
  db: DbOrTx,
  rows: MessageRow[],
  signUrl: AttachmentUrlSigner,
): Promise<ChatMessage[]> {
  if (rows.length === 0) {
    return [];
  }
  const ids = rows.map((row) => row.id);
  const authorIds = [...new Set(rows.map((row) => row.authorId))];
  const [attachRows, mentionRows] = await Promise.all([
    db.select().from(attachments).where(inArray(attachments.messageId, ids)),
    db.select().from(messageMentions).where(inArray(messageMentions.messageId, ids)),
    // Authors resolve client-side from the server snapshot (all members).
    Promise.resolve(authorIds),
  ]);
  const attachByMessage = new Map<string, typeof attachRows>();
  for (const row of attachRows) {
    if (row.messageId === null) {
      continue;
    }
    const list = attachByMessage.get(row.messageId) ?? [];
    list.push(row);
    attachByMessage.set(row.messageId, list);
  }
  const mentionsByMessage = new Map<string, string[]>();
  for (const row of mentionRows) {
    const list = mentionsByMessage.get(row.messageId) ?? [];
    list.push(row.userId);
    mentionsByMessage.set(row.messageId, list);
  }
  return rows.map((row) =>
    messageSchema.parse({
      id: row.id,
      channelId: row.channelId,
      authorId: row.authorId,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt ? row.editedAt.toISOString() : null,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      attachments: (attachByMessage.get(row.id) ?? []).map((attach) => ({
        id: attach.id,
        filename: attach.filename,
        mime: attach.mime,
        size: attach.bytes,
        // Signed capability URL: works in plain <img src>/<a href> loads
        // (no Authorization header possible there). Broadcast-safe — the
        // HMAC carries no user identity.
        url: signUrl(attach.id),
        width: attach.width,
        height: attach.height,
      })),
      mentions: mentionsByMessage.get(row.id) ?? [],
    }),
  );
}

export async function sendMessage(
  db: Db,
  userId: string,
  channelId: string,
  input: CreateMessageBody,
  signUrl: AttachmentUrlSigner,
): Promise<ChatMessage> {
  checkUserRateLimit(`send:${userId}`, 30, 60_000);
  const channel = await findChannelOr404(db, channelId);
  if (channel.type !== "text") {
    throw badRequest("NOT_TEXT_CHANNEL", "Messages can only be sent to text channels");
  }
  await requirePermission(db, userId, channel.serverId, "send_messages");
  const attachmentIds = input.attachmentIds ?? [];
  if (input.content.trim().length === 0 && attachmentIds.length === 0) {
    throw badRequest("EMPTY_MESSAGE", "Message needs text or attachments");
  }

  return db.transaction(async (tx) => {
    const id = ulid();
    await tx.insert(messages).values({
      id,
      channelId,
      authorId: userId,
      content: input.content,
    });
    if (attachmentIds.length > 0) {
      const claimed = await tx
        .update(attachments)
        .set({ messageId: id })
        .where(
          and(
            inArray(attachments.id, attachmentIds),
            eq(attachments.uploaderId, userId),
            isNull(attachments.messageId),
            eq(attachments.channelId, channelId),
          ),
        )
        .returning({ id: attachments.id });
      if (claimed.length !== attachmentIds.length) {
        throw badRequest(
          "INVALID_ATTACHMENTS",
          "Attachments must be your own unclaimed uploads for this channel",
        );
      }
    }
    const mentionedIds = await resolveMentionIds(tx, channel.serverId, userId, input.content);
    if (mentionedIds.length > 0) {
      await tx
        .insert(messageMentions)
        .values(mentionedIds.map((mentionedId) => ({ messageId: id, userId: mentionedId })));
    }
    const rows = await tx.select().from(messages).where(eq(messages.id, id));
    const hydrated = await hydrateMessages(tx, rows, signUrl);
    const message = hydrated[0];
    if (message === undefined) {
      throw new Error("message insert returned no rows");
    }
    // MVP channel model: every server member has access to every channel,
    // so a server broadcast reaches exactly the authorized audience.
    broadcastToServers([channel.serverId], "message.create", {
      channelId,
      message,
    });
    return message;
  });
}

export interface HistoryPage {
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export async function getHistory(
  db: Db,
  userId: string,
  channelId: string,
  query: HistoryQuery,
  signUrl: AttachmentUrlSigner,
): Promise<HistoryPage> {
  const channel = await findChannelOr404(db, channelId);
  await requireMembership(db, userId, channel.serverId);
  const limit = query.limit ?? 30;
  const visible = and(
    eq(messages.channelId, channelId),
    isNull(messages.deletedAt),
  );

  if (query.around !== undefined) {
    // Window of `limit` messages containing the anchor, biased toward older
    // context (chat "jump to message" shows what led here): the anchor plus
    // older messages fill the older side, the remainder goes newer.
    const newerCount = Math.floor((limit - 1) / 2);
    const olderCount = limit - newerCount;
    const newer = await db
      .select()
      .from(messages)
      .where(and(visible, gt(messages.id, query.around)))
      .orderBy(asc(messages.id))
      .limit(newerCount + 1);
    const older = await db
      .select()
      .from(messages)
      .where(and(visible, lte(messages.id, query.around)))
      .orderBy(desc(messages.id))
      .limit(olderCount + 1);
    const merged = [
      ...older.slice(0, olderCount).reverse(),
      ...newer.slice(0, newerCount),
    ];
    return {
      messages: await hydrateMessages(db, merged, signUrl),
      hasMoreBefore: older.length > olderCount,
      hasMoreAfter: newer.length > newerCount,
    };
  }

  if (query.after !== undefined) {
    const rows = await db
      .select()
      .from(messages)
      .where(and(visible, gt(messages.id, query.after)))
      .orderBy(asc(messages.id))
      .limit(limit + 1);
    return {
      messages: await hydrateMessages(db, rows.slice(0, limit), signUrl),
      hasMoreBefore: true,
      hasMoreAfter: rows.length > limit,
    };
  }

  const condition =
    query.before !== undefined ? and(visible, lt(messages.id, query.before)) : visible;
  const rows = await db
    .select()
    .from(messages)
    .where(condition)
    .orderBy(desc(messages.id))
    .limit(limit + 1);
  return {
    messages: await hydrateMessages(db, rows.slice(0, limit).reverse(), signUrl),
    hasMoreBefore: rows.length > limit,
    hasMoreAfter: query.before !== undefined,
  };
}

async function findMessageOr404(db: DbOrTx, messageId: string): Promise<MessageRow> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.deletedAt !== null) {
    throw notFound("Message not found");
  }
  return row;
}

export async function editMessage(
  db: Db,
  userId: string,
  messageId: string,
  content: string,
  signUrl: AttachmentUrlSigner,
): Promise<ChatMessage> {
  const existing = await findMessageOr404(db, messageId);
  if (existing.authorId !== userId) {
    throw forbidden("Only the author can edit a message");
  }
  const channel = await findChannelOr404(db, existing.channelId);
  const updated = await db.transaction(async (tx) => {
    await tx
      .update(messages)
      .set({ content, editedAt: new Date() })
      .where(eq(messages.id, messageId));
    await tx.delete(messageMentions).where(eq(messageMentions.messageId, messageId));
    const mentionedIds = await resolveMentionIds(tx, channel.serverId, userId, content);
    if (mentionedIds.length > 0) {
      await tx
        .insert(messageMentions)
        .values(mentionedIds.map((mentionedId) => ({ messageId, userId: mentionedId })));
    }
    const rows = await tx.select().from(messages).where(eq(messages.id, messageId));
    return hydrateMessages(tx, rows, signUrl);
  });
  const message = updated[0];
  if (message === undefined) {
    throw new Error("message update returned no rows");
  }
  broadcastToServers([channel.serverId], "message.update", {
    channelId: channel.id,
    message,
  });
  return message;
}

export async function deleteMessage(
  db: Db,
  userId: string,
  messageId: string,
): Promise<{ channelId: string; serverId: string }> {
  const existing = await findMessageOr404(db, messageId);
  const channel = await findChannelOr404(db, existing.channelId);
  const membership = await getMembership(db, userId, channel.serverId);
  const canModerate =
    membership !== null &&
    (membership.isOwner || membership.roleName === "admin");
  if (existing.authorId !== userId && !canModerate) {
    throw forbidden("Only the author or an admin can delete a message");
  }
  await db
    .update(messages)
    .set({ deletedAt: new Date() })
    .where(eq(messages.id, messageId));
  broadcastToServers([channel.serverId], "message.delete", {
    channelId: channel.id,
    messageId,
  });
  return { channelId: channel.id, serverId: channel.serverId };
}

export async function markRead(
  db: Db,
  userId: string,
  channelId: string,
  lastReadMessageId: string,
): Promise<void> {
  const channel = await findChannelOr404(db, channelId);
  await requireMembership(db, userId, channel.serverId);
  const target = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.id, lastReadMessageId),
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
      ),
    )
    .limit(1);
  if (target[0] === undefined) {
    throw notFound("Message not found in this channel");
  }
  const existing = await db
    .select()
    .from(readStates)
    .where(
      and(eq(readStates.userId, userId), eq(readStates.channelId, channelId)),
    )
    .limit(1);
  const current = existing[0];
  if (current === undefined) {
    await db.insert(readStates).values({ userId, channelId, lastReadMessageId });
    return;
  }
  // ULIDs sort lexicographically: only move the cursor forward.
  if (
    current.lastReadMessageId === null ||
    lastReadMessageId > current.lastReadMessageId
  ) {
    await db
      .update(readStates)
      .set({ lastReadMessageId, updatedAt: new Date() })
      .where(
        and(eq(readStates.userId, userId), eq(readStates.channelId, channelId)),
      );
  }
}

export async function getUnread(
  db: Db,
  userId: string,
  serverId: string,
): Promise<UnreadEntry[]> {
  await requireMembership(db, userId, serverId);
  const textChannels = await db
    .select()
    .from(channels)
    .where(and(eq(channels.serverId, serverId), eq(channels.type, "text")));
  if (textChannels.length === 0) {
    return [];
  }
  const reads = await db
    .select()
    .from(readStates)
    .where(
      and(
        eq(readStates.userId, userId),
        inArray(
          readStates.channelId,
          textChannels.map((channel) => channel.id),
        ),
      ),
    );
  const cursors = new Map(
    reads.map((row) => [row.channelId, row.lastReadMessageId ?? ""]),
  );
  const entries: UnreadEntry[] = [];
  for (const channel of textChannels) {
    const cursor = cursors.get(channel.id) ?? "";
    const latest = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, channel.id), isNull(messages.deletedAt)))
      .orderBy(desc(messages.id))
      .limit(1);
    const latestId = latest[0]?.id ?? null;
    let unreadCount = 0;
    let mentionCount = 0;
    if (latestId !== null && latestId > cursor) {
      const unread = await db
        .select({ value: count() })
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channel.id),
            isNull(messages.deletedAt),
            gt(messages.id, cursor),
          ),
        );
      unreadCount = unread[0]?.value ?? 0;
      const mentioned = await db
        .select({ value: count() })
        .from(messageMentions)
        .innerJoin(messages, eq(messageMentions.messageId, messages.id))
        .where(
          and(
            eq(messages.channelId, channel.id),
            eq(messageMentions.userId, userId),
            isNull(messages.deletedAt),
            gt(messages.id, cursor),
          ),
        );
      mentionCount = mentioned[0]?.value ?? 0;
    }
    entries.push({
      channelId: channel.id,
      unreadCount,
      mentionCount,
      latestMessageId: latestId,
    });
  }
  return entries;
}
