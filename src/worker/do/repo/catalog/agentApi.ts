import type { CommitStatusRow, MergeIntentRow, WebhookSubRow, WorkIntentRow } from "../db/schema";
import type { RepoStateSchema } from "../repoState";

import { deltaRefFor, mergeIntentIdFor, MERGE_INTENT_TTL_MS } from "./diverge";
import {
  getDb,
  insertMergeIntent,
  insertWebhookSub,
  listActiveWebhookSubs,
  listCommitStatuses,
  listOpenWorkIntents,
  listRepoSecretMeta,
  upsertCommitStatus,
  upsertRepoSecret,
  listRepoSecretCiphertexts,
} from "../db";
import { appendOpLogEntry } from "./oplog";
import { asTypedStorage } from "../repoState";
import { ensureRepoMetadataDefaults } from "./shared";

// Remaining agent-layer DO state: commit statuses, webhook subscriptions,
// repo secrets (ciphertext only), work intents, and server-side patch
// acceptance (delta ref + merge intent minting without a client push).

const ZERO_OID = "0".repeat(40);

export type AcceptPatchResult =
  | { status: "accepted"; intent: MergeIntentRow }
  | { status: "exists"; intent: MergeIntentRow };

/**
 * Land a server-constructed commit as a delta ref + merge intent. Used by
 * the /patch endpoint and importer flows where the commit was built in the
 * worker rather than pushed by a git client.
 */
export async function acceptPatchCommitState(args: {
  ctx: DurableObjectState;
  targetRef: string;
  newOid: string;
  actor: string;
  kind: string;
}): Promise<AcceptPatchResult> {
  const store = asTypedStorage<RepoStateSchema>(args.ctx.storage);
  await ensureRepoMetadataDefaults(store);
  const db = getDb(args.ctx.storage);
  const now = Date.now();

  const currentRefs = (await store.get("refs")) || [];
  const deltaRef = deltaRefFor(args.targetRef, args.newOid);
  const intentId = mergeIntentIdFor(args.targetRef, args.newOid);
  const baseOid = currentRefs.find((ref) => ref.name === args.targetRef)?.oid ?? ZERO_OID;

  if (!currentRefs.some((ref) => ref.name === deltaRef)) {
    await store.put("refs", [...currentRefs, { name: deltaRef, oid: args.newOid }]);
    await store.put("refsVersion", ((await store.get("refsVersion")) || 0) + 1);
  }

  const intent: MergeIntentRow = {
    id: intentId,
    targetRef: args.targetRef,
    baseOid,
    deltaRef,
    deltaOid: args.newOid,
    actor: args.actor,
    status: "open",
    conflicts: null,
    resultOid: null,
    createdAt: now,
    expiresAt: now + MERGE_INTENT_TTL_MS,
    resolvedAt: null,
  };
  await insertMergeIntent(db, intent).catch(() => {});
  await appendOpLogEntry(
    db,
    {
      kind: args.kind,
      actor: args.actor,
      payload: {
        intentId,
        targetRef: args.targetRef,
        deltaRef,
        baseOid,
        deltaOid: args.newOid,
      },
    },
    now
  );
  return { status: "accepted", intent };
}

export async function setCommitStatusState(args: {
  ctx: DurableObjectState;
  row: CommitStatusRow;
  actor: string;
}): Promise<void> {
  const db = getDb(args.ctx.storage);
  await upsertCommitStatus(db, args.row);
  await appendOpLogEntry(
    db,
    {
      kind: "status.set",
      actor: args.actor,
      payload: { sha: args.row.sha, context: args.row.context, state: args.row.state },
    },
    Date.now()
  );
}

export async function getCommitStatusesState(
  ctx: DurableObjectState,
  sha: string
): Promise<CommitStatusRow[]> {
  return await listCommitStatuses(getDb(ctx.storage), sha);
}

export async function addWebhookSubState(args: {
  ctx: DurableObjectState;
  row: WebhookSubRow;
  actor: string;
}): Promise<void> {
  const db = getDb(args.ctx.storage);
  await insertWebhookSub(db, args.row);
  await appendOpLogEntry(
    db,
    {
      kind: "webhook.add",
      actor: args.actor,
      payload: { id: args.row.id, url: args.row.url, events: args.row.events },
    },
    Date.now()
  );
}

export async function listWebhookSubsState(ctx: DurableObjectState): Promise<WebhookSubRow[]> {
  return await listActiveWebhookSubs(getDb(ctx.storage));
}

export async function putRepoSecretState(args: {
  ctx: DurableObjectState;
  name: string;
  ciphertext: string;
  actor: string;
}): Promise<void> {
  const db = getDb(args.ctx.storage);
  const now = Date.now();
  await upsertRepoSecret(db, {
    name: args.name,
    ciphertext: args.ciphertext,
    createdBy: args.actor,
    createdAt: now,
    updatedAt: now,
  });
  await appendOpLogEntry(
    db,
    {
      kind: "secret.set",
      actor: args.actor,
      payload: { name: args.name },
    },
    now
  );
}

export async function listRepoSecretsMetaState(
  ctx: DurableObjectState
): Promise<{ name: string; createdAt: number; updatedAt: number }[]> {
  return await listRepoSecretMeta(getDb(ctx.storage));
}

/** Deploy-time only: returns ciphertexts for binding injection. Never HTTP. */
export async function listRepoSecretCiphertextsState(
  ctx: DurableObjectState
): Promise<{ name: string; ciphertext: string }[]> {
  return await listRepoSecretCiphertexts(getDb(ctx.storage));
}

export async function listWorkIntentsState(ctx: DurableObjectState): Promise<WorkIntentRow[]> {
  return await listOpenWorkIntents(getDb(ctx.storage));
}
