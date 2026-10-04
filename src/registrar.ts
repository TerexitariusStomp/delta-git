// P5: domain store via Cloudflare Registrar API — customer prepaid-funded
// (registrations bill the account's payment method → BYO or prepaid only).
import { Router } from "itty-router";
import type { Env } from "./env";
import { whoami } from "./auth";

export const registrar = Router();
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const cf = (env: Env, path: string, opts: RequestInit = {}) =>
  fetch(`https://api.cloudflare.com/client/v4/accounts/${(env as any).CF_ACCOUNT_ID}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${(env as any).CF_API_TOKEN}`, "content-type": "application/json", ...(opts.headers || {}) },
  }).then((r) => r.json() as Promise<any>);

// Search availability + price (read-only, safe)
registrar.get("/api/domains/search", async (req, env: Env) => {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const r = await cf(env, `/registrar/domain-search`, { method: "POST", body: JSON.stringify({ search_text: q }) });
  return json(r.result ?? r);
});

registrar.post("/api/domains/check", async (req, env: Env) => {
  const { domains } = await req.json() as { domains: string[] };
  const r = await cf(env, `/registrar/domain-check`, { method: "POST", body: JSON.stringify({ domains: domains.slice(0, 20) }) });
  return json(r.result ?? r);
});

// Register — only after the customer's prepaid balance covers the price
registrar.post("/api/domains/register", async (req, env: Env) => {
  const did = await whoami(env, req);
  if (!did) return json({ error: "unauthorized" }, 401);
  const { domain, site_id } = await req.json() as { domain: string; site_id: string };
  const check = await cf(env, `/registrar/domain-check`, { method: "POST", body: JSON.stringify({ domains: [domain] }) });
  const offer = check.result?.[0] ?? check.result;
  if (!offer?.registrable || offer.tier === "premium")
    return json({ error: "not_registrable", reason: offer?.reason ?? offer?.tier }, 422);
  const priceMicro = Math.round((offer.price ?? 0) * 1e6);
  const bal = await env.DB.prepare("SELECT balance_micro FROM credits WHERE user_did=?").bind(did).first<{ balance_micro: number }>();
  if (!bal || bal.balance_micro < priceMicro)
    return json({ error: "insufficient_credit", needed_micro: priceMicro }, 402);
  const reg = await cf(env, `/registrar/registrations`, { method: "POST", body: JSON.stringify({ domain_name: domain }) });
  if (!reg.success) return json({ error: "register_failed", detail: reg.errors }, 502);
  // debit only on success — client funds it, we never front
  await env.DB.batch([
    env.DB.prepare("UPDATE credits SET balance_micro=balance_micro-? WHERE user_did=?").bind(priceMicro, did),
    env.DB.prepare("INSERT INTO ledger(user_did, amount_micro, kind, memo, created_at) VALUES(?,?,'debit',?,unixepoch())").bind(did, -priceMicro, `domain:${domain}`),
    env.DB.prepare("INSERT INTO domains(fqdn, site_id, user_did, status, price_micro, created_at) VALUES(?,?,?,'active',?,unixepoch())").bind(domain, site_id, did, priceMicro),
    env.DB.prepare("UPDATE sites SET custom_domain=?, lease_expires_at=NULL WHERE id=?").bind(domain, site_id),
  ]);
  return json({ ok: true, domain, price_micro: priceMicro });
});
