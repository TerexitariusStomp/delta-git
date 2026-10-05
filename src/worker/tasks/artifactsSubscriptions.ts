import { z } from "zod";

import { createLogger } from "@/worker/common";

// Per-repo `cf.artifacts.repo.pushed` subscriptions.
//
// Cloudflare scopes `artifacts.repo` subscriptions to a single repo, so a
// subscription must be created for every canonical `dg-*` repo and every
// `ws-*` workspace fork the moment Artifacts provisions it. This helper is
// fire-and-forget (`ctx.waitUntil`): a subscription failure delays event
// delivery for that repo but must never fail repo/fork creation itself.
//
// Auth reuses the deploy lane's `CF_ACCOUNT_ID` + `CF_API_TOKEN` credentials
// (token needs Event Subscriptions write on the account). When they are
// absent — local dev, tests, or a deploy without the secret — the helper
// no-ops; `syncRemoteRepo` pull paths remain correct without events.
//
// Queue resolution is by name (not a stored id) so a recreated queue cannot
// silently strand subscriptions. The API enforces one subscription per
// (source, destination), which makes retries safe: a duplicate create is
// classified as already-subscribed rather than an error.

const ARTIFACTS_NAMESPACE = "delta-git";
const EVENTS_QUEUE_NAME = "dg-artifacts-events";
const CF_API = "https://api.cloudflare.com/client/v4";
const DUP_SUBSCRIPTION_RE = /multiple subscriptions on the same resource/;
// `.dev.vars` ships a placeholder token for local dev; don't burn an API
// call we know will 403.
const PLACEHOLDER_TOKEN = "local-placeholder";

const QueueListSchema = z.object({
  success: z.boolean(),
  result: z
    .array(z.object({ queue_id: z.string(), queue_name: z.string() }))
    .nullable()
    .optional(),
});

const CfEnvelopeSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

type Logger = ReturnType<typeof createLogger>;

async function cfApi(
  token: string,
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; errors: { message?: string }[] }> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const parsed = CfEnvelopeSchema.safeParse(await res.json().catch(() => null));
  const errors = parsed.success ? (parsed.data.errors ?? []) : [];
  return { ok: res.ok && parsed.success && parsed.data.success === true, errors };
}

async function resolveEventsQueueId(token: string, accountId: string): Promise<string | null> {
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/queues?name=${encodeURIComponent(EVENTS_QUEUE_NAME)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const parsed = QueueListSchema.safeParse(await res.json().catch(() => null));
  if (!res.ok || !parsed.success || parsed.data.success !== true) return null;
  return parsed.data.result?.find((q) => q.queue_name === EVENTS_QUEUE_NAME)?.queue_id ?? null;
}

async function subscribeRepoPushes(args: {
  env: Env;
  log: Logger;
  artifactsName: string;
}): Promise<void> {
  const { env, log, artifactsName } = args;
  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;

  const queueId = await resolveEventsQueueId(token, accountId);
  if (!queueId) {
    log.warn("artifacts-sub:queue-not-found", { artifactsName, queue: EVENTS_QUEUE_NAME });
    return;
  }

  const body = {
    name: `dg-push-${artifactsName}`,
    enabled: true,
    source: {
      type: "artifacts.repo",
      namespace: ARTIFACTS_NAMESPACE,
      repo_name: artifactsName,
    },
    events: ["pushed"],
    destination: { type: "queues.queue", queue_id: queueId },
  };
  const res = await cfApi(token, `/accounts/${accountId}/event_subscriptions/subscriptions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (res.ok) {
    log.info("artifacts-sub:created", { artifactsName });
    return;
  }
  const message = res.errors[0]?.message ?? "";
  if (DUP_SUBSCRIPTION_RE.test(message)) {
    // Repo was resubscribed (retry, re-fork name reuse) — already covered.
    log.debug("artifacts-sub:already-subscribed", { artifactsName });
    return;
  }
  log.warn("artifacts-sub:create-failed", {
    artifactsName,
    error: message || "unknown",
  });
}

/**
 * Best-effort subscription of an Artifacts repo's `pushed` events to the
 * `dg-artifacts-events` queue. Safe to call from any request context; work
 * is deferred to `ctx.waitUntil` and failures only log.
 */
export function ensureArtifactsPushSubscription(
  ctx: ExecutionContext,
  env: Env,
  artifactsName: string
): void {
  const log = createLogger(env.LOG_LEVEL, { service: "ArtifactsSub" });
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || env.CF_API_TOKEN === PLACEHOLDER_TOKEN) {
    log.debug("artifacts-sub:skipped", { artifactsName, reason: "cf-credentials-missing" });
    return;
  }
  ctx.waitUntil(
    subscribeRepoPushes({ env, log, artifactsName }).catch((error) => {
      log.warn("artifacts-sub:error", { artifactsName, error: String(error) });
    })
  );
}
