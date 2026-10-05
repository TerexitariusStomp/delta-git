import { Router } from "itty-router";
import type { Env } from "./env";
import { whoami, verifySignature, issueToken, didFromAddress } from "./auth";
import { presignPut } from "./presign";
import { planFor } from "./plans";
import { underSiteQuota, storageUsed } from "./admin";
import { classifyPlugin, mergeVerdicts, planForVariant, tierAtLeast, type Verdict } from "./compat";

const DYNAMIC_PLUGINS = ["woocommerce", "wpforms", "gravityforms", "memberpress", "learndash", "lifterlms", "easy-digital-downloads"];

export const api = Router();

const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const id = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

async function auth(req: Request, env: Env): Promise<string | Response> {
  const did = await whoami(env, req);
  return did ?? json({ error: "unauthorized" }, 401);
}

// ---- Auth ----
api.post("/api/auth/siwe", async (req, env: Env) => {
  const { address, message, signature } = await req.json() as any;
  if (!address || !message?.toLowerCase().includes(address.toLowerCase()) || !(await verifySignature(address, message, signature)))
    return json({ error: "bad signature" }, 401);
  const did = didFromAddress(address);
  await env.DB.prepare(
    "INSERT INTO users(did, deposit_salt, created_at) VALUES(?, abs(random()) % 900 + 1, unixepoch()) ON CONFLICT(did) DO NOTHING"
  ).bind(did).run();
  return json({ did, token: await issueToken(env, did) });
});

// ---- Sites ----
api.post("/api/sites", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const user = await env.DB.prepare("SELECT plan FROM users WHERE did=?").bind(did).first<{ plan: string }>();
  const plan = planFor(user);
  if (!(await underSiteQuota(env, did, plan))) return json({ error: "site_quota" }, 402);
  const { lane = 1, variant } = await req.json().catch(() => ({})) as { lane?: number; variant?: { sapi?: string; php_version?: string; db_engine?: string; multisite?: boolean } };
  if (lane > plan.lane_max) return json({ error: "lane_requires_plan", needed: lane }, 402);
  const siteId = id();
  const host = `preview-${siteId}.${env.SITE_HOST_SUFFIX}`;
  const lease = Math.floor(Date.now() / 1000) + 7 * 86400; // 7d preview lease
  const merged = mergeVerdicts([]);
  const v = { ...merged, ...pickVariant(variant), sidecars: merged.sidecars };
  const needed = planForVariant(v);
  if (lane >= 3 && !tierAtLeast(user?.plan ?? "creator", needed))
    return json({ error: "variant_requires_plan", needed }, 402);
  await env.DB.prepare(
    "INSERT INTO sites(id, owner_did, lane, preview_host, lease_expires_at, sapi, php_version, db_engine, multisite, agent_token, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,unixepoch())"
  ).bind(siteId, did, lane, host, lease, v.sapi, v.php_version, v.db_engine, v.multisite, crypto.randomUUID()).run();
  return json({ id: siteId, preview_host: host, preview_url: previewUrl(env, { id: siteId, preview_host: host }), lease_expires_at: lease, lane, variant: { sapi: v.sapi, php_version: v.php_version, db_engine: v.db_engine, multisite: !!v.multisite } });
});

api.get("/api/sites/:id", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const site = await env.DB.prepare("SELECT * FROM sites WHERE id=? AND owner_did=?").bind(req.params!.id, did).first();
  if (!site) return json({ error: "not found" }, 404);
  const versions = await env.DB.prepare("SELECT sha, file_count, bytes_total, created_at FROM manifests WHERE site_id=? ORDER BY created_at DESC").bind(req.params!.id).all();
  return json({ site, versions: versions.results });
});

// ---- Publish ----
// Direct artifact upload — the no-S3-credentials publish path. The browser
// PUTs each file's raw bytes (?sha=&path=) straight through the worker into
// the R2 binding; /presign remains available when R2 API creds are set.
api.put("/api/sites/:id/upload", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const site = await ownedSite(env, req.params!.id, did);
  if (!site) return json({ error: "not found" }, 404);
  const u = new URL(req.url);
  const sha = u.searchParams.get("sha") ?? "";
  const path = (u.searchParams.get("path") ?? "").replace(/^\/+/, "").replace(/\.\./g, "");
  if (!sha || !path || !/^[\w./-]+$/.test(path)) return json({ error: "bad sha/path" }, 400);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 95 * 1024 * 1024) return json({ error: "file too large" }, 413);
  const body = await req.arrayBuffer();
  if (!body.byteLength) return json({ error: "empty body" }, 400);
  await env.ARTIFACTS.put(`sites/${site.id}/artifacts/${sha}/${path}`, body);
  return json({ ok: true, path, bytes: body.byteLength });
});

