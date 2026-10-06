// CI push trigger — spawned per advancing head ref in receive finalize.
// Reads the repo's pipeline definitions, spawns a `pending` execution for
// each `on_push` pipeline whose branch filter (if any) matches the ref's
// short name. Executions stay pending until a delegate runner claims them.

import { createLogger } from "@/worker/common/logger";
import { readRepoPipelines } from "@/worker/api/gitness/stores";
import { createExecution } from "@/worker/api/gitness/executions";
import { syncWorkflowPipelines } from "@/worker/api/gitness/workflows";
import type { RepoQueueMessageHandle, PipelineTriggerQueueMessage } from "./types";

import { branchMatches } from "@/worker/api/gitness/stores";

export async function enqueuePipelineTrigger(
  env: Env,
  doId: string,
  repoId: string,
  ref: string,
  sha: string
): Promise<void> {
  await env.REPO_TASKS_QUEUE.send({
    kind: "pipeline-trigger",
    doId,
    repoId,
    ref,
    sha,
  });
}

export async function handlePipelineTriggerMessage(
  message: Omit<RepoQueueMessageHandle<PipelineTriggerQueueMessage>, "body">,
  body: PipelineTriggerQueueMessage,
  env: Env
): Promise<void> {
  const log = createLogger(env.LOG_LEVEL, {
    service: "PipelineTrigger",
    repoId: body.repoId,
  });
  const branch = body.ref.replace(/^refs\/heads\//, "");
  // Sync workflow files at the pushed sha first — a newly added on-push
  // workflow fires on the very push that introduced it (GitHub semantic).
  await syncWorkflowPipelines(env, body.repoId, body.sha).catch((err) =>
    log.warn("pipeline:workflow-sync-failed", { sha: body.sha, error: String(err) })
  );
  const pipes = await readRepoPipelines(env, body.repoId).catch(() => []);
  let spawned = 0;
  for (const pipe of pipes) {
    // Legacy on_push flag: full-repo trigger (branch list filters, if set).
    const legacyMatch =
      pipe.on_push === true && (!pipe.branches?.length || pipe.branches.includes(branch));
    // Declared triggers: enabled push events whose branch_scope matches.
    const triggerMatch = (pipe.triggers ?? []).some(
      (t) => t.enabled && t.event === "push" && branchMatches(t.branch_scope, branch)
    );
    if (!legacyMatch && !triggerMatch) continue;
    await createExecution(env, body.repoId, {
      pipeline: pipe,
      event: "push",
      ref: body.ref,
      after: body.sha,
    });
    spawned++;
  }
  if (spawned > 0) {
    log.info("pipeline:triggered", { ref: body.ref, sha: body.sha, spawned });
  }
  message.ack();
}
