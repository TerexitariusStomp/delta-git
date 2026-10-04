import type { Env } from "./env";

// USDC watcher: cron scans Base for Transfer(to=deposit) events and credits
// intents matched by unique salted amount (amount-salt attribution).
// USDC has 6 decimals → log value IS micro-USDC.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function rpc(env: Env, method: string, params: unknown[]): Promise<any> {
  const r = await fetch(env.USDC_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const j = await r.json() as any;
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

export async function scanUsdc(env: Env): Promise<void> {
  const deposit = env.USDC_DEPOSIT_ADDRESS;
  if (!deposit) return;
  const conf = parseInt(env.USDC_CONFIRMATIONS || "3");
  const latest = parseInt(await rpc(env, "eth_blockNumber", []), 16) - conf;
  const cursor = await env.DB.prepare("SELECT v FROM meta WHERE k='usdc_scan'").first<{ v: string }>();
  const from = cursor ? parseInt(cursor.v) + 1 : Math.max(0, latest - 5000);
  if (from > latest) return;

  const logs = await rpc(env, "eth_getLogs", [{
    address: env.USDC_CONTRACT,
    topics: [TRANSFER_TOPIC, null, "0x" + deposit.toLowerCase().replace("0x", "").padStart(64, "0")],
    fromBlock: "0x" + from.toString(16),
    toBlock: "0x" + latest.toString(16),
  }]);

  for (const log of logs ?? []) {
    const amountMicro = BigInt(log.data).toString();
    const txhash = log.transactionHash as string;
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
