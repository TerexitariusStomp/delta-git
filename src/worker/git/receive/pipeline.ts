import type { CacheContext } from "@/worker/cache";
import type { Logger } from "@/worker/common/logger";
import type { RepoDurableObject } from "@/worker/do";
import type { MergeIntentRow, PackCatalogRow } from "@/worker/do/repo/db/schema";
import type { ReceiveCommand, ReceiveStatus } from "@/worker/git/operations/validation";

import { SubrequestLimiter } from "@/worker/git/operations/limits";
import {
  resolveDeltasAndWriteIdx,
  runPackConnectivityCheck,
  scanPack,
} from "@/worker/git/pack/indexer";
import { doPrefix, r2PackKey } from "@/worker/keys";
import { createDb } from "@/worker/db/d1/client";
import { findRepositoryByDoName } from "@/worker/db/d1/dal/repositories";
import { listMembershipsForNamespace } from "@/worker/db/d1/dal/namespaces";
import { deliverNotification } from "@/worker/notify/notify";
import { findScanRunForHead, scanStatusSatisfiesPolicy } from "@/worker/db/d1/dal/scanRuns";
import { newPrefixedId } from "@/worker/common";
import { readSecuritySettings } from "@/worker/api/gitness/stores";
import { evaluateDeliveryGates } from "@/worker/api/gitness/delivery";
import { enqueueFederatePush } from "@/worker/tasks/federate";
import { enqueuePipelineTrigger } from "@/worker/tasks/pipeline";
import { enqueueKnowledgeRefresh } from "@/worker/tasks/knowledge";
import { deliverWebhookEvent } from "@/worker/agent/webhooks";
import { chargeStorageQuota, metric } from "@/worker/agent/abuse";
import { deleteStagedPack, stagePackToR2, type StagedPackUpload } from "./r2Upload";
import { buildReceiveReportStatus, isReceiveAbort, throwIfReceiveAborted } from "./support";

type RepoStub = DurableObjectStub<RepoDurableObject>;

export type ReceivePipelineResult = {
  reportStatusBody: Uint8Array;
  changed: boolean;
  empty: boolean;
  packKey?: string;
  packBytes?: number;
  /** Merge intents minted when the push was accepted as divergent. */
  deltaIntents?: MergeIntentRow[];
};

export class ReceivePipelineHttpError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string, message: string) {
    super(message);
    this.name = "ReceivePipelineHttpError";
    this.status = status;
    this.reason = reason;
  }
}

type ReceiveCleanupAttempt = "inline" | "retry";

async function abortReceiveLease(args: {
  stub: RepoStub;
  leaseToken: string;
  log: Logger;
  reason: string;
  attempt: ReceiveCleanupAttempt;
}): Promise<boolean> {
  try {
    const cleared = await args.stub.abortReceive(args.leaseToken);
    if (!cleared) {
      args.log.warn("receive:abort-missed", {
        reason: args.reason,
        attempt: args.attempt,
        leaseToken: args.leaseToken,
      });
    }
    return cleared;
  } catch (error) {
    args.log.warn("receive:abort-failed", {
      reason: args.reason,
      attempt: args.attempt,
      leaseToken: args.leaseToken,
      error: String(error),
    });
    return false;
  }
}

async function cleanupStagedPack(args: {
  stagedUpload: StagedPackUpload | undefined;
  log: Logger;
  reason: string;
  attempt: ReceiveCleanupAttempt;
}): Promise<boolean> {
  if (!args.stagedUpload) return true;

  try {
    await deleteStagedPack(args.stagedUpload);
    return true;
  } catch (error) {
    args.log.warn("receive:staged-pack-cleanup-failed", {
      reason: args.reason,
      attempt: args.attempt,
      packKey: args.stagedUpload.packKey,
      error: String(error),
    });
    return false;
  }
}

