import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { refreshTokens, users, wsTickets } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";

export interface WsTicketClaims {
  userId: string;
  familyId: string;
}

function hashTicket(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Mint a single-use ticket bound to the user and their session family. */
export async function createWsTicket(
  db: Db,
  userId: string,
  familyId: string,
  ttlSeconds: number,
): Promise<string> {
  // Opportunistic cleanup of long-expired tickets.
  await db.delete(wsTickets).where(lt(wsTickets.expiresAt, new Date()));
  const raw = randomBytes(32).toString("base64url");
  await db.insert(wsTickets).values({
    userId,
    familyId,
    ticketHash: hashTicket(raw),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  });
  return raw;
}

/**
 * Atomically consume a ticket. Throws 401 TICKET_INVALID / TICKET_REVOKED.
 * The raw ticket value is never stored and never logged.
 */
export async function consumeWsTicket(
  db: Db,
  raw: string,
): Promise<WsTicketClaims> {
  const claimed = await db
    .update(wsTickets)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(wsTickets.ticketHash, hashTicket(raw)),
        isNull(wsTickets.usedAt),
        gt(wsTickets.expiresAt, new Date()),
      ),
    )
    .returning({ userId: wsTickets.userId, familyId: wsTickets.familyId });
  const ticket = claimed[0];
  if (ticket === undefined) {
    throw new HttpError(401, "TICKET_INVALID", "Invalid or expired ticket");
  }
  // Session binding: the refresh family must still exist. Logout and
  // reuse-revocation delete the whole family, killing its tickets.
  const family = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(eq(refreshTokens.familyId, ticket.familyId))
    .limit(1);
  if (family[0] === undefined) {
    throw new HttpError(401, "TICKET_REVOKED", "Session no longer exists");
  }
  const user = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, ticket.userId))
    .limit(1);
  if (user[0] === undefined) {
    throw new HttpError(401, "TICKET_REVOKED", "User no longer exists");
  }
  return ticket;
}
