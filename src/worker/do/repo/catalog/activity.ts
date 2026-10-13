import { asTypedStorage } from "../repoState";
import type { RepoLease, RepoStateSchema } from "../repoState";
import { getActiveReceiveLeases } from "./leases";

export type RepoActivitySnapshot =
  | { state: "idle"; compactionWantedAt?: number }
  | { state: "receiving"; lease: RepoLease; leaseCount: number }
  | { state: "compacting"; lease: RepoLease; compactionWantedAt?: number };

export function activeLeaseOrUndefined(
  lease: RepoLease | undefined,
  now: number
): RepoLease | undefined {
  if (!lease) return undefined;
  return lease.expiresAt > now ? lease : undefined;
}

export async function getRepoActivitySnapshot(
  ctx: DurableObjectState
): Promise<RepoActivitySnapshot> {
  const store = asTypedStorage<RepoStateSchema>(ctx.storage);
  const now = Date.now();

  // Report the earliest-expiring lease as representative — it's the one
  // that bounds the activity window — but keep the count so monitors can
  // see concurrent receives.
  const receiveLeases = await getActiveReceiveLeases(store, now);
  if (receiveLeases.length > 0) {
    const earliest = receiveLeases.reduce((a, b) => (a.expiresAt <= b.expiresAt ? a : b));
    return { state: "receiving", lease: earliest, leaseCount: receiveLeases.length };
  }

  const compactLease = activeLeaseOrUndefined(await store.get("compactLease"), now);
  const compactionWantedAt = await store.get("compactionWantedAt");
  if (compactLease) {
    return {
      state: "compacting",
      lease: compactLease,
      compactionWantedAt,
    };
  }

  return {
    state: "idle",
    compactionWantedAt,
  };
}
