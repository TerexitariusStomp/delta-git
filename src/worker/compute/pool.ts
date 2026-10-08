import { z } from "zod";

import { createLogger } from "@/worker/common/logger";

// Compute pool bridge — delta-git → localchimera coordinator.
//
// Public repositories can offload inference-shaped work (merge adjudication,
// repo indexing, research) to the proof-of-interest volunteer pool instead of
// Workers AI. The pool is a swarm of opted-in browser/extension/daemon nodes
// coordinated by a single CoordinatorDO, settled in USDC — no token.
//
// Privacy gate: poolInfer() refuses to run unless the caller passes
// `visibility: "public"` or `"internal"`. Public jobs ride the full pool;
// INTERNAL jobs are dispatched with coordinator classification INTERNAL —
// the coordinator only routes those to durable+DID-bound nodes, never to
// anonymous visitor browsers. Private and E2E repositories must never emit
// content to volunteer nodes — the repo-side check is the first line of
// defense and the coordinator rejects SECRET outright.
//
// Env:
//   COMPUTE_COORDINATOR     var    coordinator base URL (https://…)
//   COMPUTE_DISPATCH_TOKEN  secret per-project dispatch bearer token
//   COMPUTE_TIMEOUT_MS      var    result wait budget (default 45s)
//   COMPUTE_ENABLED         var    "0"/unset disables the pool path entirely

const chatCompletionResponse = z.object({
  choices: z.array(
    z.object({
      message: z.object({ role: z.string(), content: z.string() }),
    })
  ),
});

const poolStatusResponse = z.object({
  volunteers: z.number(),
  idle: z.number(),
  byTaskType: z.record(z.string(), z.number()),
  byProject: z.record(z.string(), z.number()).optional(),
  pendingJobs: z.number(),
});

export type PoolStatus = z.infer<typeof poolStatusResponse>;

export interface PoolInferArgs {
  /** `project:<slug>` pool — jobs prefer volunteers enrolled in it. */
  project?: string;
  /** Chat messages; the coordinator flattens them into one prompt. */
  messages: { role: string; content: string }[];
  maxTokens?: number;
  /**
   * Caller's repo visibility — the privacy gate. "public" → PUBLIC pool
   * jobs (any node), "internal" → INTERNAL pool jobs (durable+DID-bound
   * nodes only). Anything else returns null without any network call.
   */
  visibility: "public" | "internal" | "private" | string;
  /** When true, request SSE deltas and consume them via onDelta. */
  stream?: boolean;
  /** Receives each streamed text delta when stream is set. */
  onDelta?: (text: string) => void;
}

/**
 * Repo visibility → coordinator classification. Public work can ride any
 * node; internal work must never reach a visitor browser, so it carries
 * INTERNAL — coordinator-side selection restricts to durable+DID-bound
 * volunteers. Anything else (private, e2e, unknown) is refused client-side.
 */
function classificationFor(visibility: string): "PUBLIC" | "INTERNAL" | null {
  if (visibility === "public") return "PUBLIC";
  if (visibility === "internal") return "INTERNAL";
  return null;
}

export function computeEnabled(env: Env): boolean {
  // COMPUTE_* vars are typed as their wrangler literal defaults — String()
  // widens them so the enabled-flag comparison isn't flagged as impossible.
  return (
    !!(env.COMPUTE_COORDINATOR && env.COMPUTE_DISPATCH_TOKEN) && String(env.COMPUTE_ENABLED) !== "0"
  );
}

/** Stable pool slug for a repo — `dg:<owner>/<repo>`. */
export function repoPoolProject(owner: string, repo: string): string {
  return `dg:${owner}/${repo}`;
}

function coordinatorUrl(env: Env, path: string): string {
  // Same wrangler-literal widening as computeEnabled — the var's declared
  // type is the "" default, so read through string.
  const base: string = env.COMPUTE_COORDINATOR ?? "";
  return `${base.replace(/\/+$/, "")}${path}`;
}

