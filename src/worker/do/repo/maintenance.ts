/**
 * Repository idle cleanup
 *
 * This module handles idle cleanup and R2 mirror purging
 * to maintain repository health when repos are no longer in use.
 */

import type { RepoStateSchema } from "./repoState";
import type { Logger } from "@/worker/common/logger";

import { asTypedStorage } from "./repoState";
import { getDb } from "./db/client";
import {
  getActivePackCatalogCount,
  listActivePackCatalog,
  listMergeIntentsByStatus,
  listOpLogTail,
  listRecentWorkIntents,
} from "./db";
import { doPrefix } from "@/worker/keys";
import { ensureScheduled } from "./scheduler";
import { getConfig } from "./repoConfig";

type IdleCleanupDecision =
  | {
      kind: "active";
      lastAccess: number;
      nextIdleAt: number;
    }
  | {
      kind: "empty-idle" | "nonempty-idle";
      lastAccess: number | undefined;
      refsCount: number;
      hasHead: boolean;
      headUnborn: boolean;
      hasHeadTarget: boolean;
      activePackCount: number;
    };

/**
 * Handles idle cleanup after alarm fires.
 * Checks if the repository should be cleaned up due to idleness
 * and reschedules only when the repository has not reached its idle deadline.
 * @param ctx - Durable Object state context
 * @param env - Worker environment
 * @param logger - Logger instance
 */
export async function handleIdleAndMaintenance(
  ctx: DurableObjectState,
  env: Env,
  logger?: Logger
): Promise<void> {
  try {
    const cfg = getConfig(env);
    const now = Date.now();
    const store = asTypedStorage<RepoStateSchema>(ctx.storage);
    const lastAccess = await store.get("lastAccessMs");
    const decision = await decideIdleCleanup(ctx, cfg.idleMs, lastAccess, now);

    if (decision.kind === "active") {
      logger?.debug("cleanup:active-rearm", {
        lastAccess: decision.lastAccess,
        nextIdleAt: decision.nextIdleAt,
      });
      await maybeWriteStateSnapshot(ctx, env, store, now, logger);
      await ensureScheduled(ctx, env, now);
      return;
    }

    if (decision.kind === "empty-idle") {
      logger?.info("cleanup:empty-idle", decision);
      await performIdleCleanup(ctx, env, logger);
      return;
    }

    logger?.info("cleanup:nonempty-idle-skip", decision);
    await clearIdleAlarm(ctx, logger);
  } catch (e) {
    logger?.error("alarm:error", { error: String(e) });
  }
}

/**
 * Determines whether the idle alarm should clean up, re-arm, or stop.
 * A repo is considered for cleanup if it's been idle beyond the threshold
 * AND appears empty (no refs, unborn/missing HEAD, no active packs in catalog).
 * @param ctx - Durable Object state context
 * @param idleMs - Idle threshold in milliseconds
 * @param lastAccess - Last access timestamp
 * @param now - Current timestamp
 * @returns cleanup decision for the alarm handler
 */
async function decideIdleCleanup(
  ctx: DurableObjectState,
  idleMs: number,
  lastAccess: number | undefined,
  now: number
): Promise<IdleCleanupDecision> {
  const idleExceeded = !lastAccess || now - lastAccess >= idleMs;
  if (!idleExceeded) {
    return {
      kind: "active",
      lastAccess,
      nextIdleAt: lastAccess + idleMs,
    };
  }

  // Check if repo looks empty
  const store = asTypedStorage<RepoStateSchema>(ctx.storage);
  const refs = (await store.get("refs")) ?? [];
  const head = await store.get("head");
  const db = getDb(ctx.storage);
  const catalogCount = await getActivePackCatalogCount(db);
  const empty = refs.length === 0 && (!head || head.unborn || !head.target) && catalogCount === 0;

  return {
    kind: empty ? "empty-idle" : "nonempty-idle",
    lastAccess,
    refsCount: refs.length,
    hasHead: head !== undefined,
    headUnborn: head?.unborn === true,
    hasHeadTarget: typeof head?.target === "string" && head.target.length > 0,
    activePackCount: catalogCount,
  };
}

