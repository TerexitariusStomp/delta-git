import type { RepoQueueMessageHandle, WebhookQueueMessage } from "./types";

import { createLogger } from "@/worker/common";
import { deliverWebhook } from "@/worker/agent/webhooks";

/**
 * Queue consumer for outbound repo webhooks. The queue's retry semantics
 * give failed deliveries backoff for free; permanently failing endpoints
 * are surfaced via message.retry() until the queue's max_retries drops them.
 */
export async function handleWebhookMessage(
  message: Omit<RepoQueueMessageHandle<WebhookQueueMessage>, "body">,
  body: WebhookQueueMessage,
  env: Env
): Promise<void> {
  const log = createLogger(env.LOG_LEVEL, { service: "WebhookDeliver" });
  const result = await deliverWebhook({
    url: body.url,
    kind: body.event.kind,
    payload: body.event.payload,
    secret: body.secret ?? null,
  });
  if (!result.ok) {
    log.warn("webhook:delivery-failed", {
      doId: body.doId,
      url: body.url,
      status: result.status,
      attempts: message.attempts,
    });
    message.retry();
    return;
  }
  message.ack();
}