api.post("/api/sites/:id/presign", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const site = await ownedSite(env, req.params!.id, did);
  if (!site) return json({ error: "not found" }, 404);
  const { sha, files } = await req.json() as { sha: string; files: { path: string }[] };
  if (!sha || !files?.length || files.length > 5000) return json({ error: "bad file list" }, 400);
  const urls: Record<string, string> = {};
  for (const f of files) {
    const clean = f.path.replace(/^\/+/, "").replace(/\.\./g, "");
    urls[f.path] = await presignPut(env, `sites/${site.id}/artifacts/${sha}/${clean}`);
  }
  return json({ urls });
});

api.post("/api/sites/:id/publish", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const site = await ownedSite(env, req.params!.id, did);
  if (!site) return json({ error: "not found" }, 404);
  const body = await req.json() as { sha: string; files: { path: string; size: number }[]; plugins?: string[] };

  // ---- Plugin compatibility: classify → variant reconfigure → public verdict DB ----

// Scan a plugin set: {plugins: [{slug, source?}]} → per-plugin verdicts + merged site variant.
// Called by the admin shell at provisioning and by the in-container agent on plugin activation.
api.post("/api/sites/:id/compat-scan", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const site = await ownedSite(env, req.params!.id, did);
  if (!site) return json({ error: "not found" }, 404);
  const { plugins = [] } = await req.json() as { plugins: { slug: string; source?: string }[] };
  if (plugins.length > 500) return json({ error: "too many plugins" }, 400);

  const verdicts: Record<string, Verdict> = {};
  const stmts: D1PreparedStatement[] = [];
  for (const p of plugins) {
    const slug = p.slug.toLowerCase();
    let v = (await env.DB.prepare("SELECT verdict FROM plugin_compat WHERE slug=? AND scanner_version=1").bind(slug).first<{ verdict: string }>())
      ?.verdict as string | undefined;
    const verdict: Verdict = v ? JSON.parse(v) : classifyPlugin(slug, p.source ?? "");
    verdicts[slug] = verdict;
    if (!v) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO plugin_compat(slug, verdict, scanned_at, scanner_version) VALUES(?,?,unixepoch(),1)").bind(slug, JSON.stringify(verdict)));
  }
  const merged = mergeVerdicts(Object.values(verdicts));
  const user = await env.DB.prepare("SELECT plan FROM users WHERE did=?").bind(did).first<{ plan: string }>();
  const needed = planForVariant(merged);
  const entitled = tierAtLeast(user?.plan ?? "creator", needed);

  if (entitled) {
    stmts.push(env.DB.prepare(
      "UPDATE sites SET sapi=?, php_version=?, db_engine=?, multisite=?, daemons=?, tcp_ingress=? WHERE id=?"
    ).bind(merged.sapi, merged.php_version, merged.db_engine, merged.multisite, merged.daemons, merged.tcp_ingress, site.id));
    // record needed sidecars (db engine counts as a sidecar too)
    const sidecars = [...merged.sidecars];
    if (merged.db_engine !== "sqlite") sidecars.push(merged.db_engine);
    for (const t of sidecars)
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO site_sidecars(site_id, type, port) VALUES(?,?,?)")
        .bind(site.id, t, { mariadb: 3306, mysql8: 3306, redis: 6379, elastic: 9200, memcached: 11211 }[t] ?? 0));
    if (merged.cron) stmts.push(env.DB.prepare("UPDATE sites SET cron_wake_at=unixepoch()+300 WHERE id=?").bind(site.id));
    // reconfigure the live container if it's a Lane-2/3 site
    if (env.TENANT && site.lane >= 2) {
      const stub = env.TENANT.get(env.TENANT.idFromName(site.id));
      await stub.fetch(new Request("https://do/control", { method: "POST", body: JSON.stringify({ action: "reconfigure", body: merged }) }));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ verdicts, merged, needed_plan: needed, entitled, applied: entitled });
});

