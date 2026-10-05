// P4: AI support bot — visitor compute (Chimera) first, Workers AI floor.
import type { Env } from "./env";
import { infer, JOB } from "./earn";

export async function supportAnswer(env: Env & { AI?: Ai }, question: string): Promise<string> {
  const prompt = `You are the wp-cloud support bot. WordPress hosting on Cloudflare: browser-Playground authoring, static publish to R2, lanes 1-3, USDC billing. Be concise.\n\nQuestion: ${question}`;
  const r = await infer(env, prompt, undefined, JOB.SUPPORT);
  return r.text || "AI support not available on this tier.";
}

export async function statusPage(env: Env): Promise<Response> {
  const sites = await env.DB.prepare("SELECT COUNT(*) c FROM sites WHERE status='active'").first<{ c: number }>();
  const bad = await env.DB.prepare("SELECT COUNT(*) c FROM health WHERE consecutive_fails>2").first<{ c: number }>();
  const cursor = await env.DB.prepare("SELECT v FROM meta WHERE k='usdc_scan'").first<{ v: string }>();
  const body = {
    status: (bad?.c ?? 0) === 0 ? "operational" : "degraded",
    active_sites: sites?.c ?? 0,
    unhealthy_sites: bad?.c ?? 0,
    usdc_scan_block: cursor?.v ?? null,
    generated_at: Date.now(),
  };
  return new Response(JSON.stringify(body, null, 2), { headers: { "content-type": "application/json" } });
}
