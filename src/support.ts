// P4: AI support bot on Workers AI (10k free neurons/day) + status endpoint
import type { Env } from "./env";

export async function supportAnswer(env: Env & { AI?: Ai }, question: string): Promise<string> {
  if (!env.AI) return "AI support not available on this tier.";
  const ctx = await env.DB.prepare(
    "SELECT action, detail, created_at FROM audit ORDER BY created_at DESC LIMIT 10"
  ).all();
  const r = await env.AI.run("@cf/meta/llama-3.1-8b-instruct" as any, {
    messages: [
      { role: "system", content: "You are the wp-cloud support bot. WordPress hosting on Cloudflare: browser-Playground authoring, static publish to R2, lanes 1-3, USDC billing. Be concise." },
      { role: "user", content: question },
    ],
    max_tokens: 300,
  } as any);
  return (r as any).response ?? "no answer";
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