// Machine-to-machine: in-container agent reports its plugin set.
// Auth = per-site agent_token (X-Site-Token), generated at site create.
api.post("/api/internal/compat-report", async (req, env: Env) => {
  const token = req.headers.get("x-site-token") ?? "";
  const site = await env.DB.prepare("SELECT id, owner_did, lane FROM sites WHERE agent_token=?").bind(token)
    .first<{ id: string; owner_did: string; lane: number }>();
  if (!site) return json({ error: "unauthorized" }, 401);
  const { plugins = [], next_cron_due } = await req.json() as { plugins: { slug: string; source?: string }[]; next_cron_due?: number };

  const verdicts: Verdict[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const p of plugins.slice(0, 500)) {
    const slug = p.slug.toLowerCase();
    const cached = await env.DB.prepare("SELECT verdict FROM plugin_compat WHERE slug=?").bind(slug).first<{ verdict: string }>();
    const verdict: Verdict = cached ? JSON.parse(cached.verdict) : classifyPlugin(slug, p.source ?? "");
    verdicts.push(verdict);
    if (!cached) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO plugin_compat(slug, verdict, scanned_at, scanner_version) VALUES(?,?,unixepoch(),1)").bind(slug, JSON.stringify(verdict)));
  }
  const merged = mergeVerdicts(verdicts);
  const user = await env.DB.prepare("SELECT plan FROM users WHERE did=?").bind(site.owner_did).first<{ plan: string }>();
  const needed = planForVariant(merged);
  const entitled = tierAtLeast(user?.plan ?? "creator", needed);

  if (entitled) {
    stmts.push(env.DB.prepare(
      "UPDATE sites SET sapi=?, php_version=?, db_engine=?, multisite=?, daemons=?, tcp_ingress=?, cron_wake_at=COALESCE(?, cron_wake_at) WHERE id=?"
    ).bind(merged.sapi, merged.php_version, merged.db_engine, merged.multisite, merged.daemons, merged.tcp_ingress, next_cron_due ?? null, site.id));
    if (env.TENANT && site.lane >= 2) {
      const stub = env.TENANT.get(env.TENANT.idFromName(site.id));
      await stub.fetch(new Request("https://do/control", { method: "POST", body: JSON.stringify({ action: "reconfigure", body: merged }) }));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ merged, needed_plan: needed, entitled });
});

// Public verdict database — makes the compatibility claim measurable
api.get("/api/compat/:slug", async (req, env: Env) => {
  const row = await env.DB.prepare("SELECT verdict, scanned_at FROM plugin_compat WHERE slug=?").bind(req.params!.slug.toLowerCase()).first<{ verdict: string; scanned_at: number }>();
  if (!row) return json({ error: "unknown plugin" }, 404);
  return json({ slug: req.params!.slug, ...JSON.parse(row.verdict), scanned_at: row.scanned_at });
});

// Woo/dynamic detection gate — a store can never land on Lane 1
  const bad = (body.plugins ?? []).filter((p) => DYNAMIC_PLUGINS.includes(p.toLowerCase()));
  if (site.lane === 1 && bad.length)
    return json({ error: "dynamic_plugins", plugins: bad, required_lane: 3 }, 422);

  const bytes = body.files.reduce((n, f) => n + f.size, 0);
  // P1 storage quota: total manifest bytes across versions vs plan cap
  const user = await env.DB.prepare("SELECT plan FROM users WHERE did=?").bind(did).first<{ plan: string }>();
  const cap = planFor(user).storage_mb * 1024 * 1024;
  if ((await storageUsed(env, site.id)) + bytes > cap)
    return json({ error: "storage_quota", cap_mb: planFor(user).storage_mb }, 402);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO manifests(site_id, sha, file_count, bytes_total, created_at) VALUES(?,?,?,?,unixepoch())")
      .bind(site.id, body.sha, body.files.length, bytes),
    env.DB.prepare("UPDATE sites SET manifest_sha=? WHERE id=?").bind(body.sha, site.id),
  ]);
  return json({ ok: true, sha: body.sha, url: previewUrl(env, site) });
});

api.post("/api/sites/:id/rollback", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const { sha } = await req.json() as { sha: string };
  const site = await ownedSite(env, req.params!.id, did);
  if (!site) return json({ error: "not found" }, 404);
  const exists = await env.DB.prepare("SELECT 1 FROM manifests WHERE site_id=? AND sha=?").bind(site.id, sha).first();
  if (!exists) return json({ error: "unknown sha" }, 404);
  await env.DB.prepare("UPDATE sites SET manifest_sha=? WHERE id=?").bind(sha, site.id).run();
  return json({ ok: true, sha });
});

