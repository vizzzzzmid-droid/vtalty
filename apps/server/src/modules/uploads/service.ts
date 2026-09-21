import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { MessageAttachment } from "@vitality/shared";
import type { Db } from "../../db/client.js";
import {
  attachments,
  channels,
  messages,
  type AttachmentRow,
} from "../../db/schema.js";
import { HttpError, badRequest, notFound } from "../../lib/errors.js";
import { isInlineImage, sniffFileType } from "../../lib/magic.js";
import { requireMembership, requirePermission } from "../../lib/permissions.js";
import { checkUserRateLimit } from "../../lib/rate-limit.js";
import type { UploadStorage } from "./storage.js";

export interface UploadedFile {
  buffer: Buffer;
  filename: string;
}

const MAX_FILES_PER_REQUEST = 10;

function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const trimmed = base.trim().slice(0, 255);
  return trimmed.length > 0 ? trimmed : "file";
}

function toApiAttachment(row: AttachmentRow): MessageAttachment {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.bytes,
    url: `/api/v1/attachments/${row.id}`,
    width: row.width,
    height: row.height,
  };
}

export async function uploadFiles(
  db: Db,
  storage: UploadStorage,
  maxBytes: number,
  userId: string,
  channelId: string,
  files: UploadedFile[],
): Promise<MessageAttachment[]> {
  checkUserRateLimit(`upload:${userId}`, 30, 60_000);
  const channelRows = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  const channel = channelRows[0];
  if (channel === undefined) {
    throw notFound("Channel not found");
  }
  await requirePermission(db, userId, channel.serverId, "send_messages");
  if (files.length === 0) {
    throw badRequest("NO_FILES", "No files were uploaded");
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    throw badRequest("TOO_MANY_FILES", "At most 10 files per request");
  }

  const saved: MessageAttachment[] = [];
  for (const file of files) {
    if (file.buffer.length === 0) {
      throw badRequest("EMPTY_FILE", "Empty files cannot be uploaded");
    }
    if (file.buffer.length > maxBytes) {
      throw new HttpError(413, "FILE_TOO_LARGE", "File exceeds the size limit");
    }
    const sniffed = sniffFileType(file.buffer);
    if (sniffed === null) {
      throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", "File type is not allowed");
    }
    const key = `${randomUUID()}.${sniffed.ext}`;
    await storage.save(key, file.buffer);
    try {
      const rows = await db
        .insert(attachments)
        .values({
          messageId: null,
          channelId,
          uploaderId: userId,
          filename: safeFilename(file.filename),
          mime: sniffed.mime,
          bytes: file.buffer.length,
          storageKey: key,
          width: null,
          height: null,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error("attachment insert returned no rows");
      }
      saved.push(toApiAttachment(row));
    } catch (err) {
      await storage.delete(key).catch(() => undefined);
      throw err;
    }
  }
  return saved;
}

export interface ServedAttachment {
  data: Buffer;
  mime: string;
  filename: string;
  inline: boolean;
}

export async function serveAttachment(
  db: Db,
  storage: UploadStorage,
  userId: string,
  attachmentId: string,
): Promise<ServedAttachment> {
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw notFound("Attachment not found");
  }
  if (row.messageId === null) {
    // Unclaimed uploads are visible to the uploader only.
    if (row.uploaderId !== userId) {
      throw notFound("Attachment not found");
    }
  } else {
    const messageRows = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, row.messageId))
      .limit(1);
    const message = messageRows[0];
    if (message === undefined) {
      throw notFound("Attachment not found");
    }
    const channelRows = await db
      .select({ serverId: channels.serverId })
      .from(channels)
      .where(eq(channels.id, message.channelId))
      .limit(1);
    const channel = channelRows[0];
    if (channel === undefined) {
      throw notFound("Attachment not found");
    }
    await requireMembership(db, userId, channel.serverId);
  }
  let data: Buffer;
  try {
    data = await storage.load(row.storageKey);
  } catch {
    throw new HttpError(500, "FILE_MISSING", "Stored file is missing");
  }
  return {
    data,
    mime: row.mime,
    filename: row.filename,
    inline: isInlineImage(row.mime),
  };
}

export interface CleanupSummary {
  deleted: number;
  bytes: number;
}

/**
 * Delete unclaimed uploads (message_id IS NULL, e.g. chips removed before
 * send) older than maxAgeHours. Runs hourly in-process; storage failures
 * for one file do not abort the rest, and the DB row is removed only after
 * the file is gone (a leftover row is re-picked next run).
 */
export async function cleanupOrphanUploads(
  db: Db,
  storage: UploadStorage,
  maxAgeHours: number,
): Promise<CleanupSummary> {
  const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000);  const orphans = await db
    .select()
    .from(attachments)
    .where(and(isNull(attachments.messageId), lt(attachments.createdAt, cutoff)));
  let deleted = 0;
  let bytes = 0;
  for (const row of orphans) {
    try {
      await storage.delete(row.storageKey);
    } catch {
      continue;
    }
    await db.delete(attachments).where(eq(attachments.id, row.id));
    deleted += 1;
    bytes += row.bytes;
  }
  return { deleted, bytes };
}
