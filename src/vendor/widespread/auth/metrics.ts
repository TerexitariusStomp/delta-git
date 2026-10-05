/**
 * Auth failure tracking for brute-force throttling.
 *
 * KV keys are HMAC'd with a pepper so stored counters are not reversible to
 * raw IPs/DIDs even if the namespace is dumped. The pepper is a server secret
 * (e.g. WORKER_SESSION_SECRET); it does not protect against a live compromise
 * of the isolate, but prevents cold-storage key material from being brute-
 * forced (the IPv4 space is ~4B — trivially enumerable without a pepper).
 */
import { bytesToHex } from "../crypto/index.js";
import type { ChallengeStore } from "./challenge.js";

const AUTH_FAILURE_LIMIT = 10;

export async function pepperedHash(value: string, pepper: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return bytesToHex(new Uint8Array(sig).slice(0, 16));
}

/**
 * Record an auth failure for brute-force throttling.
 * Counters are TTL'd (60s) and keyed by peppered hashes — no raw IP or DID
 * is ever stored. Returns true if the threshold has been exceeded.
 */
export async function recordAuthFailure(
  kv: ChallengeStore,
  ip: string,
  did: string | undefined,
  pepper: string
): Promise<boolean> {
  const ipKey = `authfail:ip:${await pepperedHash(ip, pepper)}`;
  const didKey = did ? `authfail:did:${await pepperedHash(did, pepper)}` : null;

  const ipCount = parseInt((await kv.get(ipKey)) || "0", 10) + 1;
  await kv.put(ipKey, String(ipCount), { expirationTtl: 60 });

  if (didKey) {
    const didCount = parseInt((await kv.get(didKey)) || "0", 10) + 1;
    await kv.put(didKey, String(didCount), { expirationTtl: 60 });
    if (didCount >= AUTH_FAILURE_LIMIT) return true;
  }

  return ipCount >= AUTH_FAILURE_LIMIT;
}

const AUTH_FAILURE_WINDOW = 60_000; // 1 minute
export { AUTH_FAILURE_LIMIT, AUTH_FAILURE_WINDOW };
