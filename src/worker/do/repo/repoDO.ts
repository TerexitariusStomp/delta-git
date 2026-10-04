import type { Head } from "./repoState";
import type { RepoActivity } from "@/worker/common";
import type { PackCatalogRow } from "./db/schema";

import { DurableObject } from "cloudflare:workers";

import { doPrefix } from "@/worker/keys";
import { text, createLogger } from "@/worker/common";
import { clearRepositoryStorage, removePack, type RemovePackResult } from "./packOperations";
import {
  abortCompactionLease,
  abortReceiveLease,
  type BeginCompactionResult,
  beginCompactionState,
  beginReceiveLease,
  type ClearCompactionRequestResult,
  clearCompactionRequestState,
  clearExpiredLeases,
  type CommitCompactionResult,
  commitCompactionState,
  finalizeReceiveState,
  type PreviewCompactionResult,
  previewCompactionState,
  type RequestCompactionResult,
  requestCompactionState,
  rearmCompactionQueueFromAlarm,
  getActivePackCatalogSnapshot,
  getRepoActivitySnapshot,
} from "./catalog";
import { getRefs, setRefs, resolveHead, setHead, getHeadAndRefs } from "./refs";
import {
  castMergeVoteState,
  claimMergeIntentState,
  commitMergeState,
  getMergeIntentState,
  listMergeIntentsState,
  listMergeVotesState,
  listOpLogState,
  markMergeAdjudicatingState,
} from "./catalog/merge";
import {
  acceptPatchCommitState,
  addWebhookSubState,
  claimWorkIntentState,
  closeWorkIntentState,
  createWorkIntentState,
  getCommitStatusesState,
  importPackState,
  listRepoSecretCiphertextsState,
  listRepoSecretsMetaState,
  listWebhookSubsState,
  listWorkIntentsState,
  putRepoSecretState,
  setCommitStatusState,
} from "./catalog/agentApi";
import type { CommitStatusRow, WebhookSubRow, WorkIntentRow } from "./db/schema";
import type { StagedImportPack } from "./catalog/agentApi";
import { handleIdleAndMaintenance } from "./maintenance";
import {
  debugState,
  debugCheckCommit,
  debugCheckOid,
  type DebugCommitCheck,
  type DebugOidCheck,
  type DebugStateSnapshot,
} from "./debug";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { getDb } from "./db";
import migrations from "../../../../drizzle/repo-do/migrations.js";
import {
  ensureAccessAndAlarm,
  touchAndMaybeSchedule,
  type RepoDOAccessContext,
} from "./repoDO/access";
import { seedMinimalRepoState } from "./repoDO/seeding";

/**
 * Repository Durable Object (per-repo authority)
 *
 * Responsibilities
 * - Acts as the strongly consistent source of truth for repository metadata.
 * - Stores refs, HEAD, and pack catalog state in DO storage/SQLite.
 * - All operations are provided as typed RPC methods on the class.
 *
 * Read Path (RPC)
 * - Correctness reads live in worker-local pack-first helpers under `src/worker/git/object-store/`.
 * - There is no public HTTP endpoint for object reads; this keeps internal state access typed
 *   and easy to audit.
 *
 * Write Path
 * - Streaming receive: the Worker writes staged `.pack` and `.idx` data to R2, then
 *   commits refs and pack-catalog metadata through typed DO RPCs.
 *
 * Maintenance & Background Work
 * - `alarm()` handles: lease cleanup, compaction queue re-arm, idle cleanup.
 * - The DO is the metadata authority; the data plane lives in R2 packs.
 */
