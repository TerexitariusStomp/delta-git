// Typed schema for Repo Durable Object storage
// Provides a light wrapper to get strong typing on storage keys/values in tests and code.

export type ObjKey = `obj:${string}`;

export type Ref = { name: string; oid: string };
export type Head = { target: string; oid?: string; unborn?: boolean };
export type RepoLease = {
  token: string;
  createdAt: number;
  expiresAt: number;
};

export type RepoStateSchema = {
  refs: Ref[];
  head: Head;
  refsVersion: number;
  packsetVersion: number;
  nextPackSeq: number;
  /**
   * Legacy single receive lease — read-migrated into `receiveLeases` on
   * first access, never written by current code.
   */
  receiveLease: RepoLease | undefined;
  /**
   * Active receive leases, keyed by lease token. Multiple receives may be
   * staged concurrently; only finalize (ref validation + commit) is
   * serialized by the DO. Compaction still requires zero active leases.
   */
  receiveLeases: Record<string, RepoLease> | undefined;
  compactLease: RepoLease | undefined;
  compactionWantedAt: number | undefined;
  lastAccessMs: number;
  lastSnapshotMs: number | undefined;
} & Record<ObjKey, Uint8Array | ArrayBuffer>;

export type TypedStorage<S> = {
  get<K extends keyof S & string>(key: K): Promise<S[K] | undefined>;
  get<K extends keyof S & string>(keys: K[]): Promise<Map<K, S[K] | undefined>>;
  put<K extends keyof S & string>(key: K, value: S[K]): Promise<void>;
  delete<K extends keyof S & string>(key: K): Promise<boolean | void>;
};

export function asTypedStorage<S>(storage: DurableObjectStorage): TypedStorage<S> {
  // The cast on `get` is deliberate: DO storage's Map overload loses the
  // schema's key typing, so we re-narrow it to the declared signature.
  const get: TypedStorage<S>["get"] = ((keyOrKeys: string | string[]) =>
    (Array.isArray(keyOrKeys)
      ? storage.get(keyOrKeys)
      : storage.get(keyOrKeys))) as TypedStorage<S>["get"];
  const put = <K extends keyof S & string>(key: K, value: S[K]) => storage.put(key, value);
  const del = <K extends keyof S & string>(key: K) => storage.delete(key);
  return { get, put, delete: del };
}

// Key helpers for template-literal key families
export function objKey(oid: string): ObjKey {
  return `obj:${oid}` as ObjKey;
}
