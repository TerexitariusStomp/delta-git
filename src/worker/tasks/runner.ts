// Platform runner dispatch — a `runner-dispatch` queue message nudges the
// built-in Cloudflare delegate to drain a repo's pending executions.
//
// The enqueue delay is the external-delegate grace window: a repo's own
// runners poll on their own cadence and get first pick; whatever is still
// `pending` when the delayed message lands belongs to the platform runner.

import { createLogger } from "@/worker/common/logger";
import { runPlatformRunnerOnce } from "@/worker/runner/platform";
import type { RepoQueueMessageHandle, RunnerDispatchQueueMessage } from "./types";

/** Grace window for client-side delegates before the platform claims. */
export const RUNNER_DISPATCH_DELAY_SECONDS = 25;

export async function enqueueRunnerDispatch(
  env: Env,
  repoId: string,
  delaySeconds = RUNNER_DISPATCH_DELAY_SECONDS
): Promise<void> {
  await env.REPO_TASKS_QUEUE.send({ kind: "runner-dispatch", repoId }, { delaySeconds });
}

export async function handleRunnerDispatchMessage(
  message: Omit<RepoQueueMessageHandle<RunnerDispatchQueueMessage>, "body">,
  body: RunnerDispatchQueueMessage,
  env: Env
): Promise<void> {
  const log = createLogger(env.LOG_LEVEL, { service: "RunnerDispatch", repoId: body.repoId });
  // Drain the backlog — each claimed exec re-checks `pending` at claim
  // time, so this loop stops the moment a client delegate wins or the
  // queue empties.
  const claimed = await runPlatformRunnerOnce(env, body.repoId).catch((err) => {
    log.warn("runner:dispatch-failed", { error: String(err) });
    return false;
  });
  if (claimed) {
    // More work may remain — re-dispatch without the grace delay.
    await env.REPO_TASKS_QUEUE.send({ kind: "runner-dispatch", repoId: body.repoId });
  }
  message.ack();
}
