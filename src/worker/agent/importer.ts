import type { CacheContext } from "@/worker/cache";
import type { RepoDurableObject } from "@/worker/do";

import { createLogger } from "@/worker/common/logger";
import { getLimiter } from "@/worker/git/operations/limits";
import { doPrefix, r2PackKey } from "@/worker/keys";
import { scanPack, resolveDeltasAndWriteIdx } from "@/worker/git/pack/indexer";
import { concatChunks, decodePktLines, delimPkt, flushPkt, pktLine } from "@/worker/git/core";
import { asBodyInit } from "@/worker/common";

// Remote repo importer — a minimal Git protocol v2 fetch client.
//
// isomorphic-git can't be used here: its clone/fetch hardcodes protocol v1
// discovery, and this server is v2-only. The v2 exchange is small enough to
// implement directly with our own pkt-line primitives:
//   1. command=ls-refs           → ref tips + HEAD symref
//   2. command=fetch (want,done) → sideband stream; band-1 bytes are the pack
// The pack is staged into R2 and indexed by the same machinery the receive
// pipeline uses, then one DO call registers catalog rows + refs atomically.
// Only empty repos are importable — the DO rejects otherwise.

const td = new TextDecoder();
const MAX_PACK_BYTES = 512 * 1024 * 1024;

export type GitFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ImportResult =
  | { kind: "imported"; refs: number; head: string; objects: number }
  | { kind: "not_empty"; refs: number }
  | { kind: "failed"; reason: string };

function assertImportableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid-url");
  }
  if (url.protocol !== "https:") throw new Error("https-only");
  const host = url.hostname.toLowerCase();
  // Obvious SSRF names; Workers fetch can't reach private nets anyway.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "[::1]" ||
    /^127\.|^0\.|^\[/.test(host)
  ) {
    throw new Error("blocked-host");
  }
  return url;
}

const GIT_V2_HEADERS = {
  "Git-Protocol": "version=2",
  "Content-Type": "application/x-git-upload-pack-request",
};

type RemoteRefs = {
  refs: { name: string; oid: string }[];
  headTarget?: string;
};

