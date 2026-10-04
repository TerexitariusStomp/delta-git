import { Router } from "itty-router";
import type { Env } from "./env";
import { whoami } from "./auth";
import { PLANS, planFor } from "./plans";

export const admin = Router();
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

async function auth(req: Request, env: Env) {
  const did = await whoami(env, req);
  return did ?? json({ error: "unauthorized" }, 401);
}

async function audit(env: Env, did: string, site_id: string | null, action: string, detail = "") {
  await env.DB.prepare("INSERT INTO audit(user_did, site_id, action, detail, created_at) VALUES(?,?,?,?,unixepoch())")
    .bind(did, site_id, action, detail).run();
}

// P1: suspend / resume / archive
admin.post("/api/sites/:id/status", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const { status } = await req.json() as { status: string };
  if (!["active", "suspended", "archived"].includes(status)) return json({ error: "bad status" }, 400);
  const r = await env.DB.prepare("UPDATE sites SET status=? WHERE id=? AND owner_did=?").bind(status, req.params!.id, did).run();
  if (!r.meta.changes) return json({ error: "not found" }, 404);
  await audit(env, did, req.params!.id, `site.${status}`);
  return json({ ok: true, status });
});

// P3: fork — clone a site's current manifest into a new preview site
admin.post("/api/sites/:id/fork", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const src = await env.DB.prepare("SELECT * FROM sites WHERE id=?").bind(req.params!.id).first<any>();
  if (!src?.manifest_sha) return json({ error: "nothing to fork" }, 404);
  const user = await env.DB.prepare("SELECT plan FROM users WHERE did=?").bind(did).first<{ plan: string }>();
  if (!(await underSiteQuota(env, did, planFor(user)))) return json({ error: "site_quota" }, 402);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const host = `preview-${id}.${env.SITE_HOST_SUFFIX}`;
  await env.DB.prepare(
    "INSERT INTO sites(id, owner_did, lane, preview_host, lease_expires_at, manifest_sha, source, created_at) VALUES(?,?,?,?,?,?,'fork',unixepoch())"
  ).bind(id, did, src.lane, host, Math.floor(Date.now() / 1000) + 7 * 86400, src.manifest_sha).run();
  // fork shares the same artifact prefix — R2 objects keyed by SHA are immutable
  await env.DB.prepare("INSERT INTO manifests(site_id, sha, file_count, bytes_total, created_at) SELECT ?, sha, file_count, bytes_total, unixepoch() FROM manifests WHERE site_id=? AND sha=?")
    .bind(id, src.id, src.manifest_sha).run();
  await audit(env, did, id, "site.fork", `from ${src.id}@${src.manifest_sha.slice(0, 8)}`);
  return json({ id, preview_host: host, forked_from: src.id });
});

// P5: plan upgrade — debit prepaid balance monthly-equivalent upfront
admin.post("/api/plan", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const { plan } = await req.json() as { plan: string };
  const target = PLANS[plan];
  if (!target) return json({ error: "bad plan" }, 400);
  const bal = await env.DB.prepare("SELECT balance_micro FROM credits WHERE user_did=?").bind(did).first<{ balance_micro: number }>();
  if (!bal || bal.balance_micro < target.price_micro)
    return json({ error: "insufficient_credit", needed_micro: target.price_micro }, 402);
  await env.DB.batch([
    env.DB.prepare("UPDATE credits SET balance_micro=balance_micro-?, updated_at=unixepoch() WHERE user_did=?").bind(target.price_micro, did),
    env.DB.prepare("INSERT INTO ledger(user_did, amount_micro, kind, memo, created_at) VALUES(?,?,'debit',?,unixepoch())").bind(did, -target.price_micro, `plan:${plan}`),
    env.DB.prepare("UPDATE users SET plan=? WHERE did=?").bind(plan, did),
  ]);
  await audit(env, did, null, "plan.upgrade", plan);
  return json({ ok: true, plan });
});

// P4: referral attach on signup
admin.post("/api/referral", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const { code } = await req.json() as { code: string };
  const referrer = await env.DB.prepare("SELECT did FROM users WHERE referral_code=? AND did<>?").bind(code, did).first<{ did: string }>();
  if (!referrer) return json({ error: "bad code" }, 404);
  const r = await env.DB.prepare("UPDATE users SET referred_by=? WHERE did=? AND referred_by IS NULL").bind(referrer.did, did).run();
  if (!r.meta.changes) return json({ error: "already referred" }, 409);
  // referee bonus
  await env.DB.prepare("INSERT INTO credits(user_did, balance_micro, updated_at) VALUES(?,5000000,unixepoch()) ON CONFLICT(user_did) DO UPDATE SET balance_micro=balance_micro+5000000, updated_at=unixepoch()").bind(did).run();
  await env.DB.prepare("INSERT INTO ledger(user_did, amount_micro, kind, memo, created_at) VALUES(?,5000000,'deposit','referral',unixepoch())").bind(did).run();
  await audit(env, did, null, "referral.claim", code);
  return json({ ok: true, bonus_micro: 5000000 });
});

// P3: blueprint template marketplace
admin.get("/api/templates", async (_req, env: Env) => {
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k='templates'").first<{ v: string }>();
  return new Response(r?.v ?? "[]", { headers: { "content-type": "application/json" } });
});

admin.post("/api/sites/:id/domain", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const { fqdn } = await req.json() as { fqdn: string };
  if (!fqdn || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(fqdn)) return json({ error: "bad fqdn" }, 400);
  const r = await env.DB.prepare("UPDATE sites SET custom_domain=? WHERE id=? AND owner_did=?").bind(fqdn.toLowerCase(), req.params!.id, did).run();
  if (!r.meta.changes) return json({ error: "not found" }, 404);
  await audit(env, did, req.params!.id, "domain.attach", fqdn);
  return json({ ok: true, fqdn });
});

export async function underSiteQuota(env: Env, did: string, plan: { sites_max: number }): Promise<boolean> {
  const n = await env.DB.prepare("SELECT COUNT(*) c FROM sites WHERE owner_did=? AND status<>'archived'").bind(did).first<{ c: number }>();
  return (n?.c ?? 0) < plan.sites_max;
}

export async function storageUsed(env: Env, siteId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(bytes_total),0) b FROM manifests WHERE site_id=?").bind(siteId).first<{ b: number }>();
  return r?.b ?? 0;
}
