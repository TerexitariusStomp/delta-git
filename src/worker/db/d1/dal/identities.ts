import { eq } from "drizzle-orm";

import type { Db } from "@/worker/db/d1/client";
import {
  didSessions,
  identities,
  type DidSessionRow,
  type IdentityRow,
} from "@/worker/db/d1/schema/identities";
import { users, type UserRow } from "@/worker/db/d1/schema/users";

// atproto identity DAL — identities bridge to `users` rows so the existing
// namespace_memberships / PAT / repo ACL machinery applies unchanged to
// DID-session principals.

export async function findIdentityByDid(db: Db, did: string): Promise<IdentityRow | undefined> {
  const rows = await db.select().from(identities).where(eq(identities.did, did)).limit(1);
  return rows[0];
}

export async function findIdentityByHandle(
  db: Db,
  handle: string
): Promise<IdentityRow | undefined> {
  const rows = await db
    .select()
    .from(identities)
    .where(eq(identities.handle, handle.toLowerCase()))
    .limit(1);
  return rows[0];
}

/** Reverse bridge: session user id → DID identity (for reputation keys). */
export async function findIdentityByUserId(
  db: Db,
  userId: string
): Promise<IdentityRow | undefined> {
  const rows = await db.select().from(identities).where(eq(identities.userId, userId)).limit(1);
  return rows[0];
}

async function findUserBySub(db: Db, sub: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.tesseraSub, sub)).limit(1);
  return rows[0];
}

/**
 * Ensure an identity + bridged users row exist for a verified DID.
 * The users row's `tesseraSub` is the DID itself — DID sign-in reuses the
 * same principal type as tessera sign-in.
 */
export async function ensureIdentity(
  db: Db,
  args: { did: string; handle?: string; deviceKeys?: string }
): Promise<IdentityRow> {
  const existing = await findIdentityByDid(db, args.did);
  const handle = args.handle?.toLowerCase() ?? null;
  if (existing) {
    if (handle && handle !== existing.handle) {
      await db
        .update(identities)
        .set({ handle, updatedAt: Date.now() })
        .where(eq(identities.did, args.did));
      existing.handle = handle;
    }
    return existing;
  }

  let user = await findUserBySub(db, args.did);
  if (!user) {
    const now = Date.now();
    const inserted = await db
      .insert(users)
      .values({ id: crypto.randomUUID(), tesseraSub: args.did, createdAt: now })
      .onConflictDoNothing()
      .returning();
    user = inserted[0] ?? (await findUserBySub(db, args.did));
  }
  if (!user) throw new Error("identity bridge user insert failed");

  const now = Date.now();
  const row: IdentityRow = {
    did: args.did,
    userId: user.id,
    handle,
    deviceKeys: args.deviceKeys ?? "[]",
    rep: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(identities).values(row).onConflictDoNothing();
  return (await findIdentityByDid(db, args.did)) ?? row;
}

export async function updateIdentityDeviceKeys(
  db: Db,
  did: string,
  deviceKeys: string
): Promise<void> {
  await db
    .update(identities)
    .set({ deviceKeys, updatedAt: Date.now() })
    .where(eq(identities.did, did));
}

// ---------------------------------------------------------------------------
// Sessions (revocation authority for the dg_session cookie)
// ---------------------------------------------------------------------------

export async function insertDidSession(
  db: Db,
  row: { jti: string; did: string; dpopJkt?: string | null; expiresAt: number }
): Promise<void> {
  await db.insert(didSessions).values({
    jti: row.jti,
    did: row.did,
    dpopJkt: row.dpopJkt ?? null,
    expiresAt: row.expiresAt,
    revokedAt: null,
    createdAt: Date.now(),
  });
}

/** Returns the session only if live (not revoked, not expired). */
export async function findLiveDidSession(db: Db, jti: string): Promise<DidSessionRow | undefined> {
  const rows = await db.select().from(didSessions).where(eq(didSessions.jti, jti)).limit(1);
  const row = rows[0];
  if (!row || row.revokedAt !== null || row.expiresAt < Date.now()) return undefined;
  return row;
}

export async function revokeDidSession(db: Db, jti: string): Promise<void> {
  await db.update(didSessions).set({ revokedAt: Date.now() }).where(eq(didSessions.jti, jti));
}

/** All live (unrevoked, unexpired) sessions for a DID — GitHub's "Sessions" list. */
export async function listLiveDidSessions(db: Db, did: string): Promise<DidSessionRow[]> {
  const rows = await db.select().from(didSessions).where(eq(didSessions.did, did));
  const now = Date.now();
  return rows.filter((r) => r.revokedAt === null && r.expiresAt > now);
}

/** Revoke only when the session belongs to `did` — ownership-scoped revoke. */
export async function revokeDidSessionIfOwned(
  db: Db,
  jti: string,
  did: string
): Promise<DidSessionRow | undefined> {
  const rows = await db.select().from(didSessions).where(eq(didSessions.jti, jti)).limit(1);
  const row = rows[0];
  if (!row || row.did !== did) return undefined;
  await db.update(didSessions).set({ revokedAt: Date.now() }).where(eq(didSessions.jti, jti));
  return row;
}
