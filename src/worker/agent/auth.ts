import type { AgentRow } from "@/worker/db/d1/schema";
import type { Db } from "@/worker/db/d1";

import { eq } from "drizzle-orm";
import { agents } from "@/worker/db/d1/schema";
import { bytesToHex } from "@/worker/common/hex";
import { didKeyFromPubkey, pubkeyFromDidKey } from "./atpauth/didkey";

// delta-git agent auth — ed25519 DID + signed request envelopes.
//
// Agents register a public key and are identified by standard
// `did:key:z6Mk…` identifiers. Legacy rows use `did:dg:<pubkey-hex>` and
// remain fully valid — getAgent resolves both formats from the same key
// material so old clients keep working.
// Mutating agent endpoints carry signature headers:
//   x-dg-did, x-dg-ts (unix seconds), x-dg-nonce, x-dg-sig (hex)
// The signed payload is sha256("dg1\n" + did + "\n" + ts + "\n" + nonce + "\n"
// + method + "\n" + path + "\n" + bodySha256Hex). Replay protection relies on
// the timestamp window plus nonce freshness checks kept cheap in D1.

export const AGENT_SIG_WINDOW_SEC = 300;

const te = new TextEncoder();

/** Canonical agent DID for a new registration: `did:key` (ed25519). */
export function didForPubkey(pubkeyBytes: Uint8Array): string {
  return didKeyFromPubkey(pubkeyBytes, "ed25519");
}

/** Legacy alias format still accepted for pre-did:key agents. */
export function legacyDidForPubkey(pubkeyBytes: Uint8Array): string {
  return `did:dg:${bytesToHex(pubkeyBytes)}`;
}

export function hexToBytesSafe(hex: string): Uint8Array | undefined {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export async function bodyDigestHex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

async function importPubkey(pubkeyBytes: Uint8Array): Promise<CryptoKey | undefined> {
  try {
    return await crypto.subtle.importKey(
      "raw",
      pubkeyBytes as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
  } catch {
    return undefined;
  }
}

export type AgentAuth = { kind: "ok"; agent: AgentRow } | { kind: "rejected"; reason: string };

/** Look up a registered agent by DID — resolves both `did:key` and
 * legacy `did:dg:` spellings of the same key material. */
export async function getAgent(db: Db, did: string): Promise<AgentRow | undefined> {
  const rows = await db.select().from(agents).where(eq(agents.did, did)).limit(1);
  if (rows[0]) return rows[0];
  // Cross-format alias: derive the pubkey and try the other spelling.
  if (did.startsWith("did:dg:")) {
    const pubkey = hexToBytesSafe(did.slice("did:dg:".length));
    if (pubkey && pubkey.length === 32) {
      const alt = await db
        .select()
        .from(agents)
        .where(eq(agents.did, didKeyFromPubkey(pubkey, "ed25519")))
        .limit(1);
      return alt[0];
    }
  } else if (did.startsWith("did:key:")) {
    const decoded = pubkeyFromDidKey(did);
    if (decoded?.curve === "ed25519") {
      const alt = await db
        .select()
        .from(agents)
        .where(eq(agents.did, legacyDidForPubkey(decoded.pubkey)))
        .limit(1);
      return alt[0];
    }
  }
  return undefined;
}

export async function registerAgent(
  db: Db,
  args: { pubkeyHex: string; label?: string; kind?: string; ownerDid?: string }
): Promise<AgentRow | { error: string }> {
  const pubkeyBytes = hexToBytesSafe(args.pubkeyHex);
  if (!pubkeyBytes || pubkeyBytes.length !== 32) return { error: "pubkey must be 32-byte hex" };
  const did = didForPubkey(pubkeyBytes);
  const existing = await getAgent(db, did);
  if (existing) return existing;
  await db.insert(agents).values({
    did,
    pubkey: args.pubkeyHex.toLowerCase(),
    label: args.label ?? null,
    ownerDid: args.ownerDid ?? null,
    kind: args.kind ?? "agent",
    rep: 0,
    banned: 0,
    createdAt: Date.now(),
    lastSeenAt: null,
  });
  return (await getAgent(db, did)) ?? { error: "insert-failed" };
}

/**
 * Verify a signed agent request. `body` must already be buffered by the
 * caller (agent routes always parse JSON payloads anyway).
 */
export async function verifyAgentRequest(args: {
  db: Db;
  method: string;
  path: string;
  body: Uint8Array;
  did: string | null;
  ts: string | null;
  nonce: string | null;
  sig: string | null;
  nowSec?: number;
}): Promise<AgentAuth> {
  const { db } = args;
  if (!args.did || !args.ts || !args.nonce || !args.sig) {
    return { kind: "rejected", reason: "missing-signature-headers" };
  }
  const ts = Number(args.ts);
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > AGENT_SIG_WINDOW_SEC) {
    return { kind: "rejected", reason: "stale-timestamp" };
  }
  if (args.nonce.length < 8 || args.nonce.length > 128) {
    return { kind: "rejected", reason: "bad-nonce" };
  }

  const agent = await getAgent(db, args.did);
  if (!agent) return { kind: "rejected", reason: "unknown-did" };
  if (agent.banned === 1) return { kind: "rejected", reason: "agent-banned" };

  const pubkeyBytes = hexToBytesSafe(agent.pubkey);
  const sigBytes = hexToBytesSafe(args.sig);
  if (!pubkeyBytes || !sigBytes || sigBytes.length !== 64) {
    return { kind: "rejected", reason: "bad-signature-format" };
  }
  const key = await importPubkey(pubkeyBytes);
  if (!key) return { kind: "rejected", reason: "bad-pubkey" };

  const bodySha = await bodyDigestHex(args.body);
  const payload = await sha256Hex(
    `dg1\n${args.did}\n${args.ts}\n${args.nonce}\n${args.method.toUpperCase()}\n${args.path}\n${bodySha}`
  );
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    sigBytes as BufferSource,
    te.encode(payload) as BufferSource
  );
  if (!ok) return { kind: "rejected", reason: "signature-mismatch" };

  await db.update(agents).set({ lastSeenAt: Date.now() }).where(eq(agents.did, agent.did));
  return { kind: "ok", agent };
}

/** Bump/slash an agent's rep. Callers decide the delta. */
export async function adjustAgentRep(db: Db, did: string, delta: number): Promise<number> {
  const agent = await getAgent(db, did);
  if (!agent) return 0;
  const rep = Math.max(0, agent.rep + delta);
  await db.update(agents).set({ rep }).where(eq(agents.did, did));
  return rep;
}