export class RepoDurableObject extends DurableObject {
  declare env: Env;
  private lastAccessMemMs: number | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.lastAccessMemMs = await ctx.storage.get("lastAccessMs");
      const db = getDb(ctx.storage);
      await migrate(db, migrations);
      // The constructor also runs before `alarm()`. Do not touch
      // `lastAccessMs` here, or an alarm wakeup would make an idle object look
      // freshly accessed and would keep cleanup from ever seeing it as idle.
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.touchAndMaybeSchedule();
    } catch {}
    this.logger.debug("fetch", { path: new URL(request.url).pathname, method: request.method });
    return text("Not found\n", 404);
  }

  async alarm(): Promise<void> {
    this.logger.debug("alarm:start", {});

    await clearExpiredLeases(this.ctx, this.logger);

    if (
      await rearmCompactionQueueFromAlarm({ ctx: this.ctx, env: this.env, logger: this.logger })
    ) {
      return;
    }

    await handleIdleAndMaintenance(this.ctx, this.env, this.logger);
    this.logger.debug("alarm:end", {});
  }

  private async touchAndMaybeSchedule(): Promise<void> {
    await touchAndMaybeSchedule(this.accessContext());
  }

  private async ensureAccessAndAlarm(): Promise<void> {
    await ensureAccessAndAlarm(this.accessContext());
  }

  private accessContext(): RepoDOAccessContext {
    return {
      ctx: this.ctx,
      env: this.env,
      logger: this.logger,
      getLastAccessMemMs: () => this.lastAccessMemMs,
      setLastAccessMemMs: (value) => {
        this.lastAccessMemMs = value;
      },
    };
  }

  public async listRefs(): Promise<{ name: string; oid: string }[]> {
    await this.ensureAccessAndAlarm();
    return await getRefs(this.ctx);
  }

  public async setRefs(refs: { name: string; oid: string }[]): Promise<void> {
    await this.ensureAccessAndAlarm();
    await setRefs(this.ctx, refs);
  }

  public async getHead(): Promise<Head> {
    await this.ensureAccessAndAlarm();
    return await resolveHead(this.ctx);
  }

  public async setHead(head: Head): Promise<void> {
    await this.ensureAccessAndAlarm();
    await setHead(this.ctx, head);
  }

  public async getHeadAndRefs(): Promise<{ head: Head; refs: { name: string; oid: string }[] }> {
    await this.ensureAccessAndAlarm();
    return await getHeadAndRefs(this.ctx);
  }

  public async getActivePackCatalog(): Promise<PackCatalogRow[]> {
    await this.ensureAccessAndAlarm();
    return await getActivePackCatalogSnapshot(this.ctx);
  }

  public async getRepoActivity(): Promise<RepoActivity | null> {
    await this.ensureAccessAndAlarm();
    const snapshot = await getRepoActivitySnapshot(this.ctx);
    if (snapshot.state === "idle") return null;
    return {
      state: snapshot.state,
      startedAt: snapshot.lease.createdAt,
      expiresAt: snapshot.lease.expiresAt,
    };
  }

  public async beginReceive() {
    await this.ensureAccessAndAlarm();
    return await beginReceiveLease(this.ctx, this.logger);
  }

  public async abortReceive(token: string): Promise<boolean> {
    await this.ensureAccessAndAlarm();
    return await abortReceiveLease(this.ctx, token);
  }

  public async finalizeReceive(args: {
    token: string;
    commands: Array<{ oldOid: string; newOid: string; ref: string }>;
    actor?: string;
    stagedPack?:
      | {
          packKey: string;
          packBytes: number;
          idxBytes: number;
          objectCount: number;
        }
      | undefined;
  }) {
    await this.ensureAccessAndAlarm();
    return await finalizeReceiveState({
      ctx: this.ctx,
      env: this.env,
      token: args.token,
      commands: args.commands,
      actor: args.actor,
      stagedPack: args.stagedPack,
      logger: this.logger,
    });
  }

  public async beginCompaction(): Promise<BeginCompactionResult> {
    await this.ensureAccessAndAlarm();
    return await beginCompactionState({
      ctx: this.ctx,
      env: this.env,
      prefix: this.prefix(),
      logger: this.logger,
    });
  }

  public async abortCompaction(token: string): Promise<boolean> {
    await this.ensureAccessAndAlarm();
    return await abortCompactionLease(this.ctx, token);
  }

  public async commitCompaction(args: {
    token: string;
    sourcePacks: PackCatalogRow[];
    targetTier: number;
    packsetVersion: number;
    stagedPack: {
      packKey: string;
      packBytes: number;
      idxBytes: number;
      objectCount: number;
    };
  }): Promise<CommitCompactionResult> {
    await this.ensureAccessAndAlarm();
    return await commitCompactionState({
      ctx: this.ctx,
      env: this.env,
      token: args.token,
      sourcePacks: args.sourcePacks,
      targetTier: args.targetTier,
      packsetVersion: args.packsetVersion,
      stagedPack: args.stagedPack,
      logger: this.logger,
    });
  }

  public async previewCompaction(): Promise<PreviewCompactionResult> {
    await this.ensureAccessAndAlarm();
    return await previewCompactionState({
      ctx: this.ctx,
      env: this.env,
      prefix: this.prefix(),
      logger: this.logger,
    });
  }

  public async requestCompaction(): Promise<RequestCompactionResult> {
    await this.ensureAccessAndAlarm();
    return await requestCompactionState({
      ctx: this.ctx,
      env: this.env,
      prefix: this.prefix(),
      logger: this.logger,
    });
  }

  public async clearCompactionRequest(): Promise<ClearCompactionRequestResult> {
    await this.ensureAccessAndAlarm();
    return await clearCompactionRequestState({
      ctx: this.ctx,
      logger: this.logger,
    });
  }

  public async debugState(): Promise<DebugStateSnapshot> {
    await this.ensureAccessAndAlarm();
    return await debugState(this.ctx, this.env);
  }

  public async debugCheckCommit(commit: string): Promise<DebugCommitCheck> {
    await this.ensureAccessAndAlarm();
    return await debugCheckCommit(this.ctx, this.env, commit);
  }

  public async debugCheckOid(oid: string): Promise<DebugOidCheck> {
    await this.ensureAccessAndAlarm();
    return await debugCheckOid(this.ctx, this.env, oid);
  }

  // -------------------------------------------------------------------------
  // delta-git agent layer RPCs
  // -------------------------------------------------------------------------

  public async listMergeIntents(statuses: string[]) {
    await this.ensureAccessAndAlarm();
    return await listMergeIntentsState(this.ctx, statuses);
  }

  public async getMergeIntent(id: string) {
    await this.ensureAccessAndAlarm();
    return await getMergeIntentState(this.ctx, id);
  }

  public async claimMergeIntent(id: string) {
    await this.ensureAccessAndAlarm();
    return await claimMergeIntentState(this.ctx, id);
  }

  public async listMergeVotes(intentId: string) {
    await this.ensureAccessAndAlarm();
    return await listMergeVotesState(this.ctx, intentId);
  }

  public async listOpLog(sinceSeq: number) {
    await this.ensureAccessAndAlarm();
    return await listOpLogState(this.ctx, sinceSeq);
  }

  public async commitMerge(args: {
    intentId: string;
    expectedBaseOid: string;
    mergeOid: string;
    stagedPack: {
      packKey: string;
      packBytes: number;
      idxBytes: number;
      objectCount: number;
    };
    actor: string;
    method: "auto" | "adjudicated";
  }) {
    await this.ensureAccessAndAlarm();
    return await commitMergeState({
      ctx: this.ctx,
      env: this.env,
      intentId: args.intentId,
      expectedBaseOid: args.expectedBaseOid,
      mergeOid: args.mergeOid,
      stagedPack: args.stagedPack,
      actor: args.actor,
      method: args.method,
      logger: this.logger,
    });
  }

  public async markMergeAdjudicating(args: {
    intentId: string;
    conflicts: string[];
    actor: string;
  }) {
    await this.ensureAccessAndAlarm();
    return await markMergeAdjudicatingState({
      ctx: this.ctx,
      intentId: args.intentId,
      conflicts: args.conflicts,
      actor: args.actor,
    });
  }

  public async castMergeVote(args: {
    intentId: string;
    voterDid: string;
    resolutionDigest: string;
    rationale?: string;
    signature: string;
    quorumK: number;
  }) {
    await this.ensureAccessAndAlarm();
    return await castMergeVoteState({
      ctx: this.ctx,
      intentId: args.intentId,
      voterDid: args.voterDid,
      resolutionDigest: args.resolutionDigest,
      rationale: args.rationale,
      signature: args.signature,
      quorumK: args.quorumK,
    });
  }

  public async acceptPatchCommit(args: {
    targetRef: string;
    newOid: string;
    actor: string;
    kind: string;
  }) {
    await this.ensureAccessAndAlarm();
    return await acceptPatchCommitState({
      ctx: this.ctx,
      targetRef: args.targetRef,
      newOid: args.newOid,
      actor: args.actor,
      kind: args.kind,
    });
  }

  public async setCommitStatus(args: { row: CommitStatusRow; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await setCommitStatusState({ ctx: this.ctx, row: args.row, actor: args.actor });
  }

  public async getCommitStatuses(sha: string) {
    await this.ensureAccessAndAlarm();
    return await getCommitStatusesState(this.ctx, sha);
  }

  public async addWebhookSub(args: { row: WebhookSubRow; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await addWebhookSubState({ ctx: this.ctx, row: args.row, actor: args.actor });
  }

  public async listWebhookSubs() {
    await this.ensureAccessAndAlarm();
    return await listWebhookSubsState(this.ctx);
  }

  public async putRepoSecret(args: { name: string; ciphertext: string; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await putRepoSecretState({
      ctx: this.ctx,
      name: args.name,
      ciphertext: args.ciphertext,
      actor: args.actor,
    });
  }

  public async listRepoSecretMeta() {
    await this.ensureAccessAndAlarm();
    return await listRepoSecretsMetaState(this.ctx);
  }

  /** Deploy-time binding injection only; never exposed over HTTP. */
  public async listRepoSecretCiphertexts() {
    await this.ensureAccessAndAlarm();
    return await listRepoSecretCiphertextsState(this.ctx);
  }

  public async listWorkIntents() {
    await this.ensureAccessAndAlarm();
    return await listWorkIntentsState(this.ctx);
  }

  public async createWorkIntent(args: { row: WorkIntentRow; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await createWorkIntentState({ ctx: this.ctx, row: args.row, actor: args.actor });
  }

  public async claimWorkIntent(args: { id: string; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await claimWorkIntentState({ ctx: this.ctx, id: args.id, actor: args.actor });
  }

  public async closeWorkIntent(args: { id: string; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await closeWorkIntentState({ ctx: this.ctx, id: args.id, actor: args.actor });
  }

  public async importPack(args: {
    packs: StagedImportPack[];
    refs: { name: string; oid: string }[];
    head: { target: string; oid: string };
    actor: string;
  }) {
    await this.ensureAccessAndAlarm();
    return await importPackState({
      ctx: this.ctx,
      packs: args.packs,
      refs: args.refs,
      head: args.head,
      actor: args.actor,
    });
  }

  private prefix() {
    return doPrefix(this.ctx.id.toString());
  }

  private get logger() {
    return createLogger(this.env.LOG_LEVEL, {
      service: "RepoDO",
      doId: this.ctx.id.toString(),
    });
  }

  public async seedMinimalRepo(
    withPack: boolean = true
  ): Promise<{ commitOid: string; treeOid: string }> {
    await this.ensureAccessAndAlarm();
    return await seedMinimalRepoState({
      ctx: this.ctx,
      env: this.env,
      prefix: this.prefix(),
      withPack,
    });
  }

  // DO-only storage clear used by the `repository-delete` queue consumer
  // after R2 cleanup. Callers must NOT chain this from a Worker handler that
  // also enumerates R2 - that would be the forbidden Worker -> DO -> R2 hop.
  public async clearRepositoryStorage(): Promise<{ deletedDO: boolean }> {
    return await clearRepositoryStorage(this.ctx, this.env);
  }

  public async removePack(packKey: string): Promise<RemovePackResult> {
    await this.ensureAccessAndAlarm();
    return await removePack(this.ctx, this.env, packKey);
  }
}
