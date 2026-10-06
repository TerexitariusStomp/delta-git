import type { Logger } from "@/worker/common/logger";
import type { MergeIntentRow } from "../db/schema";
import type { RepoStateSchema } from "../repoState";

import { asTypedStorage } from "../repoState";
import {
  applyReceiveCommands,
  isValidRefName,
  type ReceiveCommand,
  type ReceiveStatus,
  validateReceiveCommands,
} from "@/worker/git/operations/validation";
import {
  countOpenIntentsForRef,
  getDb,
  insertMergeIntent,
  listActivePackCatalog,
  upsertPackCatalogRow,
} from "../db";
import { planDivergence } from "./diverge";
import { appendOpLogEntry } from "./oplog";
import { DEFAULT_HEAD, bumpPacksetVersion, ensureRepoMetadataDefaults } from "./shared";
import { catalogNeedsCompaction, scheduleCompactionWake } from "./compaction/plan";

export type FinalizeReceiveResult =
  | {
      status: "committed";
      statuses: ReceiveStatus[];
      changed: boolean;
      empty: boolean;
      shouldQueueCompaction: boolean;
      /** Merge intents minted for commands accepted as divergent pushes. */
      deltaIntents?: MergeIntentRow[];
    }
  | {
      status: "ref_conflict";
      statuses: ReceiveStatus[];
      message: string;
    }
  | {
      status: "lease_mismatch";
      message: string;
    };

function resolveHeadAfterReceive(args: {
  storedHead:
    | {
        target: string;
        oid?: string;
        unborn?: boolean;
      }
    | undefined;
  refs: Array<{ name: string; oid: string }>;
}) {
  const target = args.storedHead?.target || DEFAULT_HEAD.target;
  const match = args.refs.find((ref) => ref.name === target);
  if (match) {
    return { target, oid: match.oid } as const;
  }
  return { target, unborn: true } as const;
}

