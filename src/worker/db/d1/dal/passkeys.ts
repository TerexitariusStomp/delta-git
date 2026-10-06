import { and, desc, eq } from "drizzle-orm";

import type { Db } from "../client";
import { passkeys, type NewPasskeyRow, type PasskeyRow } from "../schema/passkeys";

export async function listPasskeys(db: Db, userId: string): Promise<PasskeyRow[]> {
  return await db
    .select()
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(desc(passkeys.createdAt));
}

export async function findPasskeyByCredential(
  db: Db,
  credentialId: string
): Promise<PasskeyRow | undefined> {
  const rows = await db
    .select()
    .from(passkeys)
    .where(eq(passkeys.credentialId, credentialId))
    .limit(1);
  return rows[0];
}

export async function insertPasskey(db: Db, row: NewPasskeyRow): Promise<void> {
  await db.insert(passkeys).values(row);
}

export async function updatePasskeyCounter(
  db: Db,
  credentialId: string,
  counter: number
): Promise<void> {
  await db
    .update(passkeys)
    .set({ counter, lastUsedAt: Date.now() })
    .where(eq(passkeys.credentialId, credentialId));
}

export async function deletePasskey(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db
    .delete(passkeys)
    .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)));
  return (result.meta?.changes ?? 0) > 0;
}
