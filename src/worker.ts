import { api } from "./api";
import { admin } from "./admin";
import { registrar } from "./registrar";
import { importer } from "./importer";
import { serveSite } from "./serving";
import { rateLimit } from "./ratelimit";
import { supportAnswer, statusPage } from "./support";
import { earn } from "./earn";
import { deploygit } from "./deploygit";
import { hooks } from "./hooks";
import { sso } from "./sso";
import { consumeBatch } from "./queue";
import { scanUsdc, reapLeases, retainManifests, healthCheck, debitPlans } from "./cron";
import { TenantDO } from "./do/tenant";
import type { Env, MessageBatch } from "./env";

export { TenantDO };

const ROUTERS = [admin, earn, registrar, importer, api, deploygit, hooks]; // first match wins

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const ip = req.headers.get("cf-connecting-ip") ?? "anon";

    if (url.pathname === "/status") return statusPage(env);
    if (url.pathname === "/api/support" && req.method === "POST") {
      if (!(await rateLimit(env, `support:${ip}`, 20, 3600))) return new Response("rate limited", { status: 429 });
      const { q } = await req.json() as { q: string };
      return new Response(JSON.stringify({ answer: await supportAnswer(env, q ?? "") }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!(await rateLimit(env, `api:${ip}`, 300, 60))) return new Response("rate limited", { status: 429 });
      for (const r of ROUTERS) {
        const res = await r.fetch(req, env, ctx);
        if (res && res.status !== 404) return res;
      }
      return new Response('{"error":"not found"}', { status: 404, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname.startsWith("/auth/")) return sso.fetch(req, env, ctx);

    const host = url.hostname;
    const isAppHost = host === env.APP_HOST || host.endsWith("pages.dev") || host === "localhost" || host === "127.0.0.1";
    if (isAppHost) {
      // workers.dev can't route preview-{id}.* subdomains — path-based previews
      // are the portable fallback (custom-domain suffixes still serve by host).
      if (url.pathname.startsWith("/preview/")) return serveSite(req, env, ctx);
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response("wp-cloud", { status: 200 });
    }
    return serveSite(req, env, ctx);
  },

  async scheduled(_e: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scanUsdc(env));
    ctx.waitUntil(reapLeases(env));
    ctx.waitUntil(retainManifests(env));
    ctx.waitUntil(healthCheck(env));
    ctx.waitUntil(debitPlans(env));
  },

  async queue(batch: MessageBatch<{ kind: string; site_id: string; user_did: string }>, env: Env): Promise<void> {
    await consumeBatch(batch as any, env);
  },
};