function timeoutMs(env: Env): number {
  const parsed = Number(env.COMPUTE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 45_000;
}

/**
 * Pool-scoped status for the "power this project" card and the community
 * badge. Returns null when the coordinator is unconfigured or unreachable —
 * callers render the fallback state rather than failing the page.
 */
export async function poolStatus(env: Env, project: string): Promise<PoolStatus | null> {
  if (!env.COMPUTE_COORDINATOR) return null;
  const log = createLogger(env.LOG_LEVEL, { service: "ComputePool" });
  try {
    const res = await fetch(coordinatorUrl(env, `/status?project=${encodeURIComponent(project)}`), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const parsed = poolStatusResponse.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch (error) {
    log.warn("pool:status-failed", { project, error: String(error) });
    return null;
  }
}

const poolEarningsResponse = z.object({
  totalWei: z.string().optional(),
  jobs: z.number().optional(),
});

export type PoolEarnings = z.infer<typeof poolEarningsResponse>;

/**
 * Pool earnings ledger (`/earnings?project=`) — supporters' accrued
 * micro-USDC + completed-job count for the pool card. Null when unreachable.
 */
export async function poolEarnings(env: Env, project: string): Promise<PoolEarnings | null> {
  if (!env.COMPUTE_COORDINATOR) return null;
  const log = createLogger(env.LOG_LEVEL, { service: "ComputePool" });
  try {
    const res = await fetch(
      coordinatorUrl(env, `/earnings?project=${encodeURIComponent(project)}`),
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!res.ok) return null;
    const parsed = poolEarningsResponse.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch (error) {
    log.warn("pool:earnings-failed", { project, error: String(error) });
    return null;
  }
}

/**
 * Pool output is untrusted — a volunteer node (or a compromised one) could
 * return instruction-like content meant to hijack a downstream prompt when
 * the merged file is later re-read as context. We strip the common
 * injection shapes before the text is used as merge content or embedded in
 * another prompt. This is a heuristic screen, not a parser: over-stripping
 * legitimate prose is possible, so callers get the count to audit.
 */
const INSTRUCTION_LINE =
  /^\s*(?:system\s*:|assistant\s*:|ignore\s+(?:all\s+|the\s+)?(?:previous|prior|above)\s+instructions?|you\s+are\s+now|disregard\s+(?:all\s+)?(?:previous|prior))/i;

export function sanitizePoolResult(text: string): { text: string; stripped: number } {
  const lines = text.split("\n");
  const kept = lines.filter((l) => !INSTRUCTION_LINE.test(l));
  return { text: kept.join("\n").trim(), stripped: lines.length - kept.length };
}

/**
 * Consume an OpenAI `text/event-stream` body into assembled assistant text.
 * Each `data:` line is a `chat.completion.chunk` JSON or the sentinel
 * `[DONE]`. Content deltas are concatenated; the (optional) onDelta hook
 * observes them as they arrive. Returns the assembled string.
 */
export async function consumeCompletionStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = "";
  let assembled = "";
  const flush = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const data = t.slice(5).trim();
    if (data === "[DONE]") return;
    try {
      const chunk = JSON.parse(data) as {
        choices?: { delta?: { content?: string } }[];
      };
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        assembled += delta;
        onDelta?.(delta);
      }
    } catch {
      // Keep going on a partial/garbled line — the sentinel ends the stream.
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      flush(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) flush(buf);
  return assembled;
}

/**
 * OpenAI-compatible inference through the pool. Returns the assistant text
 * on success; null on any failure (unconfigured, empty pool, timeout, schema
 * mismatch) so callers fall back to Workers AI. With `stream: true` the
 * coordinator's SSE replay is consumed — deltas surface through onDelta as
 * they arrive while the assembled text is sanitized the same way.
 */
export async function poolInfer(env: Env, args: PoolInferArgs): Promise<string | null> {
  const classification = classificationFor(args.visibility);
  if (!classification) return null;
  if (!computeEnabled(env)) return null;
  const log = createLogger(env.LOG_LEVEL, { service: "ComputePool" });
  try {
    const res = await fetch(coordinatorUrl(env, "/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.COMPUTE_DISPATCH_TOKEN}`,
      },
      body: JSON.stringify({
        model: "swarm",
        project: args.project,
        messages: args.messages,
        max_tokens: args.maxTokens ?? 4096,
        classification,
        ...(args.stream ? { stream: true } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs(env)),
    });
    if (!res.ok) {
      log.debug("pool:infer-unavailable", { status: res.status, project: args.project });
      return null;
    }
    const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
    const resolved = isSse
      ? (await consumeCompletionStream(res.body!, args.onDelta)).trim()
      : await res
          .json()
          .then((j) => chatCompletionResponse.safeParse(j))
          .then((p) => p.data?.choices[0]?.message.content.trim());
    if (!resolved) return null;
    const clean = sanitizePoolResult(resolved);
    if (clean.stripped > 0) {
      log.warn("pool:stripped-instructions", { project: args.project, stripped: clean.stripped });
    }
    if (!clean.text) return null;
    return clean.text;
  } catch (error) {
    log.warn("pool:infer-failed", { project: args.project, error: String(error) });
    return null;
  }
}

const dispatchResponse = z.object({
  results: z.array(z.object({ jobId: z.string().optional(), error: z.string().optional() })),
});

/**
 * Submit a structured job (research/index/copy envelopes) through the batch
 * endpoint — `/jobs` awaits a result inline, but intents want fire-and-forget
 * dispatch, and `/jobs/batch` never blocks on results. Returns the jobId or
 * null on rejection/unavailability.
 */
export async function poolDispatch(
  env: Env,
  args: {
    project?: string;
    taskType: number;
    payload: unknown;
    priority?: "interactive" | "batch";
    /**
     * "public" → PUBLIC classification (any node); "internal" → INTERNAL
     * (durable+DID-bound nodes only); anything else is refused here.
     */
    visibility: "public" | "internal" | "private" | string;
  }
): Promise<{ jobId: string } | null> {
  const classification = classificationFor(args.visibility);
  if (!classification) return null;
  if (!computeEnabled(env)) return null;
  const log = createLogger(env.LOG_LEVEL, { service: "ComputePool" });
  try {
    const res = await fetch(coordinatorUrl(env, "/jobs/batch"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.COMPUTE_DISPATCH_TOKEN}`,
      },
      body: JSON.stringify({
        jobs: [
          {
            payload: JSON.stringify(args.payload),
            taskType: args.taskType,
            project: args.project,
            classification,
            priority: args.priority,
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const parsed = dispatchResponse.safeParse(await res.json());
    const first = parsed.success ? parsed.data.results[0] : undefined;
    return first?.jobId ? { jobId: first.jobId } : null;
  } catch (error) {
    log.warn("pool:dispatch-failed", { project: args.project, error: String(error) });
    return null;
  }
}