// ---- Credits / top-ups (USDC amount-salt) ----
api.post("/api/topup", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const { amount } = await req.json() as { amount: number }; // whole USDC
  if (!amount || amount < 1 || amount > 10000) return json({ error: "bad amount" }, 400);
  const user = await env.DB.prepare("SELECT deposit_salt FROM users WHERE did=?").bind(did).first<{ deposit_salt: number }>();
  const micro = amount * 1e6 + user!.deposit_salt; // e.g. $10.000042 → attribution by tail
  await env.DB.prepare("INSERT INTO intents(user_did, amount_salt, created_at) VALUES(?,?,unixepoch())").bind(did, String(micro)).run();
  return json({ address: env.USDC_DEPOSIT_ADDRESS, amount: micro / 1e6, currency: "USDC", chain: env.USDC_CHAIN });
});

api.get("/api/credits", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const row = await env.DB.prepare("SELECT balance_micro FROM credits WHERE user_did=?").bind(did).first<{ balance_micro: number }>();
  return json({ balance_micro: row?.balance_micro ?? 0 });
});

// ---- Comments / forms ----
api.post("/api/comments", async (req, env: Env) => {
  const { site_id, post_path, author, body } = await req.json() as any;
  if (!site_id || !post_path || !author || !body || body.length > 4000) return json({ error: "bad comment" }, 400);
  await env.DB.prepare("INSERT INTO comments(site_id, post_path, author, body, created_at) VALUES(?,?,?,?,unixepoch())")
    .bind(site_id, post_path, author.slice(0, 80), body).run();
  return json({ ok: true, status: "pending" });
});

// owner moderation
api.post("/api/comments/:id/approve", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const r = await env.DB.prepare(
    "UPDATE comments SET status='approved' WHERE id=? AND site_id IN (SELECT id FROM sites WHERE owner_did=?)"
  ).bind(req.params!.id, did).run();
  return r.meta.changes ? json({ ok: true }) : json({ error: "not found" }, 404);
});

api.post("/api/comments/:id/reject", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const r = await env.DB.prepare(
    "UPDATE comments SET status='rejected' WHERE id=? AND site_id IN (SELECT id FROM sites WHERE owner_did=?)"
  ).bind(req.params!.id, did).run();
  return r.meta.changes ? json({ ok: true }) : json({ error: "not found" }, 404);
});

api.get("/api/comments/pending", async (req, env: Env) => {
  const did = await auth(req, env);
  if (did instanceof Response) return did;
  const rows = await env.DB.prepare(
    "SELECT c.id, c.site_id, c.post_path, c.author, c.body, c.created_at FROM comments c JOIN sites s ON s.id=c.site_id WHERE s.owner_did=? AND c.status='pending' ORDER BY c.created_at"
  ).bind(did).all();
  return json(rows.results);
});

api.get("/api/comments", async (req, env: Env) => {
  const u = new URL(req.url);
  const rows = await env.DB.prepare(
    "SELECT author, body, created_at FROM comments WHERE site_id=? AND post_path=? AND status='approved' ORDER BY created_at"
  ).bind(u.searchParams.get("site") ?? "", u.searchParams.get("path") ?? "").all();
  return json(rows.results);
});

function pickVariant(v?: { sapi?: string; php_version?: string; db_engine?: string; multisite?: boolean }) {
  return {
    sapi: v?.sapi === "apache" ? "apache" : "frankenphp",
    php_version: ["7.4", "8.1", "8.2", "8.3", "8.4"].includes(v?.php_version ?? "") ? v!.php_version! : "8.4",
    db_engine: ["mariadb", "mysql8"].includes(v?.db_engine ?? "") ? v!.db_engine! : "sqlite",
    multisite: v?.multisite ? 1 : 0,
  };
}

// Path-based preview on the app host is the portable form (workers.dev can't
// route preview-{id}.* subdomains); subdomain form stays for custom suffixes.
export function previewUrl(env: Env, site: { id: string; preview_host: string }): string {
  return env.APP_HOST ? `https://${env.APP_HOST}/preview/${site.id}/` : `https://${site.preview_host}`;
}

async function ownedSite(env: Env, id: string, did: string) {
  return env.DB.prepare("SELECT * FROM sites WHERE id=? AND owner_did=?").bind(id, did)
    .first<{ id: string; lane: number; preview_host: string }>();
}
