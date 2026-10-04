import type { CommitStatusRow, MergeIntentRow, WebhookSubRow, WorkIntentRow } from "../db/schema";
import type { RepoStateSchema } from "../repoState";

import { deltaRefFor, mergeIntentIdFor, MERGE_INTENT_TTL_MS } from "./diverge";
import {
  getDb,
  getWorkIntent,
  insertMergeIntent,
  insertWebhookSub,
  insertWorkIntent,
  listActiveWebhookSubs,
  listCommitStatuses,
  listOpenWorkIntents,
  listRepoSecretMeta,
  updateWorkIntent,
  upsertCommitStatus,
  upsertPackCatalogRow,
  upsertRepoSecret,
  listRepoSecretCiphertexts,
} from "../db";
import { appendOpLogEntry } from "./oplog";
import { asTypedStorage } from "../repoState";
import { bumpPacksetVersion, ensureRepoMetadataDefaults } from "./shared";

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

export type ImportPackResult = { status: "imported" } | { status: "not_empty"; refs: number };

/**
 * Register a pack fetched from an external remote and set the repo's refs.
 * Only permitted on an empty repo (no refs) so imports can't clobber
 * existing history — the agent equivalent of `git clone` into a fresh repo.
 * The pack bytes and idx must already be staged in R2 at packKey.
 */
export type StagedImportPack = {
  packKey: string;
  packBytes: number;
  idxBytes: number;
  objectCount: number;
};

export async function importPackState(args: {
  ctx: DurableObjectState;
  packs: StagedImportPack[];
  refs: { name: string; oid: string }[];
  head: { target: string; oid: string };
  actor: string;
}): Promise<ImportPackResult> {
  const store = asTypedStorage<RepoStateSchema>(args.ctx.storage);
  await ensureRepoMetadataDefaults(store);
  const db = getDb(args.ctx.storage);

  const existing = ((await store.get("refs")) || []).filter((ref) => ref.name.startsWith("refs/"));
  if (existing.length > 0) return { status: "not_empty", refs: existing.length };

  let seq = (await store.get("nextPackSeq")) || 1;
  let totalObjects = 0;
  for (const pack of args.packs) {
    await upsertPackCatalogRow(db, {
      packKey: pack.packKey,
      kind: "receive",
      state: "active",
      tier: 0,
      seqLo: seq,
      seqHi: seq,
      objectCount: pack.objectCount,
      packBytes: pack.packBytes,
      idxBytes: pack.idxBytes,
      createdAt: Date.now(),
      supersededBy: null,
    });
    totalObjects += pack.objectCount;
    seq++;
  }
  await store.put("nextPackSeq", seq);
  await bumpPacksetVersion(store);
  await store.put("refs", args.refs);
  await store.put("refsVersion", ((await store.get("refsVersion")) || 0) + 1);
  await store.put("head", args.head);
  await appendOpLogEntry(
    db,
    {
      kind: "repo.import",
      actor: args.actor,
      payload: {
        packs: args.packs.length,
        refs: args.refs.length,
        head: args.head.target,
        objects: totalObjects,
      },
    },
    Date.now()
  );
  return { status: "imported" };
}

/** Post a claimable work item (PostEarn-style bounty lane, minus payout). */
export async function createWorkIntentState(args: {
  ctx: DurableObjectState;
  row: WorkIntentRow;
  actor: string;
}): Promise<WorkIntentRow> {
  const db = getDb(args.ctx.storage);
  await insertWorkIntent(db, args.row);
  await appendOpLogEntry(
    db,
    {
      kind: "work.post",
      actor: args.actor,
      payload: { id: args.row.id, title: args.row.title },
    },
    Date.now()
  );
  return args.row;
}

const WORK_CLAIM_MS = 30 * 60 * 1000;

/**
 * Claim an open work intent under a short lease. Expired claims reopen so
 * abandoned work returns to the pool — same lease discipline as receives.
 */
export async function claimWorkIntentState(args: {
  ctx: DurableObjectState;
  id: string;
  actor: string;
}): Promise<{ status: "claimed"; row: WorkIntentRow } | { status: "unavailable" }> {
  const db = getDb(args.ctx.storage);
  const row = await getWorkIntent(db, args.id);
  if (!row) return { status: "unavailable" };
  const now = Date.now();
  const claimLive = row.claimExpiresAt != null && row.claimExpiresAt > now;
  if (row.status !== "open" && claimLive) return { status: "unavailable" };
  const next: WorkIntentRow = {
    ...row,
    status: "claimed",
    claimedBy: args.actor,
    claimExpiresAt: now + WORK_CLAIM_MS,
  };
  await updateWorkIntent(db, args.id, {
    status: "claimed",
    claimedBy: args.actor,
    claimExpiresAt: next.claimExpiresAt,
  });
  await appendOpLogEntry(
    db,
    {
      kind: "work.claim",
      actor: args.actor,
      payload: { id: args.id },
    },
    now
  );
  return { status: "claimed", row: next };
}

/** Close a work intent (its claimant or its poster may close it). */
export async function closeWorkIntentState(args: {
  ctx: DurableObjectState;
  id: string;
  actor: string;
}): Promise<{ status: "closed" } | { status: "unavailable" }> {
  const db = getDb(args.ctx.storage);
  const row = await getWorkIntent(db, args.id);
  if (!row) return { status: "unavailable" };
  if (row.status === "claimed" && row.claimedBy !== args.actor && row.createdBy !== args.actor) {
    return { status: "unavailable" };
  }
  await updateWorkIntent(db, args.id, { status: "closed", closedAt: Date.now() });
  await appendOpLogEntry(
    db,
    {
      kind: "work.close",
      actor: args.actor,
      payload: { id: args.id },
    },
    Date.now()
  );
  return { status: "closed" };
}
