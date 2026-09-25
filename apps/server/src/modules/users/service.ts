import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { User } from "@vitality/shared";
import type { Db } from "../../db/client.js";
import { users, type UserRow } from "../../db/schema.js";
import { HttpError, notFound } from "../../lib/errors.js";
import { sniffFileType } from "../../lib/magic.js";
import { checkUserRateLimit } from "../../lib/rate-limit.js";
import type { UploadStorage } from "../uploads/storage.js";

/** Uploaded avatars are re-encoded to a fixed square PNG. */
export const AVATAR_SIZE = 256;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Reject absurd source images before decoding (decompression bomb guard). */
export const AVATAR_MAX_SOURCE_EDGE = 4096;

const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** `avatars/` prefix keeps avatar blobs out of the attachment key space. */
function avatarStorageKey(): string {
  return `avatars/${randomUUID()}.png`;
}

export function assertAvatarType(buffer: Buffer): void {
  if (buffer.length === 0) {
    throw new HttpError(400, "EMPTY_FILE", "Empty files cannot be uploaded");
  }
  if (buffer.length > AVATAR_MAX_BYTES) {
    throw new HttpError(413, "FILE_TOO_LARGE", "Avatars must be 2 MB or smaller");
  }
  // Magic bytes, never the client MIME/extension: SVG/HTML/GIF are rejected.
  const sniffed = sniffFileType(buffer);
  if (sniffed === null || !ALLOWED_MIMES.has(sniffed.mime)) {
    throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", "Avatar must be PNG, JPEG or WebP");
  }
}

/**
 * Centre-crop to a square and re-encode to a fixed-size PNG. Re-encoding
 * (instead of storing the upload as-is) drops EXIF and any payload smuggled
 * into the original bytes.
 */
export async function resizeAvatar(buffer: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const image = sharp(buffer, { failOn: "error" });
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 1 || height < 1) {
    throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", "Avatar image could not be read");
  }
  if (width > AVATAR_MAX_SOURCE_EDGE || height > AVATAR_MAX_SOURCE_EDGE) {
    throw new HttpError(413, "IMAGE_TOO_LARGE", "Avatar image dimensions are too large");
  }
  return image
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Signed avatar URLs are minted at serialization time, so every place that
 * hands a `User` to a client (auth, member list, WS payloads) shares one
 * signer. Configured once in `buildApp`.
 */
let signer: ((userId: string) => string) | null = null;

export function configureAvatarUrlSigner(next: (userId: string) => string): void {
  signer = next;
}

/**
 * Public avatar URL for a user row: a freshly signed URL for an uploaded
 * avatar, otherwise a manually set external URL, otherwise `null` so clients
 * fall back to the generated default.
 */
export function avatarUrlFor(row: {
  id: string;
  avatarKey: string | null;
  avatarUrl: string | null;
}): string | null {
  if (row.avatarKey === null) {
    return row.avatarUrl;
  }
  if (signer === null) {
    throw new Error("avatar URL signer is not configured");
  }
  return signer(row.id);
}

export function toSafeUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: avatarUrlFor(row),
  };
}

export async function getById(db: Db, id: string): Promise<User> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw notFound("User not found");
  }
  return toSafeUser(row);
}

export async function updateMe(
  db: Db,
  id: string,
  patch: { displayName?: string; avatarUrl?: string | null },
): Promise<User> {
  const rows = await db
    .update(users)
    .set({
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.avatarUrl !== undefined ? { avatarUrl: patch.avatarUrl } : {}),
    })
    .where(eq(users.id, id))
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw notFound("User not found");
  }
  return toSafeUser(row);
}

/** Storage key + mime of the caller's avatar, or null when they have none. */
async function getAvatarRow(
  db: Db,
  userId: string,
): Promise<{ avatarKey: string | null; avatarMime: string | null }> {
  const rows = await db
    .select({ avatarKey: users.avatarKey, avatarMime: users.avatarMime })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw notFound("User not found");
  }
  return row;
}

/**
 * Replace the caller's avatar. Stored bytes are always a re-encoded 256x256
 * PNG, so the previous blob is deleted after the swap (best effort: an
 * orphaned file is harmless, a dangling row would not be).
 */
export async function setMyAvatar(
  db: Db,
  storage: UploadStorage,
  userId: string,
  file: Buffer,
): Promise<User> {
  checkUserRateLimit(`avatar:${userId}`, 10, 60_000);
  assertAvatarType(file);
  const png = await resizeAvatar(file);
  const previous = await getAvatarRow(db, userId);
  const key = avatarStorageKey();
  await storage.save(key, png);
  const rows = await db
    .update(users)
    // A custom avatar supersedes any manually set external avatar URL.
    .set({ avatarKey: key, avatarMime: "image/png", avatarUrl: null })
    .where(eq(users.id, userId))
    .returning();
  const row = rows[0];
  if (row === undefined) {
    await storage.delete(key).catch(() => undefined);
    throw notFound("User not found");
  }
  if (previous.avatarKey !== null) {
    await storage.delete(previous.avatarKey).catch(() => undefined);
  }
  return toSafeUser(row);
}

/** Revert to the generated default avatar. */
export async function removeMyAvatar(
  db: Db,
  storage: UploadStorage,
  userId: string,
): Promise<User> {
  checkUserRateLimit(`avatar:${userId}`, 10, 60_000);
  const previous = await getAvatarRow(db, userId);
  const rows = await db
    .update(users)
    .set({ avatarKey: null, avatarMime: null })
    .where(eq(users.id, userId))
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw notFound("User not found");
  }
  if (previous.avatarKey !== null) {
    await storage.delete(previous.avatarKey).catch(() => undefined);
  }
  return toSafeUser(row);
}

export interface ServedAvatar {
  data: Buffer;
  mime: string;
}

/** Load a user's stored avatar blob (auth is the route's job). */
export async function serveAvatar(
  db: Db,
  storage: UploadStorage,
  userId: string,
): Promise<ServedAvatar> {
  const row = await getAvatarRow(db, userId);
  if (row.avatarKey === null) {
    throw notFound("Avatar not found");
  }
  let data: Buffer;
  try {
    data = await storage.load(row.avatarKey);
  } catch {
    throw new HttpError(500, "FILE_MISSING", "Avatar file is missing");
  }
  return { data, mime: row.avatarMime ?? "image/png" };
}

