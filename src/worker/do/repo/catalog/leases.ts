import type { Logger } from "@/worker/common/logger";

import { asTypedStorage } from "../repoState";
import type { RepoLease, RepoStateSchema, TypedStorage } from "../repoState";
import { getActivePackCatalogSnapshot } from "./state";
import type { BeginReceiveResult } from "./shared";
import {
  DEFAULT_HEAD,
  LEASE_RETRY_AFTER_SECONDS,
  MAX_CONCURRENT_RECEIVES,
  ensureRepoMetadataDefaults,
  RECEIVE_LEASE_TTL_MS,
} from "./shared";

type Store = TypedStorage<RepoStateSchema>;

/**
 * Active receive leases, merging the current `receiveLeases` map with the
 * legacy single `receiveLease` key for rows written before the
 * multi-lease cutover. Read-only — callers that persist must copy this
 * map before mutating.
 */
export async function getActiveReceiveLeases(store: Store, now: number): Promise<RepoLease[]> {
  const [map, legacy] = await Promise.all([store.get("receiveLeases"), store.get("receiveLease")]);
  const live = new Map<string, RepoLease>();
  if (legacy && legacy.expiresAt > now) live.set(legacy.token, legacy);
  for (const lease of Object.values(map ?? {})) {
    if (lease.expiresAt > now) live.set(lease.token, lease);
  }
  return [...live.values()];
}

/** Whether any receive lease is currently unexpired. */
export async function hasActiveReceiveLease(store: Store, now: number): Promise<boolean> {
  return (await getActiveReceiveLeases(store, now)).length > 0;
}

/**
 * Deletes one lease token from the map (and the legacy key if it matches).
 * Used by abort and by every finalize exit path — only the caller's own
 * lease may be removed, never a sibling's.
 */
export async function removeReceiveLease(store: Store, token: string): Promise<void> {
  const [map, legacy] = await Promise.all([store.get("receiveLeases"), store.get("receiveLease")]);
  if (legacy?.token === token) await store.delete("receiveLease");
  if (!map || !(token in map)) return;
  delete map[token];
  if (Object.keys(map).length > 0) {
    await store.put("receiveLeases", map);
  } else {
    await store.delete("receiveLeases");
  }
}

export async function clearExpiredLeases(
  ctx: DurableObjectState,
  logger?: Logger,
  now: number = Date.now()
): Promise<void> {
  const store = asTypedStorage<RepoStateSchema>(ctx.storage);
  const [map, legacy, compactLease] = await Promise.all([
    store.get("receiveLeases"),
    store.get("receiveLease"),
    store.get("compactLease"),
  ]);

  // Fold the legacy single lease into the map, then drop expired entries.
  const merged: Record<string, RepoLease> = { ...(map ?? {}) };
  if (legacy) merged[legacy.token] = legacy;
  const active: Record<string, RepoLease> = {};
  let expired = 0;
  for (const [token, lease] of Object.entries(merged)) {
    if (lease.expiresAt > now) active[token] = lease;
    else expired++;
  }
  if (expired > 0) logger?.debug("lease:expired", { kind: "receive", expired });
  if (Object.keys(active).length > 0 || map !== undefined) {
    if (Object.keys(active).length > 0) {
      await store.put("receiveLeases", active);
    } else {
      await store.delete("receiveLeases");
    }
  }
  if (legacy !== undefined) await store.delete("receiveLease");

  if (compactLease && compactLease.expiresAt <= now) {
    await store.delete("compactLease");
    logger?.debug("lease:expired", { kind: "compact" });
  }
}

export async function beginReceiveLease(
  ctx: DurableObjectState,
  logger?: Logger
): Promise<BeginReceiveResult> {
  const store = asTypedStorage<RepoStateSchema>(ctx.storage);
  const now = Date.now();
  await clearExpiredLeases(ctx, logger, now);

  // Compaction rewrites the pack catalog — no new receive may stage while
  // a compact lease is held, or its snapshot and staged pack could
  // reference a catalog that no longer exists at finalize.
  const compactLease = await store.get("compactLease");
  if (compactLease && compactLease.expiresAt > now) {
    return { ok: false, retryAfter: LEASE_RETRY_AFTER_SECONDS };
  }

  const active = await getActiveReceiveLeases(store, now);
  if (active.length >= MAX_CONCURRENT_RECEIVES) {
    return { ok: false, retryAfter: LEASE_RETRY_AFTER_SECONDS };
  }

  const lease: RepoLease = {
    token: crypto.randomUUID(),
    createdAt: now,
    expiresAt: now + RECEIVE_LEASE_TTL_MS,
  };
  const map: Record<string, RepoLease> = {};
  for (const existing of active) map[existing.token] = existing;
  map[lease.token] = lease;
  await store.put("receiveLeases", map);

  const activeCatalog = await getActivePackCatalogSnapshot(ctx);
  await ensureRepoMetadataDefaults(store);
  const refs = (await store.get("refs")) ?? [];
  const head = (await store.get("head")) ?? DEFAULT_HEAD;

  return {
    ok: true,
    lease,
    refs,
    head,
    refsVersion: (await store.get("refsVersion")) || 0,
    packsetVersion: (await store.get("packsetVersion")) || 0,
    nextPackSeq: (await store.get("nextPackSeq")) || 1,
    activeCatalog,
  };
}

export async function abortReceiveLease(ctx: DurableObjectState, token: string): Promise<boolean> {
  const store = asTypedStorage<RepoStateSchema>(ctx.storage);
  const [map, legacy] = await Promise.all([store.get("receiveLeases"), store.get("receiveLease")]);
  if (legacy?.token !== token && (!map || !(token in map))) return false;
  await removeReceiveLease(store, token);
  return true;
}

export async function abortCompactionLease(
  ctx: DurableObjectState,
  token: string
): Promise<boolean> {
  const store = asTypedStorage<RepoStateSchema>(ctx.storage);
  const existing = await store.get("compactLease");
  if (!existing || existing.token !== token) return false;
  await store.delete("compactLease");
  return true;
}