// ---------------------------------------------------------------------------
// DO state snapshots → R2 (disaster recovery)
// ---------------------------------------------------------------------------
//
// While a repo stays active, each alarm cycle writes a point-in-time state
// snapshot to `<doPrefix>/snapshots/latest.json` at most once per day. The
// snapshot carries everything needed to reconstruct DO metadata (refs,
// head, op-log tail, merge/work intents, pack catalog) if the DO is lost —
// the git objects themselves already live in R2 packs.

const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_LAST_KEY = "lastSnapshotMs";

async function maybeWriteStateSnapshot(
  ctx: DurableObjectState,
  env: Env,
  store: ReturnType<typeof asTypedStorage<RepoStateSchema>>,
  now: number,
  logger?: Logger
): Promise<void> {
  const last = (await store.get(SNAPSHOT_LAST_KEY)) ?? 0;
  if (now - last < SNAPSHOT_INTERVAL_MS) return;
  try {
    const db = getDb(ctx.storage);
    const [refs, head, opLogTail, intents, workIntents, catalog] = await Promise.all([
      store.get("refs"),
      store.get("head"),
      listOpLogTail(db, 500),
      listMergeIntentsByStatus(db, [
        "open",
        "merging",
        "adjudicating",
        "conflict",
        "merged",
        "rejected",
        "expired",
      ]),
      listRecentWorkIntents(db),
      listActivePackCatalog(db),
    ]);
    const snapshot = {
      version: 1,
      snapshot_at: now,
      refs: refs ?? [],
      head: head ?? null,
      op_log_tail: opLogTail,
      merge_intents: intents,
      work_intents: workIntents,
      pack_catalog: catalog,
    };
    const key = `${doPrefix(ctx.id.toString())}/snapshots/latest.json`;
    await env.REPO_BUCKET.put(key, JSON.stringify(snapshot));
    await store.put(SNAPSHOT_LAST_KEY, now);
    logger?.info("cleanup:state-snapshot", { key });
  } catch (error) {
    logger?.warn("cleanup:state-snapshot-failed", { error: String(error) });
  }
}

async function clearIdleAlarm(ctx: DurableObjectState, logger?: Logger): Promise<void> {
  try {
    await ctx.storage.deleteAlarm();
  } catch (e) {
    logger?.warn("cleanup:delete-alarm-failed", { error: String(e) });
  }
}

/**
 * Performs complete cleanup of an idle repository.
 * Deletes all DO storage and purges the R2 mirror.
 * @param ctx - Durable Object state context
 * @param env - Worker environment
 * @param logger - Logger instance
 */
async function performIdleCleanup(
  ctx: DurableObjectState,
  env: Env,
  logger?: Logger
): Promise<void> {
  const storage = ctx.storage;

  // Purge DO storage. The 2026-05-13 compatibility date includes
  // `delete_all_deletes_alarm`, so this also clears any pending alarm.
  try {
    await storage.deleteAll();
  } catch (e) {
    logger?.error("cleanup:delete-storage-failed", { error: String(e) });
  }

  // Purge R2 mirror
  const prefix = doPrefix(ctx.id.toString());
  await purgeR2Mirror(env, prefix, logger);
}

/**
 * Purges all R2 objects under this DO's prefix.
 * Continues even if individual deletes fail.
 * @param env - Worker environment
 * @param prefix - Repository prefix (do/<id>)
 * @param logger - Logger instance
 */
async function purgeR2Mirror(env: Env, prefix: string, logger?: Logger): Promise<void> {
  try {
    const pfx = `${prefix}/`;
    let cursor: string | undefined = undefined;

    do {
      const res: R2Objects = await env.REPO_BUCKET.list({ prefix: pfx, cursor });
      const objects: R2Object[] = (res && res.objects) || [];

      for (const obj of objects) {
        try {
          await env.REPO_BUCKET.delete(obj.key);
        } catch (e) {
          logger?.warn("cleanup:delete-r2-object-failed", {
            key: obj.key,
            error: String(e),
          });
        }
      }

      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor);
  } catch (e) {
    logger?.error("cleanup:purge-r2-failed", { error: String(e) });
  }
}
