import type { Env } from "./env";
import { planFor } from "./plans";
export { scanUsdc, reapLeases } from "./usdc";

// P1 retention: keep only the newest manifests_keep versions per site
export async function retainManifests(env: Env): Promise<void> {
  const sites = await env.DB.prepare(
    "SELECT s.id, u.plan FROM sites s JOIN users u ON u.did = s.owner_did"
  ).all<{ id: string; plan: string }>();
  for (const s of sites.results) {
    const keep = planFor(s).manifests_keep;
    const stale = await env.DB.prepare(
      "SELECT sha FROM manifests WHERE site_id=? ORDER BY created_at DESC LIMIT -1 OFFSET ?"
    ).bind(s.id, keep).all<{ sha: string }>();
    const current = (await env.DB.prepare("SELECT manifest_sha FROM sites WHERE id=?").bind(s.id).first<{ manifest_sha: string }>())?.manifest_sha;
    for (const m of stale.results) {
      if (m.sha === current) continue; // never delete the live manifest
      await env.ARTIFACTS.delete(
        (await env.ARTIFACTS.list({ prefix: `sites/${s.id}/artifacts/${m.sha}/` })).objects.map((o) => o.key)
      );
      await env.DB.prepare("DELETE FROM manifests WHERE site_id=? AND sha=?").bind(s.id, m.sha).run();
    }
  }
}

// P3 self-heal doctor: probe active sites, suspend-after-fails, record health
export async function healthCheck(env: Env): Promise<void> {
  const sites = await env.DB.prepare("SELECT id, preview_host FROM sites WHERE status='active' AND preview_host IS NOT NULL").all<{ id: string; preview_host: string }>();
  for (const s of sites.results) {
    let status = 0;
    try { status = (await fetch(`https://${s.preview_host}/`, { cf: { cacheTtl: 0 } })).status; } catch {}
    const okNow = status > 0 && status < 500;
    await env.DB.prepare(
      "INSERT INTO health(site_id, last_ok_at, last_status, consecutive_fails) VALUES(?,?,?,?) " +
      "ON CONFLICT(site_id) DO UPDATE SET last_ok_at=CASE WHEN ? THEN unixepoch() ELSE last_ok_at END, last_status=?, consecutive_fails=CASE WHEN ? THEN 0 ELSE consecutive_fails+1 END"
    ).bind(s.id, okNow ? Date.now() / 1000 : null, status, okNow ? 0 : 1, okNow ? 1 : 0, status, okNow ? 1 : 0).run();
  }
}

// P5 Always-On / plan billing: monthly debit, suspend sites at zero balance
export async function debitPlans(env: Env): Promise<void> {
  const users = await env.DB.prepare("SELECT did, plan FROM users WHERE plan<>'creator'").all<{ did: string; plan: string }>();
  for (const u of users.results) {
    const plan = planFor(u);
    const already = await env.DB.prepare(
      "SELECT 1 FROM ledger WHERE user_did=? AND kind='debit' AND memo=? AND created_at>unixepoch()-2592000"
    ).bind(u.did, `plan:${u.plan}`).first();
    if (already) continue;
    const bal = await env.DB.prepare("SELECT balance_micro FROM credits WHERE user_did=?").bind(u.did).first<{ balance_micro: number }>();
    if (!bal || bal.balance_micro < plan.price_micro) {
      // suspend-at-zero: all their sites stop serving until topped up
      await env.DB.prepare("UPDATE sites SET status='suspended' WHERE owner_did=? AND status='active'").bind(u.did).run();
      continue;
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE credits SET balance_micro=balance_micro-?, updated_at=unixepoch() WHERE user_did=?").bind(plan.price_micro, u.did),
      env.DB.prepare("INSERT INTO ledger(user_did, amount_micro, kind, memo, created_at) VALUES(?,?,'debit',?,unixepoch())").bind(u.did, -plan.price_micro, `plan:${u.plan}`),
    ]);
  }
}
