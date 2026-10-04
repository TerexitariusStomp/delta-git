import { Router } from "itty-router";
import type { Env } from "./env";
import { whoami, verifySignature, issueToken, didFromAddress } from "./auth";
import { presignPut } from "./presign";

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
  const siteId = id();
  const host = `preview-${siteId}.${env.SITE_HOST_SUFFIX}`;
  const lease = Math.floor(Date.now() / 1000) + 7 * 86400; // 7d preview lease
  await env.DB.prepare(
    "INSERT INTO sites(id, owner_did, preview_host, lease_expires_at, created_at) VALUES(?,?,?,?,unixepoch())"
  ).bind(siteId, did, host, lease).run();
  return json({ id: siteId, preview_host: host, lease_expires_at: lease });
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

  // Woo/dynamic detection gate — a store can never land on Lane 1
  const bad = (body.plugins ?? []).filter((p) => DYNAMIC_PLUGINS.includes(p.toLowerCase()));
  if (site.lane === 1 && bad.length)
    return json({ error: "dynamic_plugins", plugins: bad, required_lane: 3 }, 422);

  const bytes = body.files.reduce((n, f) => n + f.size, 0);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO manifests(site_id, sha, file_count, bytes_total, created_at) VALUES(?,?,?,?,unixepoch())")
      .bind(site.id, body.sha, body.files.length, bytes),
    env.DB.prepare("UPDATE sites SET manifest_sha=? WHERE id=?").bind(body.sha, site.id),
  ]);
  return json({ ok: true, sha: body.sha, url: `https://${site.preview_host}` });
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

api.get("/api/comments", async (req, env: Env) => {
  const u = new URL(req.url);
  const rows = await env.DB.prepare(
    "SELECT author, body, created_at FROM comments WHERE site_id=? AND post_path=? AND status='approved' ORDER BY created_at"
  ).bind(u.searchParams.get("site") ?? "", u.searchParams.get("path") ?? "").all();
  return json(rows.results);
});

async function ownedSite(env: Env, id: string, did: string) {
  return env.DB.prepare("SELECT * FROM sites WHERE id=? AND owner_did=?").bind(id, did)
    .first<{ id: string; lane: number; preview_host: string }>();
}