async function cleanupFailedReceive(args: {
  ctx: ExecutionContext;
  stub: RepoStub;
  leaseToken: string;
  stagedUpload: StagedPackUpload | undefined;
  log: Logger;
  reason: string;
}): Promise<void> {
  const leaseCleared = await abortReceiveLease({
    stub: args.stub,
    leaseToken: args.leaseToken,
    log: args.log,
    reason: args.reason,
    attempt: "inline",
  });
  const stagedPackDeleted = await cleanupStagedPack({
    stagedUpload: args.stagedUpload,
    log: args.log,
    reason: args.reason,
    attempt: "inline",
  });

  if (leaseCleared && stagedPackDeleted) return;

  args.log.warn("receive:cleanup-retry-scheduled", {
    reason: args.reason,
    leaseToken: args.leaseToken,
    packKey: args.stagedUpload?.packKey,
  });
  args.ctx.waitUntil(
    (async () => {
      const retryLeaseCleared =
        leaseCleared ||
        (await abortReceiveLease({
          stub: args.stub,
          leaseToken: args.leaseToken,
          log: args.log,
          reason: args.reason,
          attempt: "retry",
        }));
      const retryStagedPackDeleted =
        stagedPackDeleted ||
        (await cleanupStagedPack({
          stagedUpload: args.stagedUpload,
          log: args.log,
          reason: args.reason,
          attempt: "retry",
        }));

      if (!retryLeaseCleared || !retryStagedPackDeleted) {
        args.log.error("receive:cleanup-retry-incomplete", {
          reason: args.reason,
          leaseCleared: retryLeaseCleared,
          stagedPackDeleted: retryStagedPackDeleted,
          leaseToken: args.leaseToken,
          packKey: args.stagedUpload?.packKey,
        });
      }
    })()
  );
}

type ExecuteReceivePipelineArgs = {
  env: Env;
  repoId: string;
  /** Owning namespace id — used for per-owner storage quota charging. */
  namespaceId?: string;
  /** "owner/repo" slug carried into `push` webhook payloads. */
  repoSlug?: string;
  request: Request;
  ctx: ExecutionContext;
  packStream: ReadableStream<Uint8Array>;
  bytesConsumed: number;
  stub: RepoStub;
  leaseToken: string;
  activeCatalog: PackCatalogRow[];
  commands: ReceiveCommand[];
  /** `push-options` strings recorded on the op-log entry and webhook payload. */
  pushOptions?: string[];
  log: Logger;
  /** Pusher identity recorded on divergent merge intents. */
  actor?: string;
  cacheCtx: CacheContext;
  limiter: SubrequestLimiter;
  countSubrequest(op: string, n?: number): void;
  onProgress?: (message: string) => void;
};

function buildReceiveResult(args: {
  unpackOk: boolean;
  unpackMessage?: string;
  commands: ReceiveCommand[];
  statuses: ReceiveStatus[];
  changed: boolean;
  empty: boolean;
  packKey?: string;
  packBytes?: number;
  deltaIntents?: MergeIntentRow[];
}): ReceivePipelineResult {
  return {
    reportStatusBody: buildReceiveReportStatus({
      unpackOk: args.unpackOk,
      unpackMessage: args.unpackMessage,
      commands: args.commands,
      statuses: args.statuses,
    }),
    changed: args.changed,
    empty: args.empty,
    packKey: args.packKey,
    packBytes: args.packBytes,
    deltaIntents: args.deltaIntents,
  };
}

