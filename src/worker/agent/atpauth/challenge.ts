// DID sign-in challenge nonces (vendored from widespread auth challenge.ts).
//
// Challenges live in KV under `didnonce:<nonce>` with a 5-minute TTL and
// are consumed (deleted) exactly once — replaying a verify request with
// the same nonce fails closed.

const NONCE_PREFIX = "didnonce:";
const NONCE_TTL_SEC = 300;

export async function issueChallenge(
  kv: KVNamespace
): Promise<{ nonce: string; expiresAt: number }> {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = Date.now() + NONCE_TTL_SEC * 1000;
  await kv.put(`${NONCE_PREFIX}${nonce}`, "1", { expirationTtl: NONCE_TTL_SEC });
  return { nonce, expiresAt };
}

/** Single-use consume: returns true only on first read of a live nonce. */
export async function consumeChallenge(kv: KVNamespace, nonce: string): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(nonce)) return false;
  const key = `${NONCE_PREFIX}${nonce}`;
  const existing = await kv.get(key);
  if (existing === null) return false;
  await kv.delete(key);
  return true;
}
