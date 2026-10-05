// Visitor-compute infer routing — Chimera coordinator first, Workers AI fallback.
// Site-tagged jobs prefer that site's own opted-in visitors (who get paid via
// escrow); global pool picks up the slack; Workers AI is the always-on floor
// for latency-critical or coordinator-offline cases.
import { Router } from "itty-router";
import type { Env } from "./env";
import { whoami } from "./auth";

export const earn = Router();
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Coordinator job types — must match localchimera registry.ts WPCLOUD map
export const JOB = { INFER_TEXT: 100, INFER_SEO: 101, MODERATE: 102, SUPPORT: 103 } as const;

interface JobResult { jobId: string; accepted: boolean; result?: { result: string } }

/** Route an infer job through visitor nodes; returns null if no node took it
 *  (caller falls back to Workers AI). Server-side call — DISPATCH_AUTH_TOKEN
 *  never reaches visitors. */
export async function visitorInfer(env: Env, taskType: number, prompt: string, site?: string): Promise<string | null> {
  if (!env.COORDINATOR_URL || !env.DISPATCH_AUTH_TOKEN) return null;
  try {
    const r = await fetch(`${env.COORDINATOR_URL}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.DISPATCH_AUTH_TOKEN}` },
      body: JSON.stringify({ payload: JSON.stringify({ prompt }), taskType, site }),
      signal: AbortSignal.timeout(65_000), // slightly > coordinator's result timeout
    });
    if (!r.ok) return null;
    const j = (await r.json()) as JobResult;
    return j.accepted && j.result ? j.result.result : null;
  } catch {
    return null;
  }
}

/** Infer with automatic fallback — visitor nodes first (paid, site-scoped),
 *  Workers AI as the always-on floor. Returns source for transparency. */
export async function infer(env: Env, prompt: string, site?: string, taskType: number = JOB.INFER_TEXT): Promise<{ text: string; source: "visitor" | "workers-ai" | "none" }> {
  const v = await visitorInfer(env, taskType, prompt, site);
  if (v) return { text: v, source: "visitor" };
  if (env.AI) {
    const r = await env.AI.run("@cf/meta/llama-3.1-8b-instruct" as any, {
      messages: [{ role: "user", content: prompt }], max_tokens: 300,
    } as any);
    return { text: (r as any).response ?? "", source: "workers-ai" };
  }
  return { text: "", source: "none" };
}

// ---- API ----

// Enable/disable the visitor earn card for a site + read coordinator stats
earn.post("/api/sites/:id/earn", async (req, env: Env) => {
  const did = await whoami(env, req);
  if (!did) return json({ error: "unauthorized" }, 401);
  const { enabled } = await req.json() as { enabled: boolean };
  const r = await env.DB.prepare("UPDATE sites SET earn_enabled=? WHERE id=? AND owner_did=?")
    .bind(enabled ? 1 : 0, req.params!.id, did).run();
  if (!r.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true, earn_enabled: !!enabled });
});

// Site-owner earnings + live node count from the coordinator
earn.get("/api/sites/:id/earn", async (req, env: Env) => {
  const did = await whoami(env, req);
  if (!did) return json({ error: "unauthorized" }, 401);
  const site = await env.DB.prepare("SELECT id, earn_enabled FROM sites WHERE id=? AND owner_did=?")
    .bind(req.params!.id, did).first<{ id: string; earn_enabled: number }>();
  if (!site) return json({ error: "not found" }, 404);
  let ledger = { totalWei: "0", jobs: 0 }, nodes = 0;
  if (env.COORDINATOR_URL) {
    try {
      const [e, s] = await Promise.all([
        fetch(`${env.COORDINATOR_URL}/earnings?site=${site.id}`).then((r) => r.json() as Promise<any>),
        fetch(`${env.COORDINATOR_URL}/status`).then((r) => r.json() as Promise<any>),
      ]);
      ledger = e ?? ledger;
      nodes = s?.volunteers ?? 0;
    } catch {}
  }
  return json({ earn_enabled: !!site.earn_enabled, ledger, network_nodes: nodes });
});
