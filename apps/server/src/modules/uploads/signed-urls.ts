import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived signed download URLs for attachments ("capability URLs").
 *
 * Browsers cannot attach an Authorization header to a plain <img src> or
 * <a href> load, so the Bearer-protected GET /api/v1/attachments/:id fails
 * for inline rendering. Instead, message/attachment payloads carry a URL
 * with an HMAC signature (`?e=<expiry epoch>&s=<sig>`) that the download
 * route accepts instead of a Bearer token.
 *
 * Security model (same as S3 presigned URLs):
 * - Mint-time access control: signed URLs are only ever embedded into
 *   member-gated payloads (channel history, message broadcasts, the
 *   uploader's own upload response). Outsiders never see one.
 * - Possession = authorization until expiry (ATTACHMENT_URL_TTL_SECONDS).
 *   A member removed from the server keeps working URLs only until they
 *   expire; rotating JWT_ACCESS_SECRET invalidates all URLs at once.
 * - The signature binds the attachment id and expiry, so a URL minted for
 *   one attachment authorizes nothing else.
 */

/** (attachmentId) => signed URL path. */
export type AttachmentUrlSigner = (attachmentId: string) => string;

/**
 * Domain-separated key derived from the JWT access secret: no extra deploy
 * secret to manage, and secret rotation kills outstanding URLs too.
 */
function signingKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("vitality/attachment-url/v1").digest();
}

function sign(key: Buffer, attachmentId: string, expires: number): string {
  return createHmac("sha256", key).update(`${attachmentId}.${expires}`).digest("base64url");
}

/** Build a signed download URL path (relative; same-origin by design). */
export function signAttachmentUrl(
  secret: string,
  attachmentId: string,
  ttlSeconds: number,
  now: Date = new Date(),
): string {
  const expires = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const signature = sign(signingKey(secret), attachmentId, expires);
  return `/api/v1/attachments/${attachmentId}?e=${expires}&s=${signature}`;
}

/** (userId) => signed avatar URL path. */
export type AvatarUrlSigner = (userId: string) => string;

/**
 * Domain-separated key for avatar URLs so an attachment signature can never
 * be replayed as an avatar signature (and vice versa).
 */
function avatarSigningKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("vitality/avatar-url/v1").digest();
}

/** Build a signed avatar URL path (relative; same-origin by design). */
export function signAvatarUrl(
  secret: string,
  userId: string,
  ttlSeconds: number,
  now: Date = new Date(),
): string {
  const expires = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const signature = sign(avatarSigningKey(secret), userId, expires);
  return `/api/v1/users/${userId}/avatar?e=${expires}&s=${signature}`;
}

/** Verify the `e`/`s` query params of a signed avatar URL. */
export function verifyAvatarSignature(
  secret: string,
  userId: string,
  expires: number,
  signature: string,
  now: Date = new Date(),
): boolean {
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now.getTime()) {
    return false;
  }
  const expected = Buffer.from(
    sign(avatarSigningKey(secret), userId, expires),
    "utf8",
  );
  const actual = Buffer.from(signature, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Verify the `e`/`s` query params of a signed download URL. */
export function verifyAttachmentSignature(
  secret: string,
  attachmentId: string,
  expires: number,
  signature: string,
  now: Date = new Date(),
): boolean {
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now.getTime()) {
    return false;
  }
  const expected = Buffer.from(sign(signingKey(secret), attachmentId, expires), "utf8");
  const actual = Buffer.from(signature, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
