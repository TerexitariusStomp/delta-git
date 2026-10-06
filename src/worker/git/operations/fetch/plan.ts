import type { CacheContext } from "@/worker/cache";
import type { Logger } from "@/worker/common/logger";
import type { SnapshotLoadResult } from "@/worker/git/pack/snapshot";
import type { OrderedPackSnapshot, ServeUploadPackPlan, UploadPackPlan } from "./types";
import type { PackRefSnapshotEntry, PackRefSnapshotLoadResult } from "@/worker/git/pack/refIndex";
import type { ParsedFilter } from "./filter";

import { createLogger } from "@/worker/common";
import { buildInitialCloneNeeded, loadOrderedPackSnapshot } from "@/worker/git/pack/snapshot";
import { getDoIdFromPath } from "@/worker/keys";
import { findCommonHaves } from "../closure";
import { computeNeededFromPackRefs } from "./refClosure";
import { loadPackRefView } from "@/worker/git/pack/refIndex";
import { parseFilterSpec } from "./filter";
import { computeShallowCut, type ShallowRequest } from "./shallow";
import { getHeadAndRefs } from "../read/refs";
import type { FetchArgs } from "../args";

/**
 * Shallow/filter feature arguments carried through fetch planning.
 * `clientShallows` are the client's existing shallow boundary — they behave
 * as extra stop points during the closure walk.
 */
export type FetchFeatureOptions = Pick<
  FetchArgs,
  "deepen" | "deepenNot" | "clientShallows" | "filter"
>;

/**
 * Resolves `deepen-not` revisions (ref names or hex oids) against the repo's
 * refs — a single DO read batched for all revs. Unresolvable revs drop out;
 * the resulting cut is then a superset, which stays protocol-valid.
 */
async function resolveDeepenNotOids(
  env: Env,
  repoId: string,
  revs: string[],
  cacheCtx?: CacheContext
): Promise<string[]> {
  const oids = new Set<string>();
  const names: string[] = [];
  for (const rev of revs) {
    const trimmed = rev.trim();
    if (/^[0-9a-f]{40}$/i.test(trimmed)) oids.add(trimmed.toLowerCase());
    else if (trimmed) names.push(trimmed);
  }
  if (names.length === 0) return Array.from(oids);

  const { refs } = await getHeadAndRefs(env, repoId, cacheCtx);
  const oidByName = new Map(refs.map((r) => [r.name, r.oid.toLowerCase()]));
  for (const name of names) {
    const oid =
      oidByName.get(name) ??
      oidByName.get(`refs/heads/${name}`) ??
      oidByName.get(`refs/tags/${name}`);
    if (oid) oids.add(oid);
  }
  return Array.from(oids);
}

export class FetchPlanRetryError extends Error {
  readonly reason: "missing-ref-index" | "closure-budget-exceeded";
  readonly retryAfterSeconds: number;

  constructor(reason: "missing-ref-index" | "closure-budget-exceeded") {
    super(reason);
    this.name = "FetchPlanRetryError";
    this.reason = reason;
    this.retryAfterSeconds = 10;
  }
}

export async function loadUploadPackSnapshot(
  env: Env,
  repoId: string,
  cacheCtx?: CacheContext
): Promise<SnapshotLoadResult> {
  // Snapshot readiness stays outside the streaming response so callers can
  // still convert "not ready" into an HTTP retry signal before headers commit.
  const log = createLogger(env.LOG_LEVEL, { service: "StreamPlan", repoId });
  const snapshotLoad = await loadOrderedPackSnapshot(env, repoId, cacheCtx, log);
  if (snapshotLoad.type === "RepositoryNotReady") {
    log.warn("stream:plan:repository-not-ready", { reason: snapshotLoad.reason });
  }
  return snapshotLoad;
}

