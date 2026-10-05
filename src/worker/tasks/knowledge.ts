// Knowledge-refresh queue task — rebuild the repo KB on head advance.
// The build is HEAD-keyed; serving is lazy-fresh via refreshRepoKnowledge
// on read paths too, so this task exists to warm the cache post-push.

import { createLogger } from "@/worker/common/logger";
import { refreshRepoKnowledge } from "@/worker/knowledge";
import { createDb } from "@/worker/db/d1/client";
import { findRepositoryById } from "@/worker/db/d1/dal/repositories";

import type { KnowledgeRefreshQueueMessage, RepoQueueMessageHandle } from "./types";

export async function handleKnowledgeRefreshMessage(
  message: Omit<RepoQueueMessageHandle<KnowledgeRefreshQueueMessage>, "body">,
  body: KnowledgeRefreshQueueMessage,
  env: Env
): Promise<void> {
  const log = createLogger(env.LOG_LEVEL, {
    service: "KnowledgeRefresh",
    repoId: body.repoId,
  });
  try {
    // Plaintext boundary: E2E-encrypted repos have no server-readable
    // content — the KB plane only exists where the server can read
    // plaintext. Private non-encrypted repos are fine (endpoints are
    // read-gated).
    const repository = await findRepositoryById(createDb(env.DB), body.repoId);
    if (!repository || repository.encrypted === 1) {
      log.info("kb:skipped-encrypted", { repoId: body.repoId });
      message.ack();
      return;
    }
    // The head moved to body.sha — refresh keyed to it. Queue context has
    // no request cacheCtx; the build uses uncached reads.
    await refreshRepoKnowledge(env, body.repoId, body.sha, undefined);
    log.info("kb:refreshed", { ref: body.ref, sha: body.sha });
  } catch (err) {
    // A failed refresh is non-fatal — the next push or read retries.
    log.warn("kb:refresh-failed", { ref: body.ref, error: String(err) });
  }
  message.ack();
}

export async function enqueueKnowledgeRefresh(
  env: Env,
  doId: string,
  repoId: string,
  ref: string,
  sha: string
): Promise<void> {
  await env.REPO_TASKS_QUEUE.send({
    kind: "knowledge-refresh",
    doId,
    repoId,
    ref,
    sha,
  });
}
