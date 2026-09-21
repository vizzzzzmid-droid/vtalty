import { eq } from "drizzle-orm";
import type { User } from "@vitality/shared";
import type { Db } from "../../db/client.js";
import { users, type UserRow } from "../../db/schema.js";
import { notFound } from "../../lib/errors.js";

export function toSafeUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl ?? null,
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
