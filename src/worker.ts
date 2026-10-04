import { api } from "./api";
import { serveSite } from "./serving";
import { scanUsdc, reapLeases } from "./usdc";
import type { Env } from "./env";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return api.fetch(req, env, ctx);
    if (url.pathname === "/healthz") return new Response("ok");
    // platform host (pages.dev / localhost) → static admin shell via ASSETS
    const host = url.hostname;
    if (host.endsWith("pages.dev") || host === "localhost" || host === "127.0.0.1")
      return (env as any).ASSETS ? (env as any).ASSETS.fetch(req) : new Response("wp-cloud", { status: 200 });
    return serveSite(req, env, ctx);
  },
  async scheduled(_e: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scanUsdc(env));
    ctx.waitUntil(reapLeases(env));
  },
};
