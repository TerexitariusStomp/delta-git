import { createPublicClient, http, parseAbiItem } from "viem";
import { base } from "viem/chains";
import type { Env } from "./env";

// USDC watcher: cron scans Base for Transfer(to=deposit) events and credits
// intents matched by unique salted amount (amount-salt attribution).
// USDC has 6 decimals → log value IS micro-USDC.
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export async function scanUsdc(env: Env): Promise<void> {
  const deposit = env.USDC_DEPOSIT_ADDRESS as `0x${string}` | undefined;
  if (!deposit) return;
  const conf = BigInt(env.USDC_CONFIRMATIONS || "3");
  const client = createPublicClient({ chain: base, transport: http(env.USDC_RPC) });
  const latest = (await client.getBlockNumber()) - conf;
  const cursor = await env.DB.prepare("SELECT v FROM meta WHERE k='usdc_scan'").first<{ v: string }>();
  const from = cursor
    ? BigInt(cursor.v) + 1n
    : latest > 5000n ? latest - 5000n : 0n;
  if (from > latest) return;

  const logs = await client.getLogs({
    address: env.USDC_CONTRACT as `0x${string}`,
    event: TRANSFER_EVENT,
    args: { to: deposit },
    fromBlock: from,
    toBlock: latest,
  });

  for (const log of logs) {
    const value = log.args.value;
    if (value === undefined) continue; // undecodable log — skip
    const amountMicro = value.toString();
    const txhash = log.transactionHash;
    const intent = await env.DB.prepare(
      "SELECT id, user_did FROM intents WHERE amount_salt=? AND status='pending' LIMIT 1"
    ).bind(amountMicro).first<{ id: number; user_did: string }>();
    if (!intent) continue; // unsalted/mismatched amount → unattributable, skip
    const r = await env.DB.prepare(
      "INSERT OR IGNORE INTO ledger(user_did, txhash, amount_micro, kind, memo, created_at) VALUES(?,?,?,'deposit','base-usdc',unixepoch())"
    ).bind(intent.user_did, txhash, amountMicro).run();
    if (r.meta.changes === 0) continue; // already processed (replay-safe)
    await env.DB.batch([
      env.DB.prepare("INSERT INTO credits(user_did, balance_micro, updated_at) VALUES(?,?,unixepoch()) ON CONFLICT(user_did) DO UPDATE SET balance_micro=balance_micro+?, updated_at=unixepoch()")
        .bind(intent.user_did, amountMicro, amountMicro),
      env.DB.prepare("UPDATE intents SET status='filled', txhash=? WHERE id=?").bind(txhash, intent.id),
    ]);
  }
  await env.DB.prepare("INSERT INTO meta(k,v) VALUES('usdc_scan',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(String(latest)).run();
}

// Preview lease reaper: expired previews → reclaim (status=expired, purge artifacts)
export async function reapLeases(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expired = await env.DB.prepare(
    "SELECT id FROM sites WHERE lease_expires_at IS NOT NULL AND lease_expires_at < ? AND status='active'"
  ).bind(now).all<{ id: string }>();
  for (const s of expired.results) {
    await env.DB.prepare("UPDATE sites SET status='expired' WHERE id=?").bind(s.id).run();
    // free R2: list+delete artifacts for this site
    let cursor: string | undefined;
    do {
      const listed = await env.ARTIFACTS.list({ prefix: `sites/${s.id}/`, cursor });
      if (listed.objects.length)
        await env.ARTIFACTS.delete(listed.objects.map((o) => o.key));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
}
