import type { CacheContext } from "@/worker/cache";
import type { TreeEntry } from "./types";

import { buildObjectCacheKey, cacheOrLoadObject } from "@/worker/cache";
import { createBlobFromBytes, createLogger } from "@/worker/common";
import { readObject } from "@/worker/git/object-store";
import { parseTree as coreParseTree } from "@/worker/git/core/tree";

type LooseObjectRead = {
  type: string;
  payload: Uint8Array;
};

function ensureMemo(cacheCtx: CacheContext | undefined, repoId: string) {
  if (!cacheCtx) return;
  if (!cacheCtx.memo || (cacheCtx.memo.repoId && cacheCtx.memo.repoId !== repoId)) {
    cacheCtx.memo = { repoId };
    return;
  }
  if (!cacheCtx.memo.repoId) cacheCtx.memo.repoId = repoId;
}

// Array-form view over the canonical codec in git/core/tree.ts — the read
// path iterates entries rather than looking them up by name.
export function parseTree(buf: Uint8Array): TreeEntry[] {
  return [...coreParseTree(buf).values()];
}

/**
 * Pack-first object reader. Reads git objects from the active pack catalog
 * via the worker-local object store.
 */
export async function readLooseObjectRaw(
  env: Env,
  repoId: string,
  oid: string,
  cacheCtx?: CacheContext
): Promise<{ type: string; payload: Uint8Array } | undefined> {
  const oidLc = oid.toLowerCase();
  ensureMemo(cacheCtx, repoId);

  if (cacheCtx?.memo?.objects?.has(oidLc)) {
    return cacheCtx.memo.objects.get(oidLc);
  }

  const logger = createLogger(env.LOG_LEVEL, {
    service: "readObjectRaw",
    repoId,
  });
  // Visibility-aware cache bypass. Private route handlers set both
  // `no-cache-read` and `no-cache-write` on `cacheCtx.memo.flags` so this
  // path (and the JSON cache helpers at the route layer) skip the shared
  // Workers Cache entirely. Either flag forces the bypass branch; there is
  // no asymmetric "read but don't write" use case in our policy.
  const bypassCacheRead = cacheCtx?.memo?.flags?.has("no-cache-read") === true;
  const bypassCacheWrite = cacheCtx?.memo?.flags?.has("no-cache-write") === true;
  const bypassCache = bypassCacheRead || bypassCacheWrite;

  const loadFromPacks = async (): Promise<LooseObjectRead | undefined> => {
    const packed = await readObject(env, repoId, oidLc, cacheCtx);
    if (packed) {
      logger.debug("object-read", {
        source: "pack-catalog",
        oid: oidLc,
        type: packed.type,
        packKey: packed.packKey,
      });
      return { type: packed.type, payload: packed.payload };
    }
    return undefined;
  };

  const storeMemoized = (value: LooseObjectRead | undefined) => {
    if (!cacheCtx?.memo) return;
    cacheCtx.memo.objects = cacheCtx.memo.objects || new Map();
    cacheCtx.memo.objects.set(oidLc, value);
  };

  if (cacheCtx) {
    const cacheKey = buildObjectCacheKey(cacheCtx.req, repoId, oidLc);
    const loaded = bypassCache
      ? await loadFromPacks()
      : await cacheOrLoadObject(cacheKey, loadFromPacks, cacheCtx.ctx);

    storeMemoized(loaded);
    return loaded;
  }

  const loaded = await loadFromPacks();
  return loaded;
}

export async function readBlob(
  env: Env,
  repoId: string,
  oid: string,
  cacheCtx?: CacheContext
): Promise<{ content: Uint8Array | null; type: string | null }> {
  const obj = await readLooseObjectRaw(env, repoId, oid, cacheCtx);
  if (!obj) return { content: null, type: null };
  return { content: obj.payload, type: obj.type };
}

export async function readBlobStream(
  env: Env,
  repoId: string,
  oid: string,
  cacheCtx?: CacheContext
): Promise<Response | null> {
  const obj = await readLooseObjectRaw(env, repoId, oid, cacheCtx);
  if (!obj || obj.type !== "blob") return null;
  return new Response(createBlobFromBytes(obj.payload).stream(), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${oid.toLowerCase()}"`,
    },
  });
}