export async function finalizeReceiveState(args: {
  ctx: DurableObjectState;
  env: Env;
  token: string;
  commands: ReceiveCommand[];
  /** Pusher identity recorded on divergent intents and the op log. */
  actor?: string;
  /** `push-option` strings recorded on the `push.received` op-log entry. */
  pushOptions?: string[];
  stagedPack?:
    | {
        packKey: string;
        packBytes: number;
        idxBytes: number;
        objectCount: number;
      }
    | undefined;
  logger?: Logger;
}): Promise<FinalizeReceiveResult> {
  const store = asTypedStorage<RepoStateSchema>(args.ctx.storage);
  await ensureRepoMetadataDefaults(store);

  const lease = await store.get("receiveLease");
  if (!lease || lease.token !== args.token) {
    return {
      status: "lease_mismatch",
      message: "Receive lease is no longer active for this request.",
    };
  }

  const currentRefs = (await store.get("refs")) || [];
  const invalidStatuses = args.commands
    .filter((command) => !isValidRefName(command.ref))
    .map((command) => ({ ref: command.ref, ok: false, msg: "invalid" satisfies string }));
  if (invalidStatuses.length > 0) {
    await store.delete("receiveLease");
    args.logger?.warn("receive:finalize-invalid-ref", {
      invalidCount: invalidStatuses.length,
    });
    return {
      status: "ref_conflict",
      statuses: invalidStatuses,
      message: "Receive finalization rejected invalid refs.",
    };
  }

  const statuses = validateReceiveCommands(currentRefs, args.commands);
  let effectiveCommands = args.commands;
  let effectiveStatuses = statuses;
  let deltaIntents: MergeIntentRow[] | undefined;

  if (!statuses.every((status) => status.ok)) {
    const db = getDb(args.ctx.storage);
    const openIntentCounts = new Map<string, number>();
    for (const command of args.commands) {
      if (openIntentCounts.has(command.ref)) continue;
      openIntentCounts.set(command.ref, await countOpenIntentsForRef(db, command.ref));
    }
    const plan = planDivergence({
      currentRefs,
      commands: args.commands,
      statuses,
      actor: args.actor ?? "anonymous",
      now: Date.now(),
      openIntentCounts,
    });
    if (plan.kind === "rejected") {
      await store.delete("receiveLease");
      args.logger?.warn("receive:finalize-ref-conflict", {
        conflictCount: statuses.filter((status) => !status.ok).length,
      });
      return {
        status: "ref_conflict",
        statuses,
        message: "Ref expectations changed before the receive could be committed.",
      };
    }

    // The rewritten delta commands must still validate cleanly — belt and
    // braces for invariants the planner is responsible for upholding.
    const revalidated = validateReceiveCommands(currentRefs, plan.commands);
    if (!revalidated.every((status) => status.ok)) {
      await store.delete("receiveLease");
      args.logger?.warn("receive:finalize-delta-invalid", {
        conflictCount: revalidated.filter((status) => !status.ok).length,
      });
      return {
        status: "ref_conflict",
        statuses,
        message: "Divergent rewrite produced invalid ref updates.",
      };
    }

    effectiveCommands = plan.commands;
    effectiveStatuses = plan.statuses;
    deltaIntents = plan.intents;
    args.logger?.info("receive:diverged-to-delta", {
      intentCount: plan.intents.length,
      deltaRefs: plan.intents.map((intent) => intent.deltaRef),
    });
  }

  const nextRefs = applyReceiveCommands(currentRefs, effectiveCommands);
  const storedHead = await store.get("head");
  const nextHead = resolveHeadAfterReceive({ storedHead, refs: nextRefs });
  const nextRefsVersion = ((await store.get("refsVersion")) || 0) + 1;

  let shouldQueueCompaction = false;
  if (args.stagedPack) {
    const nextPackSeq = (await store.get("nextPackSeq")) || 1;
    const db = getDb(args.ctx.storage);
    await upsertPackCatalogRow(db, {
      packKey: args.stagedPack.packKey,
      kind: "receive",
      state: "active",
      tier: 0,
      seqLo: nextPackSeq,
      seqHi: nextPackSeq,
      objectCount: args.stagedPack.objectCount,
      packBytes: args.stagedPack.packBytes,
      idxBytes: args.stagedPack.idxBytes,
      createdAt: Date.now(),
      supersededBy: null,
    });
    await store.put("nextPackSeq", nextPackSeq + 1);
    const activeCatalog = await listActivePackCatalog(db);
    await bumpPacksetVersion(store);
    shouldQueueCompaction = catalogNeedsCompaction(activeCatalog);
    if (shouldQueueCompaction) {
      await store.put("compactionWantedAt", Date.now());
      await scheduleCompactionWake(args.ctx, args.env);
    }
  }

  await store.put("refs", nextRefs);
  await store.put("head", nextHead);
  await store.put("refsVersion", nextRefsVersion);
  await store.delete("receiveLease");

  const db = getDb(args.ctx.storage);
  const now = Date.now();
  // Every committed receive lands in the hash-chained op log — previously
  // only divergent pushes left a trace, which left direct ref updates
  // invisible to `/dg/oplog` auditors. Push options ride along opaque.
  await appendOpLogEntry(
    db,
    {
      kind: "push.received",
      actor: args.actor ?? "anonymous",
      payload: {
        refs: effectiveCommands.map((command) => command.ref),
        options: args.pushOptions ?? [],
      },
    },
    now
  );

  if (deltaIntents && deltaIntents.length > 0) {
    for (const intent of deltaIntents) {
      await insertMergeIntent(db, intent);
      await appendOpLogEntry(
        db,
        {
          kind: "push.delta",
          actor: intent.actor,
          payload: {
            intentId: intent.id,
            targetRef: intent.targetRef,
            deltaRef: intent.deltaRef,
            baseOid: intent.baseOid,
            deltaOid: intent.deltaOid,
          },
        },
        now
      );
    }
  }

  args.logger?.info("receive:finalize-committed", {
    commandCount: effectiveCommands.length,
    refCount: nextRefs.length,
    empty: nextRefs.length === 0,
    stagedPackKey: args.stagedPack?.packKey,
    shouldQueueCompaction,
    deltaIntentCount: deltaIntents?.length ?? 0,
  });

  return {
    status: "committed",
    statuses: effectiveStatuses,
    changed: effectiveCommands.length > 0,
    empty: nextRefs.length === 0,
    shouldQueueCompaction,
    deltaIntents,
  };
}