async function lsRefs(client: GitFetch, base: string): Promise<RemoteRefs | Response> {
  const body = concatChunks([
    pktLine("command=ls-refs\n"),
    delimPkt(),
    pktLine("symrefs\n"),
    pktLine("peel\n"),
    flushPkt(),
  ]);
  const res = await client(`${base}/git-upload-pack`, {
    method: "POST",
    headers: GIT_V2_HEADERS,
    body: asBodyInit(body),
  });
  if (!res.ok) return res;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const refs: { name: string; oid: string }[] = [];
  let headTarget: string | undefined;
  for (const item of decodePktLines(bytes)) {
    if (item.type !== "line") continue;
    const line = item.text.trimEnd();
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const oid = line.slice(0, sp);
    const rest = line.slice(sp + 1);
    const name = rest.split(" ")[0];
    if (name === "HEAD") {
      const m = rest.match(/symref-target:(\S+)/);
      if (m) headTarget = m[1];
      continue;
    }
    if (!/^refs\//.test(name)) continue;
    // Skip peeled pseudo-entries (`refs/tags/v1^{}` handled server-side).
    if (name.endsWith("^{}")) continue;
    refs.push({ name, oid });
  }
  return { refs, headTarget };
}

type FetchPackResult = { pack: Uint8Array } | { fatal: string };

async function fetchPack(
  client: GitFetch,
  base: string,
  wants: string[],
  haves: string[] = []
): Promise<FetchPackResult | Response> {
  const parts: Uint8Array[] = [
    pktLine("command=fetch\n"),
    pktLine("agent=delta-git-importer\n"),
    delimPkt(),
  ];
  for (const oid of wants) parts.push(pktLine(`want ${oid}\n`));
  for (const oid of haves) parts.push(pktLine(`have ${oid}\n`));
  parts.push(pktLine("done\n"), flushPkt());
  const res = await client(`${base}/git-upload-pack`, {
    method: "POST",
    headers: GIT_V2_HEADERS,
    body: asBodyInit(concatChunks(parts)),
  });
  if (!res.ok) return res;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const packChunks: Uint8Array[] = [];
  let fatal = "";
  for (const item of decodePktLines(bytes)) {
    if (item.type !== "line") continue;
    const band = item.raw[0];
    const payload = item.raw.subarray(1);
    if (band === 1) packChunks.push(payload);
    else if (band === 3) fatal += td.decode(payload);
    // band 2 is progress text; ignore.
  }
  if (fatal) return { fatal: fatal.trim() };
  if (packChunks.length === 0) return { fatal: "empty-fetch-response" };
  return { pack: concatChunks(packChunks) };
}

export async function importRemoteRepo(args: {
  env: Env;
  repoId: string;
  stub: DurableObjectStub<RepoDurableObject>;
  url: string;
  /** Restrict the import to a single branch (+ tags). */
  branch?: string;
  actor: string;
  cacheCtx?: CacheContext;
  /** Test seam: routes remote traffic through the worker under test. */
  fetcher?: GitFetch;
  headers?: Record<string, string>;
}): Promise<ImportResult> {
  const { env, repoId, stub, actor, cacheCtx } = args;
  const log = createLogger(env.LOG_LEVEL, { service: "Importer", repoId });
  const client: GitFetch =
    args.fetcher ??
    ((input, init) => {
      const headers = { ...(init?.headers as Record<string, string>), ...args.headers };
      return fetch(input, { ...init, headers });
    });

  let url: URL;
  try {
    url = assertImportableUrl(args.url);
  } catch (error) {
    return { kind: "failed", reason: String(error) };
  }
  const base = url.toString().replace(/\/+$/, "");

  const lsResult = await lsRefs(client, base);
  if (lsResult instanceof Response) {
    return { kind: "failed", reason: `ls-refs:http-${lsResult.status}` };
  }
  let { refs } = lsResult;
  const { headTarget } = lsResult;
  if (args.branch) {
    refs = refs.filter(
      (ref) => ref.name === `refs/heads/${args.branch}` || ref.name.startsWith("refs/tags/")
    );
  }
  const branches = refs.filter((ref) => ref.name.startsWith("refs/heads/"));
  const headRef = refs.find((ref) => ref.name === headTarget) ?? branches[0] ?? refs[0];
  if (!headRef) return { kind: "failed", reason: "no-head" };

  const wants = [...new Set(refs.map((ref) => ref.oid))];
  if (wants.length === 0) return { kind: "failed", reason: "no-refs" };

  const fetched = await fetchPack(client, base, wants);
  if (fetched instanceof Response) {
    return { kind: "failed", reason: `fetch:http-${fetched.status}` };
  }
  if ("fatal" in fetched) return { kind: "failed", reason: `fetch:${fetched.fatal}` };
  if (fetched.pack.byteLength > MAX_PACK_BYTES) {
    return { kind: "failed", reason: "pack-too-large" };
  }
  // Sanity: a pack must start with the PACK magic.
  if (fetched.pack.byteLength < 32 || td.decode(fetched.pack.subarray(0, 4)) !== "PACK") {
    return { kind: "failed", reason: "not-a-pack" };
  }

  const ingested = await ingestPackIntoRepo({
    env,
    repoId,
    stub,
    pack: fetched.pack,
    refs,
    head: { target: headRef.name, oid: headRef.oid },
    actor,
    cacheCtx,
    packLabel: "import",
  });
  if (ingested.kind === "imported") {
    log.info("import:done", {
      url: base,
      refs: refs.length,
      objects: ingested.objects,
    });
  }
  return ingested;
}

/**
 * Stage a raw pack into the repo's R2 prefix, index it, and register
 * catalog rows + refs + head atomically through the DO's `importPack` —
 * the shared tail of `importRemoteRepo` and the DR bundle-restore path.
 * The DO rejects non-empty repos, so callers get a clean `not_empty`.
 */
export async function ingestPackIntoRepo(args: {
  env: Env;
  repoId: string;
  stub: DurableObjectStub<RepoDurableObject>;
  pack: Uint8Array;
  refs: { name: string; oid: string }[];
  head: { target: string; oid: string };
  actor: string;
  cacheCtx?: CacheContext;
  /** Distinguishes staged keys in R2 (e.g. "import" vs "restore"). */
  packLabel: string;
}): Promise<ImportResult> {
  const { env, repoId, stub, pack, refs, head, actor, cacheCtx } = args;
  const log = createLogger(env.LOG_LEVEL, { service: "Importer", repoId });
  const limiter = getLimiter(cacheCtx);
  const prefix = doPrefix(stub.id.toString());
  const packKey = r2PackKey(
    prefix,
    `pack-${args.packLabel}-${crypto.randomUUID().slice(0, 8)}.pack`
  );
  await limiter.run("r2:put-import-pack", () => env.REPO_BUCKET.put(packKey, pack));
  let subrequests = 1;
  const countSubrequest = (n = 1) => {
    subrequests += n;
  };

  const scanResult = await scanPack({
    env,
    packKey,
    packSize: pack.byteLength,
    limiter,
    countSubrequest,
    log,
  });
  const resolveResult = await resolveDeltasAndWriteIdx({
    env,
    packKey,
    packSize: pack.byteLength,
    limiter,
    countSubrequest,
    log,
    scanResult,
    repoId,
    cacheCtx,
  });

  const outcome = await stub.importPack({
    packs: [
      {
        packKey,
        packBytes: pack.byteLength,
        idxBytes: resolveResult.idxBytes,
        objectCount: resolveResult.objectCount,
      },
    ],
    refs,
    head,
    actor,
  });
  if (outcome.status !== "imported") {
    return { kind: "not_empty", refs: outcome.refs };
  }
  return {
    kind: "imported",
    refs: refs.length,
    head: head.target,
    objects: resolveResult.objectCount,
  };
}

// ---------------------------------------------------------------------------
// Incremental sync (Artifacts → DO object mirror)
// ---------------------------------------------------------------------------

export type SyncResult =
  | { kind: "synced"; refs: number; objects: number; changed: boolean }
  | { kind: "failed"; reason: string };

/**
 * Fetch the delta between a remote's advertised refs and the DO mirror,
 * then reconcile refs/head in one DO call. Unlike `importRemoteRepo` this
 * works on non-empty repos: local ref tips are sent as `have`s so the
 * remote packs only what changed, and `ingestRemoteSync` converges refs to
 * the remote's advertised state rather than requiring an empty repo.
 *
 * Used by the `cf.artifacts.repo.*` event consumer to keep the coordination
 * mirror of Artifacts-backed repos current.
 */
export async function syncRemoteRepo(args: {
  env: Env;
  repoId: string;
  stub: DurableObjectStub<RepoDurableObject>;
  url: string;
  actor: string;
  cacheCtx?: CacheContext;
  fetcher?: GitFetch;
  headers?: Record<string, string>;
}): Promise<SyncResult> {
  const { env, repoId, stub, actor, cacheCtx } = args;
  const log = createLogger(env.LOG_LEVEL, { service: "RepoSync", repoId });
  const client: GitFetch =
    args.fetcher ??
    ((input, init) => {
      const headers = { ...(init?.headers as Record<string, string>), ...args.headers };
      return fetch(input, { ...init, headers });
    });

  let url: URL;
  try {
    url = assertImportableUrl(args.url);
  } catch (error) {
    return { kind: "failed", reason: String(error) };
  }
  const base = url.toString().replace(/\/+$/, "");

  const lsResult = await lsRefs(client, base);
  if (lsResult instanceof Response) {
    return { kind: "failed", reason: `ls-refs:http-${lsResult.status}` };
  }
  const { refs: remoteRefs, headTarget } = lsResult;
  const branches = remoteRefs.filter((ref) => ref.name.startsWith("refs/heads/"));
  const headRef = remoteRefs.find((ref) => ref.name === headTarget) ?? branches[0] ?? remoteRefs[0];

  const local = await stub.getHeadAndRefs();
  const localByName = new Map(local.refs.map((ref) => [ref.name, ref.oid] as const));
  const localOids = new Set(local.refs.map((ref) => ref.oid));

  const refsChanged =
    remoteRefs.length !== local.refs.length ||
    remoteRefs.some((ref) => localByName.get(ref.name) !== ref.oid);
  const wants = [...new Set(remoteRefs.map((ref) => ref.oid))].filter((oid) => !localOids.has(oid));

  const packs: { packKey: string; packBytes: number; idxBytes: number; objectCount: number }[] = [];
  let totalObjects = 0;

  if (wants.length > 0) {
    const haves = [...localOids].slice(0, 64);
    const fetched = await fetchPack(client, base, wants, haves);
    if (fetched instanceof Response) {
      return { kind: "failed", reason: `fetch:http-${fetched.status}` };
    }
    if ("fatal" in fetched) return { kind: "failed", reason: `fetch:${fetched.fatal}` };
    if (fetched.pack.byteLength > MAX_PACK_BYTES) {
      return { kind: "failed", reason: "pack-too-large" };
    }
    if (fetched.pack.byteLength < 32 || td.decode(fetched.pack.subarray(0, 4)) !== "PACK") {
      return { kind: "failed", reason: "not-a-pack" };
    }

    const limiter = getLimiter(cacheCtx);
    const prefix = doPrefix(stub.id.toString());
    const packKey = r2PackKey(prefix, `pack-sync-${crypto.randomUUID().slice(0, 8)}.pack`);
    await limiter.run("r2:put-sync-pack", () => env.REPO_BUCKET.put(packKey, fetched.pack));
    let subrequests = 1;
    const countSubrequest = (n = 1) => {
      subrequests += n;
    };

    const scanResult = await scanPack({
      env,
      packKey,
      packSize: fetched.pack.byteLength,
      limiter,
      countSubrequest,
      log,
    });
    const resolveResult = await resolveDeltasAndWriteIdx({
      env,
      packKey,
      packSize: fetched.pack.byteLength,
      limiter,
      countSubrequest,
      log,
      scanResult,
      repoId,
      cacheCtx,
    });
    totalObjects = resolveResult.objectCount;
    packs.push({
      packKey,
      packBytes: fetched.pack.byteLength,
      idxBytes: resolveResult.idxBytes,
      objectCount: resolveResult.objectCount,
    });
  }

  if (!refsChanged && wants.length === 0) {
    return { kind: "synced", refs: remoteRefs.length, objects: 0, changed: false };
  }

  await stub.ingestRemoteSync({
    packs,
    refs: remoteRefs,
    head: headRef ? { target: headRef.name, oid: headRef.oid } : undefined,
    actor,
  });

  log.info("sync:done", {
    url: base,
    refs: remoteRefs.length,
    objects: totalObjects,
    wants: wants.length,
  });
  return { kind: "synced", refs: remoteRefs.length, objects: totalObjects, changed: true };
}
