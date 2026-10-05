// Consolidated abuse controls (Phase 2).
//
// Every lane that can flood shared resources funnels through here so the
// numbers live in one file:
//
//   - KV fixed-window rate limits (auth challenges, idea posts, patches)
//   - per-owner storage quotas (pack uploads, repo creation)
//   - Analytics Engine datapoints for observability
//
// KV limits are approximate (per-colo fixed windows) — good enough for a
// public forge edge; hard invariants (intent leases, quorum dedup) stay in
// the DO where they're strongly consistent.

const RATE_PREFIX = "ratelimit:";
export const QUOTA_PREFIX = "quota:ns:";

export interface RateLimitSpec {
  /** Bucket name for metrics/keys (e.g. "auth.challenge"). */
  bucket: string;
  /** Max requests per window. */
  limit: number;
  /** Window size in seconds. */
  windowSec: number;
  /**
   * Optional Workers Rate Limiting binding to prefer over the KV counter.
   * Bindings only support 10s/60s windows — the hourly lanes keep the KV
   * path. Global edge-consistent vs the KV counter's per-colo windows.
   */
  binding?:
    | "RATE_LIMIT_AUTH_CHALLENGE"
    | "RATE_LIMIT_AUTH_VERIFY"
    | "RATE_LIMIT_PATCH"
    | "RATE_LIMIT_VOTE";
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Fixed-window counter. `key` should be a principal (did, ip hash, ...).
 * When the spec names a `ratelimit` binding and it's bound, the platform
 * limiter runs (globally consistent); otherwise the KV fallback counts in
 * ROUTES — the path vitest and bindingless dev environments take.
 */
export async function rateLimit(
  env: Env,
  spec: RateLimitSpec,
  key: string
): Promise<RateLimitResult> {
  if (spec.binding) {
    // Generated Env marks bindings non-optional; the runtime may still lack
    // them in test/dev contexts, so keep the guard.
    const limiter = env[spec.binding] as RateLimit | undefined;
    if (limiter) {
      const { success } = await limiter.limit({ key });
      return {
        ok: success,
        // The binding doesn't report remaining budget — report the
        // full-window retry so Retry-After stays accurate.
        remaining: success ? spec.limit - 1 : 0,
        retryAfterSec: spec.windowSec,
      };
    }
  }
  const kv = env.ROUTES;
  const windowStart = Math.floor(Date.now() / 1000 / spec.windowSec);
  const kvKey = `${RATE_PREFIX}${spec.bucket}:${key}:${windowStart}`;
  const raw = await kv.get(kvKey);
  const count = (raw ? parseInt(raw, 10) : 0) + 1;
  const ttl = spec.windowSec - (Math.floor(Date.now() / 1000) % spec.windowSec) + 1;
  // KV enforces a 60s minimum expirationTtl — near the end of a short window
  // the computed ttl can drop below it, so clamp to the KV floor.
  await kv.put(kvKey, String(count), { expirationTtl: Math.max(ttl, 60) });
  return {
    ok: count <= spec.limit,
    remaining: Math.max(0, spec.limit - count),
    retryAfterSec: ttl,
  };
}

// Lane-specific specs — the single place the limits live.
export const LIMITS = {
  authChallenge: {
    bucket: "auth.challenge",
    limit: 10,
    windowSec: 60,
    binding: "RATE_LIMIT_AUTH_CHALLENGE",
  },
  authVerify: {
    bucket: "auth.verify",
    limit: 20,
    windowSec: 60,
    binding: "RATE_LIMIT_AUTH_VERIFY",
  },
  repoCreate: { bucket: "repo.create", limit: 10, windowSec: 3600 },
  ideaPost: { bucket: "idea.post", limit: 10, windowSec: 3600 },
  ideaImport: { bucket: "idea.import", limit: 5, windowSec: 3600 },
  siteBuild: { bucket: "site.build", limit: 5, windowSec: 3600 },
  patch: { bucket: "patch", limit: 60, windowSec: 60, binding: "RATE_LIMIT_PATCH" },
  vote: { bucket: "vote", limit: 30, windowSec: 60, binding: "RATE_LIMIT_VOTE" },
  tokenMint: { bucket: "token.mint", limit: 20, windowSec: 3600 },
  matchCreate: { bucket: "match.create", limit: 10, windowSec: 3600 },
  matchEnter: { bucket: "match.enter", limit: 10, windowSec: 3600 },
  matchVote: { bucket: "match.vote", limit: 30, windowSec: 3600 },
  workspaceCreate: { bucket: "workspace.create", limit: 10, windowSec: 3600 },
  vouch: { bucket: "vouch", limit: 30, windowSec: 3600 },
  epochAllocate: { bucket: "epoch.allocate", limit: 60, windowSec: 3600 },
} as const satisfies Record<string, RateLimitSpec>;

// ---------------------------------------------------------------------------
// Storage quotas — approximate byte accounting per namespace in KV
// ---------------------------------------------------------------------------

/** Default per-namespace storage quota: 2 GiB. */
export const DEFAULT_STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export async function getStorageUsed(kv: KVNamespace, namespaceId: string): Promise<number> {
  const raw = await kv.get(`${QUOTA_PREFIX}${namespaceId}`);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Check + charge a storage quota in one step. Returns false when the delta
 * would exceed the quota — nothing is charged on failure so callers can
 * surface a clean 413.
 */
export async function chargeStorageQuota(
  kv: KVNamespace,
  namespaceId: string,
  bytes: number,
  quotaBytes = DEFAULT_STORAGE_QUOTA_BYTES
): Promise<boolean> {
  if (bytes <= 0) return true;
  const used = await getStorageUsed(kv, namespaceId);
  if (used + bytes > quotaBytes) return false;
  await kv.put(`${QUOTA_PREFIX}${namespaceId}`, String(used + bytes));
  return true;
}

/** Release previously charged bytes (e.g. on repo deletion). */
export async function releaseStorageQuota(
  kv: KVNamespace,
  namespaceId: string,
  bytes: number
): Promise<void> {
  const used = await getStorageUsed(kv, namespaceId);
  await kv.put(`${QUOTA_PREFIX}${namespaceId}`, String(Math.max(0, used - bytes)));
}

// ---------------------------------------------------------------------------
// Analytics Engine
// ---------------------------------------------------------------------------

export type MetricEvent =
  | "request"
  | "agent.action"
  | "merge.outcome"
  | "quota.exceeded"
  | "rate.limited"
  | "auth.did"
  | "federate.push"
  | "overnight.stage"
  | "arena.enter"
  | "arena.vote"
  | "arena.resolve"
  | "artifacts.sync";

/**
 * Fire-and-forget metric. blobs: [event, lane/scope, detail]; doubles:
 * [count, size-or-latency]; indexes: [actor-or-repo] for sampling.
 */
export function metric(
  env: Env,
  event: MetricEvent,
  opts?: { scope?: string; detail?: string; value?: number; index?: string }
): void {
  try {
    // The binding is optional — absent until the account opts in to
    // Analytics Engine (see the commented binding in wrangler.jsonc).
    const ae = (env as { ANALYTICS?: AnalyticsEngineDataset }).ANALYTICS;
    ae?.writeDataPoint({
      blobs: [event, opts?.scope ?? "", (opts?.detail ?? "").slice(0, 200)],
      doubles: [1, opts?.value ?? 0],
      indexes: [(opts?.index ?? "").slice(0, 90)],
    });
  } catch {
    /* metrics must never break the request path */
  }
}
