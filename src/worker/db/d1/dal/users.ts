import { eq } from "drizzle-orm";

import type { Db } from "@/worker/db/d1/client";
import { type NewUserRow, type UserRow, users } from "@/worker/db/d1/schema/users";

export async function findUserById(db: Db, id: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0];
}

export async function findUserByTesseraSub(
  db: Db,
  tesseraSub: string
): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.tesseraSub, tesseraSub)).limit(1);
  return rows[0];
}

// Insert a fresh user row. Returns the inserted row when this call won the
// race; returns undefined when an existing row already had the same
// `tessera_sub`. Callers combine this with `findUserByTesseraSub` to obtain
// the canonical row in either case (see `auth/session` first-login flow).
export async function insertUserIfNew(db: Db, row: NewUserRow): Promise<UserRow | undefined> {
  const inserted = await db.insert(users).values(row).onConflictDoNothing().returning();
  return inserted[0];
}

/**
 * Delete a user row outright. Callers must ensure every namespace the user
 * owns is already removed — the cascade would take memberships and tokens
 * with it, which is intended, but orphaned namespaces are not.
 */
export async function deleteUserRow(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
  return rows.length > 0;
}
