import type { RepoDurableObject } from "@/worker/do";

// Outbound webhook delivery for repo events.
//
// Delivery fans out through the repo's task queue (`REPO_TASKS_QUEUE`) so
// retries/backoff ride Cloudflare Queues instead of request-lifetime hacks.
// Signing follows the Standard Webhooks spec (HMAC-SHA256 over
// `id.timestamp.body`, `webhook-signature` header) when the subscription
// carries a secret.

const te = new TextEncoder();

export type WebhookEvent = {
  kind: string;
  payload: Record<string, unknown>;
};

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(message)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return `v1,${btoa(bin)}`;
}

/** Direct delivery used by the queue consumer. */
export async function deliverWebhook(args: {
  url: string;
  kind: string;
  payload: Record<string, unknown>;
  secret?: string | null;
}): Promise<{ ok: boolean; status: number }> {
  const id = `msg_${crypto.randomUUID()}`;
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ type: args.kind, data: args.payload });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(ts),
  };
  if (args.secret) {
    headers["webhook-signature"] = await hmacSign(args.secret, `${id}.${ts}.${body}`);
  }
  try {
    const res = await fetch(args.url, { method: "POST", headers, body });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * Fan out one repo event to matching subscriptions. Called from worker
 * request paths; enqueues one message per subscriber so a slow endpoint
 * can't stall the request.
 */
export async function deliverWebhookEvent(
  env: Env,
  repoId: string | undefined,
  stub: DurableObjectStub<RepoDurableObject>,
  event: WebhookEvent
): Promise<void> {
  const subs = await stub.listWebhookSubs();
  for (const sub of subs) {
    if (!sub.events.split(",").includes(event.kind)) continue;
    await env.REPO_TASKS_QUEUE.send({
      kind: "webhook",
      doId: stub.id.toString(),
      repoId,
      url: sub.url,
      secret: sub.secret,
      event: { kind: event.kind, payload: event.payload },
    });
  }
}
