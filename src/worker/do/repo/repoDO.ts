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
  advanceMergeIntentDeltaState,
  castMergeVoteState,
  claimMergeIntentState,
  commitMergeState,
  getMergeIntentState,
  listMergeIntentsState,
  listMergeVotesState,
  listOpLogState,
  markMergeAdjudicatingState,
  markMergeUpToDateState,
  releaseMergeIntentState,
  rejectMergeIntentState,
} from "./catalog/merge";
import {
  advanceMatchPhasesState,
  attachWorkspaceState,
  castMatchVoteState,
  createMatchState,
  enterMatchState,
  getMatchState,
  getWorkspaceState,
  ingestRemoteSyncState,
  listMatchesState,
  recordProcessedEventState,
  recordWorkspacePushState,
  resolveMatchState,
  sweepWorkspacesState,
  type MatchSettlement,
} from "./catalog/arena";
import {
  addIssueCommentState,
  createIssueState,
  createLabelState,
  createMilestoneState,
  deleteIssueCommentState,
  editIssueCommentState,
  getIssueState,
  listIssueCommentsState,
  listIssueReactionsState,
  listIssuesState,
  listLabelsState,
  listMilestonesState,
  setIssueReactionState,
  updateIssueState,
  updateMilestoneState,
  type IssuePatch,
} from "./catalog/issues";
import {
  acceptPatchCommitState,
  addWebhookSubState,
  castWorkVoteState,
  claimWorkIntentState,
  closeWorkIntentState,
  createWorkIntentState,
  deleteRepoSecretState,
  getCommitStatusesState,
  getWorkIntentState,
  updateWebhookSubState,
  deleteWebhookSubState,
  importPackState,
  listRecentCommitStatusesState,
  listRepoSecretCiphertextsState,
  listRepoSecretsMetaState,
  listWebhookSubsState,
  listWorkIntentsByKindState,
  listWorkIntentsState,
  listWorkVotesState,
  putRepoSecretState,
  setCommitStatusState,
  updateWorkIntentResultState,
} from "./catalog/agentApi";
import type {
  CommitStatusRow,
  MatchRow,
  WebhookSubRow,
  WorkIntentRow,
  WorkspaceRow,
} from "./db/schema";
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

    // Arena lifecycle: move building→judging past endsAt and surface
    // judging-past-deadline matches as resolve-needed queue messages.
    try {
      const phases = await advanceMatchPhasesState(this.ctx, Date.now());
      for (const pending of phases.resolveNeeded) {
        await this.env.REPO_TASKS_QUEUE.send({
          kind: "arena-resolve",
          doId: this.ctx.id.toString(),
          repoId: pending.doName,
          matchId: pending.matchId,
        });
      }
      // Reap workspace forks whose matches finished or that outlived the
      // task TTL — Artifacts namespace quota is finite.
      await sweepWorkspacesState({ ctx: this.ctx, env: this.env, now: Date.now() });
      if (phases.judged.length || phases.resolveNeeded.length) {
        this.logger.info("arena:alarm-advanced", {
          judged: phases.judged.length,
          resolveNeeded: phases.resolveNeeded.length,
        });
      }
    } catch (e) {
      this.logger.warn("arena:alarm-advance-failed", { error: String(e) });
    }

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

  public async advanceMergeIntentDelta(args: {
    intentId: string;
    newOid: string;
    actor: string;
    stagedPack?: {
      packKey: string;
      packBytes: number;
      idxBytes: number;
      objectCount: number;
    };
  }) {
    await this.ensureAccessAndAlarm();
    return await advanceMergeIntentDeltaState({
      ctx: this.ctx,
      env: this.env,
      intentId: args.intentId,
      newOid: args.newOid,
      actor: args.actor,
      stagedPack: args.stagedPack,
    });
  }

  public async rejectMergeIntent(args: { id: string; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await rejectMergeIntentState({
      ctx: this.ctx,
      intentId: args.id,
      actor: args.actor,
    });
  }

  public async releaseMergeIntent(args: { id: string; reason: string; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await releaseMergeIntentState({
      ctx: this.ctx,
      intentId: args.id,
      reason: args.reason,
      actor: args.actor,
    });
  }

  public async markMergeUpToDate(args: { intentId: string; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await markMergeUpToDateState({
      ctx: this.ctx,
      intentId: args.intentId,
      actor: args.actor,
    });
  }

  public async acceptPatchCommit(args: {
    targetRef: string;
    newOid: string;
    actor: string;
    kind: string;
    stagedPack?: {
      packKey: string;
      packBytes: number;
      idxBytes: number;
      objectCount: number;
    };
  }) {
    await this.ensureAccessAndAlarm();
    return await acceptPatchCommitState({
      ctx: this.ctx,
      env: this.env,
      targetRef: args.targetRef,
      newOid: args.newOid,
      actor: args.actor,
      kind: args.kind,
      stagedPack: args.stagedPack,
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

  public async listRecentCommitStatuses(limit = 50) {
    await this.ensureAccessAndAlarm();
    return await listRecentCommitStatusesState(this.ctx, limit);
  }

  public async addWebhookSub(args: { row: WebhookSubRow; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await addWebhookSubState({ ctx: this.ctx, row: args.row, actor: args.actor });
  }

  public async updateWebhookSub(args: {
    id: string;
    patch: { url?: string; events?: string; secret?: string | null; active?: boolean };
    actor: string;
  }) {
    await this.ensureAccessAndAlarm();
    return await updateWebhookSubState({ ctx: this.ctx, ...args });
  }

  public async deleteWebhookSub(args: { id: string; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await deleteWebhookSubState({ ctx: this.ctx, ...args });
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

  public async deleteRepoSecret(args: { name: string; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await deleteRepoSecretState({ ctx: this.ctx, ...args });
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

  public async getWorkIntent(id: string) {
    await this.ensureAccessAndAlarm();
    return await getWorkIntentState(this.ctx, id);
  }

  public async listWorkIntentsByKind(kind: string) {
    await this.ensureAccessAndAlarm();
    return await listWorkIntentsByKindState(this.ctx, kind);
  }

  public async updateWorkIntentResult(args: { id: string; result: string; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await updateWorkIntentResultState({ ctx: this.ctx, ...args });
  }

  public async castWorkVote(args: {
    workIntentId: string;
    voterDid: string;
    resolutionDigest: string;
    rationale?: string;
    signature: string;
    quorumK: number;
  }) {
    await this.ensureAccessAndAlarm();
    return await castWorkVoteState({ ctx: this.ctx, ...args });
  }

  public async listWorkVotes(workIntentId: string) {
    await this.ensureAccessAndAlarm();
    return await listWorkVotesState(this.ctx, workIntentId);
  }

  // --- issues (GitHub-shaped tracker over materialized work intents) ------

  public async createIssue(args: {
    title: string;
    body: string | null;
    actor: string;
    assignees?: string[];
    labelIds?: string[];
    milestoneId?: string | null;
  }) {
    await this.ensureAccessAndAlarm();
    return await createIssueState({ ctx: this.ctx, ...args });
  }

  public async listIssues(args: { state?: "open" | "closed"; limit?: number }) {
    await this.ensureAccessAndAlarm();
    return await listIssuesState(this.ctx, args);
  }

  public async getIssue(number: number) {
    await this.ensureAccessAndAlarm();
    return await getIssueState(this.ctx, number);
  }

  public async updateIssue(args: { number: number; patch: IssuePatch; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await updateIssueState({ ctx: this.ctx, ...args });
  }

  public async addIssueComment(args: { number: number; body: string; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await addIssueCommentState({ ctx: this.ctx, ...args });
  }

  public async listIssueComments(number: number) {
    await this.ensureAccessAndAlarm();
    return await listIssueCommentsState(this.ctx, number);
  }

  public async editIssueComment(args: { commentId: string; body: string; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await editIssueCommentState({ ctx: this.ctx, ...args });
  }

  public async deleteIssueComment(args: { commentId: string; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await deleteIssueCommentState({ ctx: this.ctx, ...args });
  }

  public async setIssueReaction(args: {
    number: number;
    reaction: string;
    actor: string;
    add: boolean;
  }) {
    await this.ensureAccessAndAlarm();
    return await setIssueReactionState({ ctx: this.ctx, ...args });
  }

  public async listIssueReactions(number: number) {
    await this.ensureAccessAndAlarm();
    return await listIssueReactionsState(this.ctx, number);
  }

  public async createMilestone(args: {
    title: string;
    description: string | null;
    dueOn: number | null;
    actor: string;
  }) {
    await this.ensureAccessAndAlarm();
    return await createMilestoneState({ ctx: this.ctx, ...args });
  }

  public async listMilestones(args: { state?: "open" | "closed" }) {
    await this.ensureAccessAndAlarm();
    return await listMilestonesState(this.ctx, args);
  }

  public async updateMilestone(args: {
    number: number;
    patch: {
      title?: string;
      description?: string | null;
      state?: "open" | "closed";
      dueOn?: number | null;
    };
    actor: string;
  }) {
    await this.ensureAccessAndAlarm();
    return await updateMilestoneState({ ctx: this.ctx, ...args });
  }

  public async createLabel(args: {
    name: string;
    color: string;
    description: string | null;
    actor: string;
  }) {
    await this.ensureAccessAndAlarm();
    return await createLabelState({ ctx: this.ctx, ...args });
  }

  public async listLabels() {
    await this.ensureAccessAndAlarm();
    return await listLabelsState(this.ctx);
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

  // --- workspaces + arena -------------------------------------------------

  public async attachWorkspace(args: { row: WorkspaceRow; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await attachWorkspaceState({ ctx: this.ctx, ...args });
  }

  public async getWorkspace(artifactsName: string) {
    await this.ensureAccessAndAlarm();
    return await getWorkspaceState(this.ctx, artifactsName);
  }

  public async recordWorkspacePush(args: {
    artifactsName: string;
    headOid: string;
    actor: string;
    stagedPack?: StagedImportPack;
  }) {
    await this.ensureAccessAndAlarm();
    return await recordWorkspacePushState({ ctx: this.ctx, ...args });
  }

  public async ingestRemoteSync(args: {
    packs: StagedImportPack[];
    refs: { name: string; oid: string }[];
    head?: { target: string; oid: string };
    actor: string;
  }) {
    await this.ensureAccessAndAlarm();
    return await ingestRemoteSyncState({ ctx: this.ctx, ...args });
  }

  public async recordProcessedEvent(eventId: string) {
    await this.ensureAccessAndAlarm();
    return await recordProcessedEventState(this.ctx, eventId);
  }

  public async createMatch(args: { row: MatchRow; actor: string }) {
    await this.ensureAccessAndAlarm();
    return await createMatchState({ ctx: this.ctx, ...args });
  }

  public async getMatch(id: string) {
    await this.ensureAccessAndAlarm();
    return await getMatchState(this.ctx, id);
  }

  public async listMatches(statuses: string[]) {
    await this.ensureAccessAndAlarm();
    return await listMatchesState(this.ctx, statuses);
  }

  public async enterMatch(args: {
    matchId: string;
    entryId: string;
    entrantDid: string;
    workspaceName: string;
    actor: string;
  }) {
    await this.ensureAccessAndAlarm();
    return await enterMatchState({ ctx: this.ctx, ...args });
  }

  public async castMatchVote(args: {
    matchId: string;
    voterDid: string;
    entryId: string;
    stake?: number;
  }) {
    await this.ensureAccessAndAlarm();
    return await castMatchVoteState({ ctx: this.ctx, ...args });
  }

  public async resolveMatch(args: {
    matchId: string;
    winnerEntryId: string | null;
    scores: { entryId: string; autoScore: number; voteCount: number; voteWeight?: number }[];
    settlement?: MatchSettlement;
    actor: string;
  }) {
    await this.ensureAccessAndAlarm();
    return await resolveMatchState({ ctx: this.ctx, ...args });
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