function schedulePackRefBackfill(args: {
  env: Env;
  repoId: string;
  packKey: string;
  cacheCtx?: CacheContext;
  log: Logger;
  reason: string;
}): void {
  const doId = getDoIdFromPath(args.packKey);
  if (!doId) {
    args.log.warn("stream:fetch:ref-index-backfill-skipped", {
      packKey: args.packKey,
      reason: "missing-do-id",
    });
    return;
  }

  const send = args.env.REPO_TASKS_QUEUE.send({
    kind: "pack-ref-backfill",
    doId,
    repoId: args.repoId,
    packKey: args.packKey,
  })
    .then(() => {
      args.log.info("stream:fetch:ref-index-backfill-queued", {
        packKey: args.packKey,
        reason: args.reason,
      });
    })
    .catch((error) => {
      args.log.warn("stream:fetch:ref-index-backfill-enqueue-failed", {
        packKey: args.packKey,
        reason: args.reason,
        error: String(error),
      });
    });

  if (args.cacheCtx) {
    args.cacheCtx.ctx.waitUntil(send);
  } else {
    send.catch(() => {});
  }
}

export async function loadPackRefSnapshot(
  env: Env,
  repoId: string,
  snapshot: OrderedPackSnapshot,
  cacheCtx?: CacheContext
): Promise<PackRefSnapshotLoadResult> {
  const log = createLogger(env.LOG_LEVEL, { service: "StreamPlan", repoId });
  const packs: PackRefSnapshotEntry[] = [];
  const missing: Array<{
    packKey: string;
    packBytes: number;
    reason: "missing" | "corrupt" | "stale";
    detail?: string;
  }> = [];

  for (const pack of snapshot.packs) {
    const load = await loadPackRefView(env, pack.packKey, pack.idx, cacheCtx);
    if (load.type === "Ready") {
      packs.push({
        packKey: pack.packKey,
        packBytes: pack.packBytes,
        idx: pack.idx,
        refs: load.view,
      });
      continue;
    }

    const reason = load.type === "Missing" ? "missing" : load.kind;
    const detail = load.type === "Invalid" ? load.reason : undefined;
    missing.push({
      packKey: pack.packKey,
      packBytes: pack.packBytes,
      reason,
      detail,
    });
    log.warn("stream:fetch:ref-index-missing", {
      packKey: pack.packKey,
      reason,
      detail,
    });
    schedulePackRefBackfill({
      env,
      repoId,
      packKey: pack.packKey,
      cacheCtx,
      log,
      reason,
    });
  }

  log.info("stream:plan:ref-snapshot", {
    packs: snapshot.packs.length,
    loaded: packs.length,
    missing: missing.length,
  });

  if (missing.length > 0) {
    return { type: "Missing", packs: missing };
  }

  return { type: "Ready", packs };
}

