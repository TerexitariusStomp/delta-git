// P4: best-effort rate limiter — per-IP token bucket in D1 (eventual, edge-wide).
// Lanes whose window fits the platform `ratelimit` binding (≤60s) get a
// globally-consistent counter when the binding is configured; the hourly
// lane and bindingless deploys keep the D1 fallback.
import type { Env } from "./env";

export interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSec: number,
  binding?: "RATE_LIMIT_API"
): Promise<boolean> {
  const limiter = binding ? (env[binding] as RateLimitBinding | undefined) : undefined;
  if (limiter) {
    try {
      return (await limiter.limit({ key })).success;
    } catch { /* fall through to the D1 counter */ }
  }
  const now = Math.floor(Date.now() / 1000 / windowSec);
  try {
    await env.DB.prepare(
      "INSERT INTO meta(k,v) VALUES(?, '1') ON CONFLICT(k) DO UPDATE SET v=CAST(v AS INTEGER)+1"
    ).bind(`rl:${key}:${now}`).run();
    const row = await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(`rl:${key}:${now}`).first<{ v: string }>();
    return parseInt(row?.v ?? "0") <= limit;
  } catch { return true; } // fail-open: limiter must never block the product
}
