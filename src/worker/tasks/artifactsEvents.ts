import { z } from "zod";

import { createLogger } from "@/worker/common";
import { metric } from "@/worker/agent/abuse";
import { createDb } from "@/worker/db/d1/client";
import { getRepoStub } from "@/worker/common";
import { eq } from "drizzle-orm";
import { repositories } from "@/worker/db/d1/schema";
import { syncRemoteRepo } from "@/worker/agent/importer";

// Cloudflare Artifacts lifecycle events → queue consumer.
//
// Events arrive on the dedicated `dg-artifacts-events` queue (a separate
// consumer because the payload schema is Cloudflare-owned, not our
// RepoTaskQueueMessage union). Two shapes matter:
//
//   - Push on a canonical `dg-*` repo → refresh the DO object mirror so
//     reads/merges see the new head (someone pushed to the remote
//     directly with an artifacts token).
//   - Push on a `ws-<dg>-*` workspace fork → fetch the fork head into the
//     canonical DO and record the push (stats + merge intent for task
//     workspaces; arena entries accumulate toward judging).
//
// Delivery is at-least-once; the canonical repo DO dedupes on event id.

const ArtifactsPushEventSchema = z.object({
  id: z.string().optional(),
  type: z.literal("cf.artifacts.repo.pushed"),
  source: z.object({
    type: z.literal("artifacts.repo").optional(),
    namespace: z.string(),
    repoName: z.string(),
  }),
  payload: z.object({
    ref: z.string(),
    before: z.string(),
    after: z.string(),
  }),
});

// Workspace fork names embed the canonical repo's Artifacts name:
// `ws-dg-<32hex>-<8hex>`.
const WORKSPACE_NAME_RE = /^ws-(dg-[0-9a-f]{32})-[0-9a-f]{8,}$/;

async function findRepoByArtifactsName(env: Env, artifactsName: string) {
  const db = createDb(env.DB);
  const rows = await db
    .select()
    .from(repositories)
    .where(eq(repositories.artifactsName, artifactsName))
    .limit(1);
  return rows[0];
}

/** Mint a short-lived read token for an Artifacts repo (never persisted). */
async function mintReadToken(
  env: Env,
  artifactsName: string
): Promise<{ remote: string; auth: string } | null> {
  const artifacts = env.ARTIFACTS;
  if (!artifacts) return null;
  const repo = await artifacts.get(artifactsName);
  const token = await repo.createToken("read", 900);
  // Bearer auth is the recommended header for art_v1_* tokens.
  return { remote: repo.remote, auth: `Bearer ${token.plaintext}` };
}

async function handleCanonicalPush(
  env: Env,
  repoName: string,
  after: string,
  eventId: string,
  log: ReturnType<typeof createLogger>
): Promise<string> {
  const repo = await findRepoByArtifactsName(env, repoName);
  if (!repo) return "unknown-canonical";
  const stub = getRepoStub(env, repo.doName);
  if (!(await stub.recordProcessedEvent(eventId))) return "duplicate";

  const creds = await mintReadToken(env, repoName);
  if (!creds) return "artifacts-unavailable";
  const result = await syncRemoteRepo({
    env,
    repoId: repo.doName,
    stub,
    url: creds.remote,
    actor: "artifacts-event",
    headers: { Authorization: creds.auth },
  });
  if (result.kind !== "synced") return `sync-failed:${result.reason}`;
  metric(env, "artifacts.sync", { scope: "canonical", index: repo.id });
  log.info("artifacts:canonical-synced", { repoName, after });
  return "synced";
}

async function handleWorkspacePush(
  env: Env,
  repoName: string,
  after: string,
  eventId: string,
  log: ReturnType<typeof createLogger>
): Promise<string> {
  const match = WORKSPACE_NAME_RE.exec(repoName);
  if (!match) return "unknown-workspace-name";
  const canonicalName = match[1]!;
  const repo = await findRepoByArtifactsName(env, canonicalName);
  if (!repo) return "unknown-canonical";
  const stub = getRepoStub(env, repo.doName);
  if (!(await stub.recordProcessedEvent(eventId))) return "duplicate";

  // Fetch the fork's pushed head into the canonical DO mirror so merge
  // machinery can read the objects. Bounded: single tip, haves = our refs.
  const creds = await mintReadToken(env, repoName);
  if (!creds) return "artifacts-unavailable";

  // Workspace forks share the canonical history, so a full syncRemoteRepo
  // is incremental anyway (haves cover the shared base).
  const result = await syncRemoteRepo({
    env,
    repoId: repo.doName,
    stub,
    url: creds.remote,
    actor: "artifacts-event",
    headers: { Authorization: creds.auth },
  });
  if (result.kind !== "synced") return `fetch-failed:${result.reason}`;

  const recorded = await stub.recordWorkspacePush({
    artifactsName: repoName,
    headOid: after,
    actor: "artifacts-event",
  });
  metric(env, "artifacts.sync", { scope: "workspace", index: repo.id });
  log.info("artifacts:workspace-push", { repoName, after, recorded: recorded.status });
  return recorded.status === "recorded" ? "recorded" : "unknown-workspace";
}

export async function handleArtifactsEventBatch(
  batch: MessageBatch<unknown>,
  env: Env
): Promise<void> {
  const log = createLogger(env.LOG_LEVEL, { service: "ArtifactsEvents" });
  for (const message of batch.messages) {
    let outcome = "ok";
    try {
      const parsed = ArtifactsPushEventSchema.safeParse(message.body);
      if (!parsed.success) {
        // Other cf.artifacts.repo.* events (created/deleted/forked/token.*)
        // don't drive mirror state — acknowledge and move on.
        outcome = "ignored";
        message.ack();
        continue;
      }
      const event = parsed.data;
      const eventId =
        event.id ?? `${event.source.repoName}:${event.payload.ref}:${event.payload.after}`;
      const { repoName } = event.source;
      const { after } = event.payload;

      if (WORKSPACE_NAME_RE.test(repoName)) {
        outcome = await handleWorkspacePush(env, repoName, after, eventId, log);
      } else {
        outcome = await handleCanonicalPush(env, repoName, after, eventId, log);
      }
      log.debug("artifacts:event-handled", { repoName, outcome });
      message.ack();
    } catch (e) {
      log.warn("artifacts:event-error", { error: String(e) });
      message.retry();
    }
  }
}

// Test seams.
export const __test = { WORKSPACE_NAME_RE };