export async function executeReceivePipeline(
  args: ExecuteReceivePipelineArgs
): Promise<ReceivePipelineResult> {
  let stagedUpload: StagedPackUpload | undefined;

  try {
    const hasNonDelete = args.commands.some((command) => !/^0{40}$/i.test(command.newOid));

    // Push-scan gate: when the repo's security policy is "require", every new
    // head must carry a prior pass/warn scan attestation (see dg/scan-attest).
    // Attestations arrive before the push, keyed by head oid — a missing or
    // failed attestation rejects the whole receive before the pack is staged.
    if (hasNonDelete) {
      const scanPolicy = (await readSecuritySettings(args.env, args.repoId)).push_scan;
      if (scanPolicy === "require") {
        const db = createDb(args.env.DB);
        const repoRow = await findRepositoryByDoName(db, args.repoId);
        const missing: string[] = [];
        for (const command of args.commands) {
          if (/^0{40}$/i.test(command.newOid)) continue;
          const run = repoRow
            ? await findScanRunForHead(db, repoRow.id, command.newOid.toLowerCase())
            : undefined;
          if (!run || !scanStatusSatisfiesPolicy(run.status)) missing.push(command.ref);
        }
        if (missing.length > 0) {
          args.log.warn("receive:scan-required", {
            repoId: args.repoId,
            missingCount: missing.length,
          });
          await abortReceiveLease({
            stub: args.stub,
            leaseToken: args.leaseToken,
            log: args.log,
            reason: "scan-required",
            attempt: "inline",
          });
          const message =
            "push scan required: run `dgit push` (or install `dgit hooks`) so the " +
            "client-side scanner attests these heads, or ask an admin to relax " +
            "the repo's scanning policy";
          return buildReceiveResult({
            unpackOk: false,
            unpackMessage: message,
            commands: args.commands,
            statuses: args.commands.map((command) => ({
              ref: command.ref,
              ok: false,
              message,
            })),
            changed: false,
            empty: false,
          });
        }
      }
    }

    // Delivery gates: namespace freeze windows + enforce-mode policies reject
    // pushes before the pack is staged. Warn-mode hits are logged only.
    if (hasNonDelete && args.namespaceId) {
      const db = createDb(args.env.DB);
      const gate = await evaluateDeliveryGates(db, args.namespaceId, {
        op: "push",
        branch: args.commands
          .find((c) => !/^0{40}$/i.test(c.newOid))
          ?.ref.replace(/^refs\/heads\//, ""),
        actor: args.actor,
      });
      for (const warning of gate.warnings) {
        args.log.warn("receive:policy-warn", { repoId: args.repoId, warning });
      }
      if (!gate.ok) {
        args.log.warn("receive:gate-deny", { repoId: args.repoId, deny: gate.deny });
        await abortReceiveLease({
          stub: args.stub,
          leaseToken: args.leaseToken,
          log: args.log,
          reason: "gate-deny",
          attempt: "inline",
        });
        const message = gate.deny ?? "push denied by delivery gate";
        return buildReceiveResult({
          unpackOk: false,
          unpackMessage: message,
          commands: args.commands,
          statuses: args.commands.map((command) => ({
            ref: command.ref,
            ok: false,
            message,
          })),
          changed: false,
          empty: false,
        });
      }
    }

    let stagedPack:
      | {
          packKey: string;
          packBytes: number;
          idxBytes: number;
          objectCount: number;
        }
      | undefined;

    if (hasNonDelete) {
      const packKey = r2PackKey(
        doPrefix(args.stub.id.toString()),
        `pack-rx-${args.leaseToken}.pack`
      );
      stagedUpload = await stagePackToR2({
        env: args.env,
        request: args.request,
        packStream: args.packStream,
        packKey,
        bytesConsumed: args.bytesConsumed,
        limiter: args.limiter,
        countSubrequest: args.countSubrequest,
        onProgress: args.onProgress,
      });
      throwIfReceiveAborted(args.request, args.log, "stage-pack");

      const scanResult = await scanPack({
        env: args.env,
        packKey: stagedUpload.packKey,
        packSize: stagedUpload.packBytes,
        limiter: args.limiter,
        countSubrequest: (n = 1) => args.countSubrequest("r2:scan-pack", n),
        log: args.log,
        signal: args.request.signal,
        onProgress: args.onProgress,
      });
      throwIfReceiveAborted(args.request, args.log, "scan-pack");

      const resolveResult = await resolveDeltasAndWriteIdx({
        env: args.env,
        packKey: stagedUpload.packKey,
        packSize: stagedUpload.packBytes,
        limiter: args.limiter,
        countSubrequest: (n = 1) => args.countSubrequest("r2:resolve-pack", n),
        log: args.log,
        scanResult,
        activeCatalog: args.activeCatalog,
        cacheCtx: args.cacheCtx,
        repoId: args.repoId,
        signal: args.request.signal,
        onProgress: args.onProgress,
      });
      throwIfReceiveAborted(args.request, args.log, "resolve-pack");

      const connectivityStatuses = args.commands.map((command) => ({
        ref: command.ref,
        ok: true,
      }));
      args.onProgress?.("Checking received object connectivity\n");
      await runPackConnectivityCheck({
        env: args.env,
        repoId: args.repoId,
        newPackKey: stagedUpload.packKey,
        newIdxView: resolveResult.idxView,
        newPackSize: stagedUpload.packBytes,
        activeCatalog: args.activeCatalog,
        commands: args.commands,
        statuses: connectivityStatuses,
        log: args.log,
        cacheCtx: args.cacheCtx,
      });
      throwIfReceiveAborted(args.request, args.log, "connectivity-check");

      if (!connectivityStatuses.every((status) => status.ok)) {
        args.countSubrequest("do:abort-receive");
        await cleanupFailedReceive({
          ctx: args.ctx,
          stub: args.stub,
          leaseToken: args.leaseToken,
          stagedUpload,
          log: args.log,
          reason: "connectivity-rejected",
        });
        args.log.warn("receive:connectivity-rejected", {
          conflictCount: connectivityStatuses.filter((status) => !status.ok).length,
        });
        return buildReceiveResult({
          unpackOk: true,
          commands: args.commands,
          statuses: connectivityStatuses,
          changed: false,
          empty: false,
        });
      }

      stagedPack = {
        packKey: stagedUpload.packKey,
        packBytes: stagedUpload.packBytes,
        idxBytes: resolveResult.idxBytes,
        objectCount: resolveResult.objectCount,
      };

      // Per-owner storage quota (Phase 2 abuse controls): charge the staged
      // pack+idx bytes against the namespace budget before committing. The
      // accounting is approximate KV bookkeeping — hard invariants stay in
      // the DO; quota rejections surface as a clean unpack failure.
      if (args.namespaceId && stagedPack) {
        const charged = await chargeStorageQuota(
          args.env.ROUTES,
          args.namespaceId,
          stagedPack.packBytes + stagedPack.idxBytes
        ).catch(() => true); // quota store unavailable → fail open, log below
        if (!charged) {
          metric(args.env, "quota.exceeded", {
            scope: "receive",
            index: args.namespaceId,
            value: stagedPack.packBytes + stagedPack.idxBytes,
          });
          args.log.warn("receive:quota-exceeded", {
            repoId: args.repoId,
            bytes: stagedPack.packBytes + stagedPack.idxBytes,
          });
          await cleanupFailedReceive({
            ctx: args.ctx,
            stub: args.stub,
            leaseToken: args.leaseToken,
            stagedUpload,
            log: args.log,
            reason: "quota-exceeded",
          });
          return buildReceiveResult({
            unpackOk: false,
            unpackMessage: "storage quota exceeded for this namespace",
            commands: args.commands,
            statuses: args.commands.map((command) => ({
              ref: command.ref,
              ok: false,
              message: "storage quota exceeded",
            })),
            changed: false,
            empty: false,
          });
        }
      }
    }

    args.countSubrequest("do:finalize-receive");
    throwIfReceiveAborted(args.request, args.log, "finalize-receive");
    args.onProgress?.("Updating refs\n");
    const finalize = await args.stub.finalizeReceive({
      token: args.leaseToken,
      commands: args.commands,
      actor: args.actor,
      pushOptions: args.pushOptions,
      stagedPack,
    });

    if (finalize.status === "lease_mismatch") {
      await cleanupStagedPack({
        stagedUpload,
        log: args.log,
        reason: "finalize-lease-mismatch",
        attempt: "inline",
      });
      args.log.warn("receive:lease-mismatch", { leaseToken: args.leaseToken });
      throw new ReceivePipelineHttpError(
        503,
        "lease-mismatch",
        "Repository receive lease expired before commit."
      );
    }

    if (finalize.status === "ref_conflict") {
      await cleanupStagedPack({
        stagedUpload,
        log: args.log,
        reason: "finalize-ref-conflict",
        attempt: "inline",
      });
      args.log.warn("receive:ref-conflict", {
        conflictCount: finalize.statuses.filter((status) => !status.ok).length,
        stage: "finalize",
      });
      return buildReceiveResult({
        unpackOk: true,
        commands: args.commands,
        statuses: finalize.statuses,
        changed: false,
        empty: false,
      });
    }

    if (finalize.shouldQueueCompaction) {
      args.log.info("receive:compaction-requested", { repoId: args.repoId });
      args.ctx.waitUntil(
        args.env.REPO_TASKS_QUEUE.send({
          kind: "compaction",
          doId: args.stub.id.toString(),
          repoId: args.repoId,
        }).catch((error) => {
          args.log.warn("receive:compaction-enqueue-failed", {
            repoId: args.repoId,
            error: String(error),
          });
        })
      );
    }

    // Deploy-on-commit: every successful heads-ref advance enqueues the
    // deploy lane (static → /pages serving, dynamic → Workers Scripts API).
    for (let i = 0; i < args.commands.length; i++) {
      const command = args.commands[i];
      const status = finalize.statuses[i];
      if (
        !status?.ok ||
        !command.ref.startsWith("refs/heads/") ||
        /^0{40}$/i.test(command.newOid)
      ) {
        continue;
      }
      args.ctx.waitUntil(
        args.env.REPO_TASKS_QUEUE.send({
          kind: "deploy",
          doId: args.stub.id.toString(),
          repoId: args.repoId,
          ref: command.ref,
          sha: command.newOid,
          actor: args.actor,
        }).catch((error) => {
          args.log.warn("receive:deploy-enqueue-failed", {
            repoId: args.repoId,
            ref: command.ref,
            error: String(error),
          });
        })
      );
      // Mirror-out federation: the task itself filters private repos and
      // repos without configured targets, so enqueue unconditionally.
      args.ctx.waitUntil(
        enqueueFederatePush(
          args.env,
          args.stub.id.toString(),
          args.repoId,
          command.ref,
          command.newOid
        ).catch(() => {})
      );
      // CI push trigger: spawn pending executions for `on_push` pipelines.
      // The task no-ops when the repo has none.
      args.ctx.waitUntil(
        enqueuePipelineTrigger(
          args.env,
          args.stub.id.toString(),
          args.repoId,
          command.ref,
          command.newOid
        ).catch(() => {})
      );
      // Knowledge-base refresh: rebuild symbols/graph/summary for the new
      // HEAD. The task itself skips E2E-encrypted repos (no server-side
      // plaintext); endpoints enforce read access on serving.
      args.ctx.waitUntil(
        enqueueKnowledgeRefresh(
          args.env,
          args.stub.id.toString(),
          args.repoId,
          command.ref,
          command.newOid
        ).catch(() => {})
      );
      // Repo webhook subscribers (e.g. wp-cloud push→redeploy) get a `push`
      // event per advanced heads ref — same fan-out path as agent pushes.
      args.ctx.waitUntil(
        deliverWebhookEvent(args.env, args.repoId, args.stub, {
          kind: "push",
          payload: {
            repo: args.repoSlug,
            ref: command.ref,
            oid: command.newOid,
            options: args.pushOptions,
          },
        }).catch((error) => {
          args.log.warn("receive:webhook-enqueue-failed", {
            repoId: args.repoId,
            ref: command.ref,
            error: String(error),
          });
        })
      );
    }

    // Notifications inbox: every successful heads-ref advance writes a `push`
    // notification to each namespace member except the pusher.
    const advancedRefs = args.commands
      .map((command, i) => ({ command, status: finalize.statuses[i] }))
      .filter(
        ({ command, status }) =>
          status?.ok && command.ref.startsWith("refs/heads/") && !/^0{40}$/i.test(command.newOid)
      );
    if (advancedRefs.length > 0 && args.namespaceId) {
      const db = createDb(args.env.DB);
      args.ctx.waitUntil(
        (async () => {
          const members = await listMembershipsForNamespace(db, args.namespaceId!);
          const refList = advancedRefs
            .map(({ command }) => command.ref.replace(/^refs\/heads\//, ""))
            .join(", ");
          for (const member of members) {
            if (member.userId === args.actor) continue;
            await deliverNotification(args.env, db, {
              id: newPrefixedId("ntf"),
              userId: member.userId,
              kind: "push",
              title: `${args.repoSlug ?? args.repoId}: push to ${refList}`,
              body: `${args.actor ?? "someone"} pushed ${advancedRefs.length} ref update(s)`,
              link: args.repoSlug ? `/${args.repoSlug}` : null,
              createdAt: Date.now(),
              readAt: null,
            });
          }
        })().catch((error) => {
          args.log.warn("receive:notify-failed", {
            repoId: args.repoId,
            error: String(error),
          });
        })
      );
    }

    return buildReceiveResult({
      unpackOk: true,
      commands: args.commands,
      statuses: finalize.statuses,
      changed: finalize.changed,
      empty: finalize.empty,
      packKey: stagedPack?.packKey,
      packBytes: stagedPack?.packBytes,
      deltaIntents: finalize.deltaIntents,
    });
  } catch (error) {
    args.countSubrequest("do:abort-receive");
    const aborted = isReceiveAbort(args.request, error);
    await cleanupFailedReceive({
      ctx: args.ctx,
      stub: args.stub,
      leaseToken: args.leaseToken,
      stagedUpload,
      log: args.log,
      reason: aborted ? "receive-aborted" : "receive-error",
    });
    throw error;
  }
}
