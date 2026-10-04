import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { OpLogRow } from "../db/schema";

import { appendOpLog, getLatestOpLogRow } from "../db";

// Hash-chained operation log.
//
// Each row's hash is sha256(prevHash || canonicalEntry), giving the repo a
// tamper-evident audit trail that external observers can replay and verify.
// `payload` must be canonical JSON (stable key order) before hashing.

const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type OpLogEntry = {
  kind: string;
  actor?: string | undefined;
  payload: Record<string, unknown>;
};

/** Append one hash-chained entry; returns the stored row. */
export async function appendOpLogEntry(
  db: DrizzleSqliteDODatabase,
  entry: OpLogEntry,
  now: number
): Promise<OpLogRow> {
  const last = await getLatestOpLogRow(db);
  const seq = (last?.seq ?? -1) + 1;
  const prevHash = last?.hash ?? "genesis";
  const canonical = JSON.stringify({
    seq,
    kind: entry.kind,
    actor: entry.actor ?? null,
    payload: entry.payload,
    createdAt: now,
  });
  const row: OpLogRow = {
    seq,
    hash: await sha256Hex(prevHash + canonical),
    prevHash,
    kind: entry.kind,
    actor: entry.actor ?? null,
    payload: JSON.stringify(entry.payload),
    createdAt: now,
  };
  await appendOpLog(db, row);
  return row;
}