export async function buildServeUploadPackPlan(
  env: Env,
  repoId: string,
  snapshot: OrderedPackSnapshot,
  wants: string[],
  haves: string[],
  signal?: AbortSignal,
  cacheCtx?: CacheContext,
  onProgress?: (message: string) => void,
  features?: FetchFeatureOptions
): Promise<ServeUploadPackPlan> {
  const log = createLogger(env.LOG_LEVEL, { service: "StreamPlan", repoId });

  const parsedFilter: ParsedFilter | undefined = features?.filter
    ? parseFilterSpec(features.filter)
    : undefined;
  if (features?.filter && !parsedFilter) {
    log.warn("stream:plan:filter-unparsed", { filter: features.filter });
  } else if (parsedFilter && parsedFilter.unsupported.length > 0) {
    log.warn("stream:plan:filter-unsupported", { unsupported: parsedFilter.unsupported });
  }

  // Client shallow markers stop traversal exactly like haves — the client
  // already has those commits and does not want their ancestors.
  const effectiveHaves = features ? [...haves, ...features.clientShallows] : haves;
  const hasShallowCut =
    features !== undefined && (features.deepen !== undefined || features.deepenNot.length > 0);
  const needsRefIndex = effectiveHaves.length > 0 || hasShallowCut || parsedFilter !== undefined;

  if (!needsRefIndex) {
    onProgress?.("Selecting objects to send...\n");
    const neededOids = buildInitialCloneNeeded(snapshot);
    log.info("stream:plan:init-clone", {
      packs: snapshot.packs.length,
      needed: neededOids.length,
    });
    return {
      type: "Serve",
      repoId,
      snapshot,
      neededOids,
      ackOids: [],
      signal,
      cacheCtx,
    };
  }

  const refSnapshot = await loadPackRefSnapshot(env, repoId, snapshot, cacheCtx);
  if (refSnapshot.type === "Missing") {
    throw new FetchPlanRetryError("missing-ref-index");
  }

  let shallowCut: { severedCommits: Set<string>; excludedOids: Set<string> } | undefined;
  if (hasShallowCut && features) {
    const deepenNotBaseOids = await resolveDeepenNotOids(env, repoId, features.deepenNot, cacheCtx);
    if (features.deepenNot.length > 0 && deepenNotBaseOids.length === 0) {
      log.warn("stream:plan:deepen-not-unresolved", { revs: features.deepenNot });
    }
    const request: ShallowRequest = { deepen: features.deepen, deepenNotBaseOids };
    const cut = computeShallowCut(refSnapshot.packs, wants, request);
    if (cut.overflow) {
      // Boundary computation blew its walk budget — an unshallowed fetch is a
      // valid superset; better than a wrong boundary.
      log.warn("stream:plan:shallow-cut-overflow", {});
    } else {
      shallowCut = cut;
    }
  }

  const closure = await computeNeededFromPackRefs({
    logLevel: env.LOG_LEVEL,
    repoId,
    packs: refSnapshot.packs,
    wants,
    haves: effectiveHaves,
    shallow: shallowCut,
    filter: parsedFilter,
    onProgress,
  });
  if (closure.type === "BudgetExceeded") {
    log.warn("stream:plan:closure-budget-exceeded", {
      reason: closure.reason,
      needed: closure.neededOids.length,
      seen: closure.stats.seen,
      queued: closure.stats.queued,
      missing: closure.stats.missing,
      edgeVisits: closure.stats.edgeVisits,
      duplicateQueueSkips: closure.stats.duplicateQueueSkips,
    });
    throw new FetchPlanRetryError("closure-budget-exceeded");
  }
  const neededOids = closure.neededOids;

  // shallow-info contents: the computed boundary commits are emitted as
  // `shallow`; the client's own shallow markers are echoed unless they ended
  // up in the pack with parents (`unshallow`).
  let shallowInfo: { shallow: string[]; unshallow: string[] } | undefined;
  if (features && (hasShallowCut || features.clientShallows.length > 0)) {
    const neededSet = new Set(neededOids.map((oid) => oid.toLowerCase()));
    const shallow = new Set<string>(shallowCut?.severedCommits ?? []);
    const unshallow = new Set<string>();
    for (const oid of features.clientShallows) {
      const lc = oid.toLowerCase();
      if (neededSet.has(lc) && !shallow.has(lc)) unshallow.add(lc);
      else shallow.add(lc);
    }
    if (shallow.size > 0 || unshallow.size > 0) {
      shallowInfo = { shallow: Array.from(shallow), unshallow: Array.from(unshallow) };
    }
  }

  log.info("stream:plan:serve", {
    packs: snapshot.packs.length,
    needed: neededOids.length,
    ackOids: 0,
    shallow: shallowInfo?.shallow.length ?? 0,
    filter: parsedFilter ? features?.filter : undefined,
  });

  return {
    type: "Serve",
    repoId,
    snapshot,
    neededOids,
    ackOids: [],
    shallowInfo,
    signal,
    cacheCtx,
  };
}

export async function planUploadPack(
  env: Env,
  repoId: string,
  wants: string[],
  haves: string[],
  done: boolean,
  signal?: AbortSignal,
  cacheCtx?: CacheContext,
  features?: FetchFeatureOptions
): Promise<UploadPackPlan> {
  const snapshotLoad = await loadUploadPackSnapshot(env, repoId, cacheCtx);
  if (snapshotLoad.type === "RepositoryNotReady") {
    return { type: "RepositoryNotReady" };
  }

  if (!done) {
    const effectiveHaves = features ? [...haves, ...features.clientShallows] : haves;
    const ackOids =
      effectiveHaves.length > 0 ? await findCommonHaves(env, repoId, effectiveHaves, cacheCtx) : [];
    return {
      type: "Serve",
      repoId,
      snapshot: snapshotLoad.snapshot,
      neededOids: [],
      ackOids,
      signal,
      cacheCtx,
    };
  }

  const servePlan = await buildServeUploadPackPlan(
    env,
    repoId,
    snapshotLoad.snapshot,
    wants,
    haves,
    signal,
    cacheCtx,
    undefined,
    features
  );

  return servePlan;
}
