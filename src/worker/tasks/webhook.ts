import type { RepoQueueMessageHandle, WebhookQueueMessage } from "./types";

/**
 * Queue consumer for outbound repo webhooks. Delivery runs inside the
 * FirehoseAgent runtime DO, which keeps a durable per-subscriber ledger
 * (delivered/failed counts, last error). The queue's retry semantics give
 * failed deliveries backoff for free; permanently failing endpoints are
 * surfaced via message.retry() until max_retries drops them — the ledger
 * retains the failure history either way.
 */
export async function handleWebhookMessage(
  message: Omit<RepoQueueMessageHandle<WebhookQueueMessage>, "body">,
  body: WebhookQueueMessage,
  env: Env
): Promise<void> {
  const agent = env.FIREHOSE_DO.get(env.FIREHOSE_DO.idFromName("firehose"));
  const result = await agent.runQueueTask(body);
  if (result.action === "retry") message.retry();
  else message.ack();
}
