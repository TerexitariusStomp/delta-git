// P4: best-effort rate limiter — per-IP token bucket in D1 (eventual, edge-wide)
import type { Env } from "./env";

export async function rateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000 / windowSec);
  try {
    await env.DB.prepare(
      "INSERT INTO meta(k,v) VALUES(?, '1') ON CONFLICT(k) DO UPDATE SET v=CAST(v AS INTEGER)+1"
    ).bind(`rl:${key}:${now}`).run();
    const row = await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(`rl:${key}:${now}`).first<{ v: string }>();
    return parseInt(row?.v ?? "0") <= limit;
  } catch { return true; } // fail-open: limiter must never block the product
}
