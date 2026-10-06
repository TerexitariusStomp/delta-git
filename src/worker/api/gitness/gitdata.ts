// Gitness facade: git data endpoints — refs, commits, trees, diffs.
//
// Notable translations:
//   - The SPA asks for diffs as `Accept: text/plain` and feeds the body to
//     Diff2Html, so `/diff/{range}` and `/commits/{sha}/diff` emit unified
//     diff text (generated with jsdiff `createTwoFilesPatch`), not the
//     `GitFileDiff[]` JSON shape the typed schema suggests.
//   - `range` is `{base}...{head}` (three-dot → diff from merge base) or
//     `{base}..{head}` (two-dot → direct compare).
//   - `/paths` and the tree-diff walker are bounded — this backend reads
//     objects per-RPC, so we cap entries instead of walking unbounded.

import { createTwoFilesPatch } from "diff";
import type { AppRouter } from "@/worker/routes/hono";
import type { CacheContext } from "@/worker/cache";
import {
  getHeadAndRefs,
  resolveRef,
  readCommit,
  readCommitInfo,
  readTree,
  readPath,
  readLooseObjectRaw,
  listCommitsFirstParentRange,
  listPathsLastChange,
  isTreeMode,
  isSymlinkMode,
} from "@/worker/git/operations/read";
import type { TreeEntry } from "@/worker/git/operations/read/types";
import { LICENSE_NAME, LICENSE_SIGNATURES } from "@/worker/git/operations/read/license";
import { attemptMerge, mergeDryRun, findMergeBase } from "@/worker/merge/engine";
import { writeServerPack } from "@/worker/merge/packWriter";
import { doPrefix, packIndexKey, r2PackKey } from "@/worker/keys";
import { isValidRef } from "@/shared/web";
import { getRepoStub } from "@/worker/common";
import { commitFileActions, type CommitFilesRequest } from "./commitFiles";
import { buildZip, collectArchiveEntries, computeBlame, computeLanguages } from "./archival";
import { readRepoRules, ruleBlocksRef } from "./stores";
import { readCommitMeta, writeCommitMeta } from "./commitmeta";
import type { PrComment } from "./prmeta";
import {
  emitRepoEvent,
  gErr,
  gNotFound,
  numericId,
  type GitnessContext,
  type RepoAccessOk,
  pageParams,
  paginate,
  parseRepoRef,
  requireWriter,
  resolveGitnessRepo,
  setPageHeaders,
  toGitnessCommit,
} from "./shared";

// Bounds: object reads are DO/R2 RPCs behind a per-request subrequest budget.
const MAX_DIFF_ENTRIES = 300;
const MAX_PATH_ENTRIES = 4000;
const MAX_PATCH_BLOB_BYTES = 256 * 1024;
const MAX_TOTAL_PATCH_BYTES = 1024 * 1024;
const MAX_TREE_PAIRS = 2000;
const DIVERGENCE_WALK_LIMIT = 512;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type ResolvedRef = { kind: "oid"; oid: string } | { kind: "error"; response: Response };

async function mustResolveRef(
  env: Env,
  repoId: string,
  ref: string,
  cacheCtx: CacheContext
): Promise<ResolvedRef> {
  const oid = await resolveRef(env, repoId, ref, cacheCtx);
  if (oid) return { kind: "oid", oid };
  if (/^[0-9a-f]{40}$/i.test(ref)) return { kind: "oid", oid: ref.toLowerCase() };
  return {
    kind: "error",
    response: new Response(JSON.stringify({ message: `ref not found: ${ref}` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

export interface TreeChange {
  path: string;
  status: "added" | "modified" | "deleted";
  oldOid?: string;
  newOid?: string;
}

/**
 * Recursive two-tree diff. Entries with equal oids prune whole subtrees, so
 * cost tracks actual change surface, not repo size.
 */
export async function diffTrees(
  env: Env,
  repoId: string,
  baseTreeOid: string | undefined,
  headTreeOid: string | undefined,
  prefix: string,
  out: TreeChange[],
  state: { pairs: number },
  cacheCtx?: CacheContext
): Promise<void> {
  if (out.length >= MAX_DIFF_ENTRIES || state.pairs >= MAX_TREE_PAIRS) return;
  const [base, head] = await Promise.all([
    baseTreeOid ? readTree(env, repoId, baseTreeOid, cacheCtx) : Promise.resolve([]),
    headTreeOid ? readTree(env, repoId, headTreeOid, cacheCtx) : Promise.resolve([]),
  ]);
  state.pairs++;
  const byName = new Map<string, { old?: TreeEntry; new?: TreeEntry }>();
  for (const e of base) byName.set(e.name, { old: e });
  for (const e of head) byName.set(e.name, { ...byName.get(e.name), new: e });
  for (const [name, pair] of byName) {
    if (out.length >= MAX_DIFF_ENTRIES || state.pairs >= MAX_TREE_PAIRS) return;
    const path = prefix ? `${prefix}/${name}` : name;
    const o = pair.old;
    const n = pair.new;
    if (o && n && o.oid === n.oid && o.mode === n.mode) continue;
    if (o && n && isTreeMode(o.mode) && isTreeMode(n.mode)) {
      await diffTrees(env, repoId, o.oid, n.oid, path, out, state, cacheCtx);
      continue;
    }
    if (o && !n) {
      // Subtree removed wholesale — enumerate it so the diff lists every file.
      if (isTreeMode(o.mode)) {
        await enumerateTree(env, repoId, o.oid, path, "deleted", out, state, cacheCtx);
      } else {
        out.push({ path, status: "deleted", oldOid: o.oid });
      }
      continue;
    }
    if (n && !o) {
      if (isTreeMode(n.mode)) {
        await enumerateTree(env, repoId, n.oid, path, "added", out, state, cacheCtx);
      } else {
        out.push({ path, status: "added", newOid: n.oid });
      }
      continue;
    }
    // Same name, different type or oid — treat as modify of blobs.
    if (o && n && isTreeMode(o.mode) && !isTreeMode(n.mode)) {
      await enumerateTree(env, repoId, o.oid, path, "deleted", out, state, cacheCtx);
      out.push({ path, status: "added", newOid: n.oid });
      continue;
    }
    if (o && n && !isTreeMode(o.mode) && isTreeMode(n.mode)) {
      out.push({ path, status: "deleted", oldOid: o.oid });
      await enumerateTree(env, repoId, n.oid, path, "added", out, state, cacheCtx);
      continue;
    }
    out.push({ path, status: "modified", oldOid: o!.oid, newOid: n!.oid });
  }
}

async function enumerateTree(
  env: Env,
  repoId: string,
  treeOid: string,
  prefix: string,
  status: "added" | "deleted",
  out: TreeChange[],
  state: { pairs: number },
  cacheCtx?: CacheContext
): Promise<void> {
  if (out.length >= MAX_DIFF_ENTRIES || state.pairs >= MAX_TREE_PAIRS) return;
  const entries = await readTree(env, repoId, treeOid, cacheCtx);
  state.pairs++;
  for (const e of entries) {
    const path = `${prefix}/${e.name}`;
    if (isTreeMode(e.mode)) {
      await enumerateTree(env, repoId, e.oid, path, status, out, state, cacheCtx);
    } else {
      out.push(
        status === "added" ? { path, status, newOid: e.oid } : { path, status, oldOid: e.oid }
      );
    }
  }
}

async function readBlobText(
  env: Env,
  repoId: string,
  oid: string | undefined,
  cacheCtx?: CacheContext
): Promise<string | undefined> {
  if (!oid) return undefined;
  const obj = await readLooseObjectRaw(env, repoId, oid, cacheCtx);
  if (!obj || obj.type !== "blob" || obj.payload.length > MAX_PATCH_BLOB_BYTES) {
    return undefined;
  }
  // Binary sniff: NUL in the first 8KB means we leave it out of the text diff.
  const head = obj.payload.subarray(0, 8192);
  if (head.includes(0)) return undefined;
  return new TextDecoder().decode(obj.payload);
}

export async function commitTreeOf(
  env: Env,
  repoId: string,
  oid: string,
  cacheCtx?: CacheContext
): Promise<string | undefined> {
  const c = await readCommit(env, repoId, oid, cacheCtx).catch(() => undefined);
  return c?.tree;
}

export async function diffCommitsText(
  env: Env,
  repoId: string,
  baseOid: string | undefined,
  headOid: string,
  cacheCtx?: CacheContext
): Promise<string> {
  const [baseTree, headTree] = await Promise.all([
    baseOid ? commitTreeOf(env, repoId, baseOid, cacheCtx) : Promise.resolve(undefined),
    commitTreeOf(env, repoId, headOid, cacheCtx),
  ]);
  const changes: TreeChange[] = [];
  const state = { pairs: 0 };
  await diffTrees(env, repoId, baseTree, headTree, "", changes, state, cacheCtx);
  let body = "";
  for (const ch of changes) {
    if (body.length >= MAX_TOTAL_PATCH_BYTES) break;
    const oldText =
      ch.status !== "added" ? await readBlobText(env, repoId, ch.oldOid, cacheCtx) : undefined;
    const newText =
      ch.status !== "deleted" ? await readBlobText(env, repoId, ch.newOid, cacheCtx) : undefined;
    if (oldText === undefined && newText === undefined) {
      body += `diff --git a/${ch.path} b/${ch.path}\nBinary files differ\n`;
      continue;
    }
    body += createTwoFilesPatch(
      `a/${ch.path}`,
      `b/${ch.path}`,
      oldText ?? "",
      newText ?? "",
      undefined,
      undefined,
      { context: 3 }
    );
  }
  return body;
}

interface RangeSpec {
  base: string;
  head: string;
  threeDot: boolean;
}

function parseRange(range: string): RangeSpec | null {
  const three = range.split("...");
  if (three.length === 2 && three[0] && three[1]) {
    return { base: three[0], head: three[1], threeDot: true };
  }
  const two = range.split("..");
  if (two.length === 2 && two[0] && two[1]) {
    return { base: two[0], head: two[1], threeDot: false };
  }
  return null;
}

/** Resolve `{base}...{head}` to the tree oids the diff should compare. */
async function resolveRangeTrees(
  env: Env,
  repoId: string,
  range: string,
  cacheCtx: CacheContext
): Promise<{ baseOid?: string; headOid: string } | Response> {
  const spec = parseRange(range);
  if (!spec) {
    return new Response(JSON.stringify({ message: `invalid range: ${range}` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const [base, head] = await Promise.all([
    mustResolveRef(env, repoId, spec.base, cacheCtx),
    mustResolveRef(env, repoId, spec.head, cacheCtx),
  ]);
  if (base.kind === "error") return base.response;
  if (head.kind === "error") return head.response;
  let baseOid = base.oid;
  if (spec.threeDot) {
    baseOid = (await findMergeBase(env, repoId, base.oid, head.oid, cacheCtx)) ?? base.oid;
  }
  return { baseOid, headOid: head.oid };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

async function listContent(c: GitnessContext, access: RepoAccessOk, path: string) {
  const ref = c.req.query("git_ref") || "main";
  const result = await readPath(c.env, access.route.doName, ref, path, access.cacheCtx).catch(
    () => null
  );
  if (!result) return gNotFound(c, "path");

  if (result.type === "blob") {
    // Chunked base64 — spread-calling fromCharCode on a large payload
    // overflows the argument limit.
    let bin = "";
    const CHUNK = 8192;
    for (let i = 0; i < result.content.length; i += CHUNK) {
      bin += String.fromCharCode(...result.content.subarray(i, i + CHUNK));
    }
    return c.json({
      type: "file",
      name: path.split("/").pop() ?? path,
      path,
      sha: result.oid,
      content: {
        encoding: "base64",
        data: btoa(bin),
        size: result.size ?? result.content.length,
      },
    });
  }

  // Directory listing. `latest_commit` per entry comes from the bounded
  // last-change walk — the SSR file table used the same source.
  const wanted = result.entries.map((e) => ({ name: e.name, isDir: isTreeMode(e.mode) }));
  const lastChange = await listPathsLastChange(
    c.env,
    access.route.doName,
    ref,
    path,
    wanted,
    access.cacheCtx
  ).catch(() => null);
  const entries = result.entries.map((e) => {
    const lc = lastChange?.entries[e.name];
    return {
      name: e.name,
      path: path ? `${path}/${e.name}` : e.name,
      sha: e.oid,
      type: isTreeMode(e.mode) ? "dir" : isSymlinkMode(e.mode) ? "symlink" : "file",
      latest_commit: lc
        ? {
            sha: lc.oid,
            title: lc.subject,
            message: lc.subject,
            author: {
              identity: { name: lc.author ?? "", email: "" },
              when: new Date(lc.when * 1000).toISOString(),
            },
          }
        : undefined,
    };
  });
  const name = path.split("/").pop() ?? "";
  return c.json({
    type: "dir",
    name,
    path,
    content: { entries },
  });
}

export function registerGitnessGitdata(router: AppRouter) {
  // --- refs ---------------------------------------------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/branches", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const { refs } = await getHeadAndRefs(c.env, access.route.doName, access.cacheCtx);
    const branches = refs
      .filter((r) => r.name.startsWith("refs/heads/"))
      .map((r) => ({
        name: r.name.slice("refs/heads/".length),
        sha: r.oid,
        is_default: r.name === "refs/heads/main",
      }));
    return c.json(branches);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/branches/:branch_name", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const name = c.req.param("branch_name");
    const oid = await resolveRef(c.env, access.route.doName, `refs/heads/${name}`, access.cacheCtx);
    if (!oid) return gNotFound(c, "branch");
    const info = await readCommitInfo(c.env, access.route.doName, oid, access.cacheCtx).catch(
      () => undefined
    );
    return c.json({
      name,
      sha: oid,
      is_default: name === "main",
      commit: info ? toGitnessCommit(info) : undefined,
    });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/tags", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const { refs } = await getHeadAndRefs(c.env, access.route.doName, access.cacheCtx);
    const tags = await Promise.all(
      refs
        .filter((r) => r.name.startsWith("refs/tags/"))
        .map(async (r) => {
          // Peel annotated tag objects down to the commit they point at.
          let oid = r.oid;
          const obj = await readLooseObjectRaw(c.env, access.route.doName, oid, access.cacheCtx);
          if (obj?.type === "tag") {
            const m = new TextDecoder().decode(obj.payload).match(/^object ([0-9a-f]{40})/m);
            if (m) oid = m[1];
          }
          return {
            name: r.name.slice("refs/tags/".length),
            sha: oid,
            is_annotated: obj?.type === "tag",
          };
        })
    );
    return c.json(tags);
  });

  // --- commits --------------------------------------------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/commits", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const ref = c.req.query("git_ref") || "main";
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "30", 10) || 30));
    const after = c.req.query("after");
    // `after` is a sha cursor: commits reachable from it via first-parent,
    // excluding the cursor itself → offset 1 starting at that sha.
    const start = after ?? ref;
    const offset = after ? 1 : (page - 1) * limit;
    try {
      const commits = await listCommitsFirstParentRange(
        c.env,
        access.route.doName,
        start,
        offset,
        limit,
        access.cacheCtx
      );
      return c.json({ commits: commits.map(toGitnessCommit), total_commits: null });
    } catch {
      // Ref not found / empty repo → honest empty list rather than 500.
      return c.json({ commits: [], total_commits: 0 });
    }
  });

  router.get("/api/v1/repos/:repo_ref{.+}/commits/:commit_sha", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const sha = c.req.param("commit_sha");
    const info = await readCommitInfo(c.env, access.route.doName, sha, access.cacheCtx).catch(
      () => undefined
    );
    if (!info) return gNotFound(c, "commit");
    return c.json(toGitnessCommit(info));
  });

  // Commit comments — GitHub's line-free conversation on a commit. Stored
  // per-oid in KV; anonymous readers get them on public repos.
  router.get("/api/v1/repos/:repo_ref{.+}/commits/:commit_sha/comments", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const sha = c.req.param("commit_sha");
    const meta = await readCommitMeta(c.env, access.route.doName, sha);
    return c.json(
      meta.comments.map((cm) => ({
        id: cm.id,
        author: cm.author,
        text: cm.text,
        created: cm.created,
        edited: cm.edited,
        reactions: cm.reactions ?? {},
      }))
    );
  });

  router.post("/api/v1/repos/:repo_ref{.+}/commits/:commit_sha/comments", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const sha = c.req.param("commit_sha");
    const info = await readCommitInfo(c.env, gate.route.doName, sha, gate.cacheCtx).catch(
      () => undefined
    );
    if (!info) return gNotFound(c, "commit");
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
    const text = body?.text?.trim();
    if (!text) return gErr(c, 400, "text is required");
    const meta = await readCommitMeta(c.env, gate.route.doName, sha);
    const comment: PrComment = {
      id: (meta.comments.at(-1)?.id ?? 0) + 1,
      author: gate.actor,
      text,
      created: Date.now(),
      edited: Date.now(),
    };
    meta.comments.push(comment);
    await writeCommitMeta(c.env, gate.route.doName, sha, meta);
    return c.json(
      { id: comment.id, author: comment.author, text: comment.text, created: comment.created },
      201
    );
  });

  // Unified diff text — the SPA parses it with Diff2Html.
  router.get("/api/v1/repos/:repo_ref{.+}/commits/:commit_sha/diff", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const sha = c.req.param("commit_sha");
    const commit = await readCommit(c.env, access.route.doName, sha, access.cacheCtx).catch(
      () => undefined
    );
    if (!commit) return gNotFound(c, "commit");
    const body = await diffCommitsText(
      c.env,
      access.route.doName,
      commit.parents[0],
      sha,
      access.cacheCtx
    );
    return new Response(body, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/diff/:range", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const trees = await resolveRangeTrees(
      c.env,
      access.route.doName,
      c.req.param("range"),
      access.cacheCtx
    );
    if (trees instanceof Response) return trees;
    const body = await diffCommitsText(
      c.env,
      access.route.doName,
      trees.baseOid,
      trees.headOid,
      access.cacheCtx
    );
    return new Response(body, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/diff-stats/:range", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const trees = await resolveRangeTrees(
      c.env,
      access.route.doName,
      c.req.param("range"),
      access.cacheCtx
    );
    if (trees instanceof Response) return trees;
    const changes: TreeChange[] = [];
    const state = { pairs: 0 };
    const [baseTree, headTree] = await Promise.all([
      trees.baseOid
        ? commitTreeOf(c.env, access.route.doName, trees.baseOid, access.cacheCtx)
        : Promise.resolve(undefined),
      commitTreeOf(c.env, access.route.doName, trees.headOid, access.cacheCtx),
    ]);
    await diffTrees(
      c.env,
      access.route.doName,
      baseTree,
      headTree,
      "",
      changes,
      state,
      access.cacheCtx
    );
    return c.json({
      files: changes.map((ch) => ({ path: ch.path, status: ch.status })),
      total: { files_changed: changes.length },
    });
  });

  // --- merge check + divergence ----------------------------------------------

  router.post("/api/v1/repos/:repo_ref{.+}/merge-check/:range", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const spec = parseRange(c.req.param("range"));
    if (!spec) return gErr(c, 400, `invalid range: ${c.req.param("range")}`);
    const [base, head] = await Promise.all([
      mustResolveRef(c.env, access.route.doName, spec.base, access.cacheCtx),
      mustResolveRef(c.env, access.route.doName, spec.head, access.cacheCtx),
    ]);
    if (base.kind === "error") return base.response;
    if (head.kind === "error") return head.response;
    const result = await mergeDryRun({
      env: c.env,
      repoId: access.route.doName,
      targetRef: `refs/heads/${spec.base}`,
      baseOid: base.oid,
      deltaOid: head.oid,
      cacheCtx: access.cacheCtx,
    });
    if ("error" in result) return gErr(c, 422, result.error);
    return c.json({ mergeable: result.mergeable, conflict_files: result.conflicts });
  });

  router.post("/api/v1/repos/:repo_ref{.+}/commits/calculate-divergence", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const body = (await c.req.json().catch(() => null)) as { from?: string; to?: string } | null;
    if (!body?.from || !body?.to) return gErr(c, 400, "from and to are required");
    const [a, b] = await Promise.all([
      mustResolveRef(c.env, access.route.doName, body.from, access.cacheCtx),
      mustResolveRef(c.env, access.route.doName, body.to, access.cacheCtx),
    ]);
    if (a.kind === "error") return a.response;
    if (b.kind === "error") return b.response;

    // First-parent reachability counts, bounded like findMergeBase's walk.
    const ancestorsOf = async (start: string): Promise<Set<string>> => {
      const seen = new Set<string>();
      let oid: string | undefined = start;
      while (oid && seen.size < DIVERGENCE_WALK_LIMIT) {
        if (seen.has(oid)) break;
        seen.add(oid);
        const cm: { tree: string; parents: string[]; message: string } | undefined =
          await readCommit(c.env, access.route.doName, oid, access.cacheCtx).catch(() => undefined);
        oid = cm?.parents[0];
      }
      return seen;
    };
    const [aSet, bSet] = await Promise.all([ancestorsOf(a.oid), ancestorsOf(b.oid)]);
    const ahead = [...aSet].filter((x) => !bSet.has(x)).length;
    const behind = [...bSet].filter((x) => !aSet.has(x)).length;
    return c.json([{ ahead, behind }]);
  });

  // --- content / trees --------------------------------------------------------

  // The SPA requests the root listing as `/content` with no path segment —
  // `:path{.+}` requires one, so register the bare route explicitly.
  router.get("/api/v1/repos/:repo_ref{.+}/content", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    return listContent(c, access, "");
  });

  router.get("/api/v1/repos/:repo_ref{.+}/content/:path{.+}", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const path = c.req.param("path").replace(/\/+$/, "");
    return listContent(c, access, path);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/raw/:path{.+}", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const ref = c.req.query("git_ref") || "main";
    const result = await readPath(
      c.env,
      access.route.doName,
      ref,
      c.req.param("path"),
      access.cacheCtx
    ).catch(() => null);
    if (!result || result.type !== "blob") return gNotFound(c, "path");
    return new Response(new Blob([result.content.slice().buffer]), {
      headers: { "Content-Type": "application/octet-stream" },
    });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/paths", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const ref = c.req.query("git_ref") || "main";
    const files: string[] = [];
    const directories: string[] = [];
    const state = { pairs: 0 };
    const walk = async (treeOid: string, prefix: string): Promise<void> => {
      if (files.length + directories.length >= MAX_PATH_ENTRIES) return;
      const entries = await readTree(c.env, access.route.doName, treeOid, access.cacheCtx);
      state.pairs++;
      for (const e of entries) {
        const p = prefix ? `${prefix}/${e.name}` : e.name;
        if (isTreeMode(e.mode)) {
          directories.push(p);
          await walk(e.oid, p);
        } else {
          files.push(p);
        }
      }
    };
    const head = await mustResolveRef(c.env, access.route.doName, ref, access.cacheCtx);
    if (head.kind === "error") return c.json({ files: [], directories: [] });
    const tree = await commitTreeOf(c.env, access.route.doName, head.oid, access.cacheCtx);
    if (tree) await walk(tree, "");
    return c.json({ files, directories });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/summary", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const [{ refs }, open, done] = await Promise.all([
      getHeadAndRefs(c.env, access.route.doName, access.cacheCtx),
      stub.listMergeIntents(["open", "merging", "adjudicating", "conflict"]).catch(() => []),
      stub.listMergeIntents(["merged", "rejected", "expired"]).catch(() => []),
    ]);
    const merged = done.filter((i) => i.status === "merged").length;
    return c.json({
      branch_count: refs.filter((r) => r.name.startsWith("refs/heads/")).length,
      tag_count: refs.filter((r) => r.name.startsWith("refs/tags/")).length,
      pull_req_summary: {
        open_count: open.length,
        merged_count: merged,
        closed_count: done.length - merged,
      },
    });
  });

  // Language histogram: real byte-ish counts (blob entries per extension)
  // walked over the HEAD tree — bounded like /paths.
  router.get("/api/v1/repos/:repo_ref{.+}/languages", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const ref = c.req.query("git_ref") || "main";
    const head = await mustResolveRef(c.env, access.route.doName, ref, access.cacheCtx);
    if (head.kind === "error") return c.json({});
    const tree = await commitTreeOf(c.env, access.route.doName, head.oid, access.cacheCtx);
    if (!tree) return c.json({});
    return c.json(await computeLanguages(c.env, access.route.doName, tree, access.cacheCtx));
  });

  // First-parent line-attribution blame — the real walk, bounded by
  // MAX_BLAME_REVS/MAX_BLAME_LINES in archival.ts.
  router.get("/api/v1/repos/:repo_ref{.+}/blame/:path{.+}", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const ref = c.req.query("git_ref") || "main";
    const head = await mustResolveRef(c.env, access.route.doName, ref, access.cacheCtx);
    if (head.kind === "error") return head.response;
    const path = c.req.param("path").replace(/^\/+|\/+$/g, "");
    const lines = await computeBlame(c.env, access.route.doName, head.oid, path, access.cacheCtx);
    if (!lines) return gNotFound(c, "path");
    return c.json({
      lines: lines.map((l) => ({
        number: l.line,
        commit: {
          sha: l.commit,
          author: { identity: { name: l.author } },
        },
        content: l.content,
      })),
    });
  });

  // --- activity / checks / default branch -------------------------------------

  // Repo activity feed ← the DO op-log (push/merge/status events). Gitness's
  // EnumRepoActivityType only models branch events, so every entry maps to a
  // branch update carrying the op payload.
  router.get("/api/v1/repos/:repo_ref{.+}/activities", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const rows = await stub.listOpLog(0).catch(() => []);
    const page = pageParams(c);
    setPageHeaders(c, page, rows.length);
    return c.json(
      paginate(rows, page).map((row) => {
        let data: unknown = row.payload;
        try {
          data = JSON.parse(row.payload);
        } catch {
          /* payload stays the raw string */
        }
        return {
          repo_id: 0,
          principal_id: numericId(row.actor ?? "system"),
          timestamp: row.createdAt,
          type: "branch-updated",
          payload: { kind: row.kind, actor: row.actor, data },
        };
      })
    );
  });

  // Commit statuses surface as gitness checks — the agent layer already
  // writes them for adjudication results.
  router.get("/api/v1/repos/:repo_ref{.+}/checks/commits/:commit_sha", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const rows = await stub.getCommitStatuses(c.req.param("commit_sha")).catch(() => []);
    const STATUS: Record<string, string> = {
      success: "success",
      failure: "failure",
      error: "error",
      pending: "pending",
    };
    return c.json(
      rows.map((r, i) => ({
        id: i + 1,
        identifier: r.context,
        status: STATUS[r.state] ?? "pending",
        summary: r.description ?? "",
        link: r.targetUrl ?? "",
        created: r.createdAt,
        updated: r.createdAt,
        ended: r.state === "pending" ? undefined : r.createdAt,
      }))
    );
  });

  // Default branch = HEAD target on the DO.
  router.post("/api/v1/repos/:repo_ref{.+}/default-branch", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
    if (!body?.name) return gErr(c, 400, "name required");
    const target = `refs/heads/${body.name.replace(/^refs\/heads\//, "")}`;
    const stub = getRepoStub(c.env, gate.route.doName);
    const { refs } = await stub.getHeadAndRefs();
    if (!refs.some((r) => r.name === target)) return gNotFound(c, "branch");
    await stub.setHead({ target });
    return c.json({ name: body.name });
  });

  // Path details for the file viewer header (mode/size for a single entry).
  router.get("/api/v1/repos/:repo_ref{.+}/path-details", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const ref = c.req.query("git_ref") || "main";
    const path = (c.req.query("path") ?? "").replace(/^\/+|\/+$/g, "");
    const result = await readPath(c.env, access.route.doName, ref, path, access.cacheCtx).catch(
      () => null
    );
    if (!result) return gNotFound(c, "path");
    return c.json({
      name: path.split("/").pop() ?? "",
      path,
      sha: result.type === "blob" ? result.oid : undefined,
      type: result.type === "blob" ? "file" : "dir",
      size: result.type === "blob" ? (result.size ?? result.content.length) : undefined,
    });
  });

  // Archive download: gitness asks for `{ref}.{format}`. Tar redirects to
  // the existing SSR archive lane; zip is built here as a real stored-entry
  // archive over the ref's tree.
  router.get("/api/v1/repos/:repo_ref{.+}/archive/:ref{.+}", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const spec = c.req.param("ref");
    const m = spec.match(/^(.*)\.(tar|zip)$/);
    if (!m) return gErr(c, 400, "format required (tar or zip)");
    const parsed = parseRepoRef(c.req.param("repo_ref"))!;
    if (m[2] === "tar") {
      return c.redirect(`/${parsed.owner}/${parsed.repo}/-/archive/${m[1]}.tar`);
    }
    const head = await mustResolveRef(c.env, access.route.doName, m[1], access.cacheCtx);
    if (head.kind === "error") return head.response;
    const tree = await commitTreeOf(c.env, access.route.doName, head.oid, access.cacheCtx);
    if (!tree) return gNotFound(c, "ref");
    const root = `${parsed.repo}-${head.oid.slice(0, 8)}`;
    const entries: { name: string; data: Uint8Array }[] = [];
    await collectArchiveEntries(c.env, access.route.doName, tree, root, access.cacheCtx, entries, {
      count: 0,
    });
    const zip = buildZip(entries);
    return new Response(zip.slice().buffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${root}.zip"`,
      },
    });
  });

  // --- webhooks --------------------------------------------------------------
  //
  // DO webhook_subs ↔ gitness webhooks. Our trigger vocabulary is coarser
  // (push/merge/adjudication rather than per-object events) — gitness
  // triggers map onto those kinds best-effort, stored verbatim in `events`.

  // Gitness trigger names → internal event kinds. GitHub-named kinds
  // (issues/pull_request/release/star/fork/create/delete/…) are accepted
  // verbatim — emitted events already use that vocabulary.
  const GWH_TO_DG: Record<string, string> = {
    branch_created: "push",
    branch_updated: "push",
    branch_deleted: "push",
    tag_created: "push",
    tag_updated: "push",
    tag_deleted: "push",
    pullreq_created: "merge",
    pullreq_merged: "merge",
    pullreq_updated: "adjudication",
    pullreq_review_submitted: "adjudication",
    issues: "issues",
    issue_comment: "issue_comment",
    pull_request: "pull_request",
    pull_request_review: "pull_request_review",
    release: "release",
    star: "star",
    fork: "fork",
    create: "create",
    delete: "delete",
  };
  const DG_TO_GWH: Record<string, string> = {
    push: "branch_updated",
    "push.patch": "branch_updated",
    "push.web": "branch_updated",
    merge: "pullreq_merged",
    adjudication: "pullreq_updated",
    issues: "issues",
    issue_comment: "issue_comment",
    pull_request: "pull_request",
    pull_request_review: "pull_request_review",
    release: "release",
    star: "star",
    fork: "fork",
    create: "create",
    delete: "delete",
  };

  router.get("/api/v1/repos/:repo_ref{.+}/webhooks", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const subs = await stub.listWebhookSubs().catch(() => []);
    return c.json(
      subs.map((s) => ({
        id: numericId(s.id),
        identifier: s.id,
        url: s.url,
        enabled: s.active === 1,
        triggers: s.events.split(",").map((e) => DG_TO_GWH[e.trim()] ?? "branch_updated"),
        created: s.createdAt,
        updated: s.createdAt,
        created_by: numericId(s.createdBy),
      }))
    );
  });

  router.post("/api/v1/repos/:repo_ref{.+}/webhooks", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      url?: string;
      secret?: string;
      enabled?: boolean;
      triggers?: string[] | null;
    } | null;
    if (!body?.url || !/^https:\/\//.test(body.url)) return gErr(c, 400, "https url required");
    const stub = getRepoStub(c.env, gate.route.doName);
    const id = body.identifier?.trim() || `wh-${crypto.randomUUID().slice(0, 8)}`;
    const events =
      body.triggers && body.triggers.length > 0
        ? [...new Set(body.triggers.map((t) => GWH_TO_DG[t]).filter(Boolean))].join(",")
        : "push";
    await stub.addWebhookSub({
      row: {
        id,
        url: body.url,
        events,
        secret: body.secret ?? null,
        createdBy: gate.actor,
        active: body.enabled === false ? 0 : 1,
        createdAt: Date.now(),
      },
      actor: gate.actor,
    });
    return c.json({
      id: numericId(id),
      identifier: id,
      url: body.url,
      enabled: body.enabled !== false,
      triggers: (body.triggers ?? ["branch_updated"]).filter(Boolean),
    });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/webhooks/:id", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const subs = await stub.listWebhookSubs().catch(() => []);
    const want = c.req.param("id");
    const s = subs.find((x) => x.id === want || String(numericId(x.id)) === want);
    if (!s) return gNotFound(c, "webhook");
    return c.json({
      id: numericId(s.id),
      identifier: s.id,
      url: s.url,
      enabled: s.active === 1,
      triggers: s.events.split(",").map((e) => DG_TO_GWH[e.trim()] ?? "branch_updated"),
      created: s.createdAt,
      updated: s.createdAt,
    });
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/webhooks/:id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      url?: string;
      enabled?: boolean;
      secret?: string;
      triggers?: string[];
    } | null;
    if (body?.url && !/^https:\/\//.test(body.url)) return gErr(c, 400, "https url required");
    const stub = getRepoStub(c.env, gate.route.doName);
    const subs = await stub.listWebhookSubs().catch(() => []);
    const want = c.req.param("id");
    const s = subs.find((x) => x.id === want || String(numericId(x.id)) === want);
    if (!s) return gNotFound(c, "webhook");
    const result = await stub.updateWebhookSub({
      id: s.id,
      patch: {
        url: body?.url,
        active: body?.enabled,
        secret: body?.secret,
        events:
          body?.triggers && body.triggers.length > 0
            ? [...new Set(body.triggers.map((t) => GWH_TO_DG[t]).filter(Boolean))].join(",")
            : undefined,
      },
      actor: gate.actor,
    });
    if (result.status !== "updated") return gNotFound(c, "webhook");
    return c.json({
      id: numericId(s.id),
      identifier: s.id,
      url: body?.url ?? s.url,
      enabled: body?.enabled ?? s.active === 1,
    });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/webhooks/:id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const stub = getRepoStub(c.env, gate.route.doName);
    const subs = await stub.listWebhookSubs().catch(() => []);
    const want = c.req.param("id");
    const s = subs.find((x) => x.id === want || String(numericId(x.id)) === want);
    if (!s) return gNotFound(c, "webhook");
    const result = await stub.deleteWebhookSub({ id: s.id, actor: gate.actor });
    if (result.status !== "deleted") return gNotFound(c, "webhook");
    return c.json({ deleted: true });
  });

  // Executions = the FirehoseAgent's durable per-URL delivery log — real
  // attempts with status/timing, newest first.
  router.get("/api/v1/repos/:repo_ref{.+}/webhooks/:id/executions", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const subs = await stub.listWebhookSubs().catch(() => []);
    const want = c.req.param("id");
    const s = subs.find((x) => x.id === want || String(numericId(x.id)) === want);
    if (!s) return gNotFound(c, "webhook");
    const agent = c.env.FIREHOSE_DO.get(c.env.FIREHOSE_DO.idFromName("firehose"));
    const deliveries = await agent.webhookDeliveries(s.url, 50).catch(() => []);
    return c.json(
      deliveries.map((d, i) => ({
        id: i + 1,
        webhook_id: numericId(s.id),
        trigger_type: d.kind,
        delivery_status: d.ok ? "success" : "failed",
        status_code: d.status,
        error: d.error,
        created: d.startedAt,
        updated: d.finishedAt,
        duration: d.finishedAt - d.startedAt,
      }))
    );
  });

  // Retrigger re-enqueues the recorded delivery verbatim — the queue retry
  // path is the same one live deliveries ride.
  router.post("/api/v1/repos/:repo_ref{.+}/webhooks/:id/executions/:exec/retrigger", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const stub = getRepoStub(c.env, gate.route.doName);
    const subs = await stub.listWebhookSubs().catch(() => []);
    const want = c.req.param("id");
    const s = subs.find((x) => x.id === want || String(numericId(x.id)) === want);
    if (!s) return gNotFound(c, "webhook");
    const agent = c.env.FIREHOSE_DO.get(c.env.FIREHOSE_DO.idFromName("firehose"));
    const deliveries = await agent.webhookDeliveries(s.url, 50).catch(() => []);
    const d = deliveries[parseInt(c.req.param("exec"), 10) - 1];
    if (!d?.payloadJson) return gNotFound(c, "execution");
    await c.env.REPO_TASKS_QUEUE.send({
      kind: "webhook",
      doId: stub.id.toString(),
      repoId: gate.route.doName,
      url: s.url,
      secret: s.secret,
      event: { kind: d.kind, payload: JSON.parse(d.payloadJson) },
    });
    return c.json({ retriggered: true });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/webhooks/:id/executions/:exec", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const subs = await stub.listWebhookSubs().catch(() => []);
    const want = c.req.param("id");
    const s = subs.find((x) => x.id === want || String(numericId(x.id)) === want);
    if (!s) return gNotFound(c, "webhook");
    const agent = c.env.FIREHOSE_DO.get(c.env.FIREHOSE_DO.idFromName("firehose"));
    const deliveries = await agent.webhookDeliveries(s.url, 50).catch(() => []);
    const d = deliveries[parseInt(c.req.param("exec"), 10) - 1];
    if (!d) return gNotFound(c, "execution");
    return c.json({
      id: parseInt(c.req.param("exec"), 10),
      webhook_id: numericId(s.id),
      trigger_type: d.kind,
      delivery_status: d.ok ? "success" : "failed",
      status_code: d.status,
      error: d.error,
      created: d.startedAt,
      updated: d.finishedAt,
    });
  });

  // --- git writes -----------------------------------------------------------
  //
  // Branch/tag create/delete are ref-array edits on the DO; file commits ride
  // the patch pipeline (build objects → stage pack → delta ref + intent →
  // auto-merge), which is how a fast-forward API commit lands on its branch
  // without bypassing intent bookkeeping.

  router.post("/api/v1/repos/:repo_ref{.+}/branches", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      target?: string;
    } | null;
    if (!body?.name || !isValidRef(`refs/heads/${body.name}`)) {
      return gErr(c, 400, "invalid branch name");
    }
    const fullName = `refs/heads/${body.name}`;
    const oid = await resolveRef(c.env, gate.route.doName, body.target || "main", gate.cacheCtx);
    if (!oid) return gErr(c, 400, `target not found: ${body.target ?? "main"}`);
    const result = await addRefViaStub(c.env, gate.route.doName, fullName, oid);
    if (result === "exists") return gErr(c, 409, `branch ${body.name} already exists`);
    emitRepoEvent(c, gate, "create", {
      ref: body.name,
      ref_type: "branch",
      actor: gate.actor,
    });
    return c.json({ name: body.name, sha: oid, is_default: false });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/branches/:branch_name", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const name = c.req.param("branch_name");
    if (name === "main") return gErr(c, 400, "cannot delete the default branch");
    const removed = await removeRefViaStub(c.env, gate.route.doName, `refs/heads/${name}`);
    if (removed === "protected") return gErr(c, 403, `branch ${name} is protected`);
    if (removed === "missing") return gNotFound(c, "branch");
    emitRepoEvent(c, gate, "delete", {
      ref: name,
      ref_type: "branch",
      actor: gate.actor,
    });
    return c.json({ deleted: true });
  });

  router.post("/api/v1/repos/:repo_ref{.+}/tags", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      target?: string;
    } | null;
    if (!body?.name || !isValidRef(`refs/tags/${body.name}`)) {
      return gErr(c, 400, "invalid tag name");
    }
    const oid = await resolveRef(c.env, gate.route.doName, body.target || "main", gate.cacheCtx);
    if (!oid) return gErr(c, 400, `target not found: ${body.target ?? "main"}`);
    const result = await addRefViaStub(c.env, gate.route.doName, `refs/tags/${body.name}`, oid);
    if (result === "exists") return gErr(c, 409, `tag ${body.name} already exists`);
    emitRepoEvent(c, gate, "create", { ref: body.name, ref_type: "tag", actor: gate.actor });
    return c.json({ name: body.name, sha: oid, is_annotated: false });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/tags/:tag_name", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const removed = await removeRefViaStub(
      c.env,
      gate.route.doName,
      `refs/tags/${c.req.param("tag_name")}`
    );
    if (removed === "protected") return gErr(c, 403, "tag is protected");
    if (removed === "missing") return gNotFound(c, "tag");
    emitRepoEvent(c, gate, "delete", {
      ref: c.req.param("tag_name"),
      ref_type: "tag",
      actor: gate.actor,
    });
    return c.json({ deleted: true });
  });

  // GitHub's community profile — scans root + .github/ for the standard
  // health files and reports a completeness percentage.
  router.get("/api/v1/repos/:repo_ref{.+}/community/profile", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const ref = c.req.query("git_ref") || "HEAD";

    const root = await readPath(c.env, access.route.doName, ref, "", access.cacheCtx).catch(
      () => null
    );
    if (!root || root.type !== "tree") return gNotFound(c, "ref");
    const dotGithub = root.entries.find((e) => e.name === ".github" && isTreeMode(e.mode));
    const ghEntries = dotGithub
      ? await readTree(c.env, access.route.doName, dotGithub.oid, access.cacheCtx).catch(
          () => [] as TreeEntry[]
        )
      : [];

    const find = (re: RegExp, dirs: { name: string; entries: TreeEntry[] }[]) => {
      for (const d of dirs) {
        const hit = d.entries.find((e) => !isTreeMode(e.mode) && re.test(e.name));
        if (hit) return { name: hit.name, path: d.name ? `${d.name}/${hit.name}` : hit.name };
      }
      return null;
    };
    const dirs = [
      { name: "", entries: root.entries },
      { name: ".github", entries: ghEntries },
    ];

    const fileEntry = (f: { name: string; path: string } | null) =>
      f ? { name: f.name, path: f.path, url: f.path } : null;

    const readme = find(/^readme(\.\w+)?$/i, dirs);
    const coc = find(/^code[_-]?of[_-]?conduct(\.\w+)?$/i, dirs);
    const contributing = find(/^contributing(\.\w+)?$/i, dirs);
    const security = find(/^security(\.\w+)?$/i, dirs);
    const licenseFile = find(LICENSE_NAME, dirs);
    const ghIssueTpl = ghEntries.find((e) => /^issue[_-]?template/i.test(e.name));
    const ghPrTpl = ghEntries.find((e) => /^pull[_-]?request[_-]?template/i.test(e.name));
    const issueTemplate = ghIssueTpl
      ? { name: ghIssueTpl.name, path: `.github/${ghIssueTpl.name}` }
      : find(/^issue[_-]?template(\.\w+)?$/i, dirs);
    const prTemplate = ghPrTpl
      ? { name: ghPrTpl.name, path: `.github/${ghPrTpl.name}` }
      : find(/^pull[_-]?request[_-]?template(\.\w+)?$/i, dirs);

    // SPDX detection reads the license blob's head chunk — same signature
    // table the badge endpoint uses.
    let license: { name: string; spdx_id: string | null } | null = null;
    if (licenseFile) {
      const blob = await readPath(
        c.env,
        access.route.doName,
        ref,
        licenseFile.path,
        access.cacheCtx
      ).catch(() => null);
      let spdx: string | null = null;
      if (blob?.type === "blob" && !blob.tooLarge) {
        const headChunk = new TextDecoder().decode(blob.content.slice(0, 8 * 1024));
        spdx = LICENSE_SIGNATURES.find(([re]) => re.test(headChunk))?.[1] ?? null;
      }
      license = { name: spdx ?? licenseFile.name, spdx_id: spdx };
    }

    const present = [readme, coc, contributing, security, licenseFile, issueTemplate, prTemplate];
    const health = Math.round((present.filter(Boolean).length / present.length) * 100);
    return c.json({
      health_percentage: health,
      files: {
        code_of_conduct: fileEntry(coc),
        contributing: fileEntry(contributing),
        issue_template: fileEntry(issueTemplate),
        pull_request_template: fileEntry(prTemplate),
        license: license ? { ...license, path: licenseFile!.path } : null,
        readme: fileEntry(readme),
        security: fileEntry(security),
      },
    });
  });

  // Commit-files: file create/update/delete/move/patch in one commit, the
  // way the SPA's file editor saves. Lands via the merge-intent lane — the
  // intent is the audit record for who wrote what through the API.
  router.post("/api/v1/repos/:repo_ref{.+}/commits", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const req = (await c.req.json().catch(() => null)) as CommitFilesRequest | null;
    if (!req?.actions?.length) return gErr(c, 400, "actions required");

    const branch = (req.new_branch || req.branch || "main").replace(/^refs\/heads\//, "");
    const targetRef = `refs/heads/${branch}`;
    const stub = getRepoStub(c.env, gate.route.doName);

    // `new_branch` asks for a fresh ref seeded from `branch`'s head — a
    // gitness "commit to new branch" is our ref-create + commit pair.
    if (req.new_branch) {
      const baseRef = `refs/heads/${(req.branch || "main").replace(/^refs\/heads\//, "")}`;
      const baseOid = await resolveRef(c.env, gate.route.doName, baseRef, gate.cacheCtx);
      if (!baseOid) return gErr(c, 400, `base branch not found: ${req.branch ?? "main"}`);
      if (!isValidRef(targetRef)) return gErr(c, 400, "invalid branch name");
      const added = await addRefViaStub(c.env, gate.route.doName, targetRef, baseOid);
      if (added === "exists") return gErr(c, 409, `branch ${req.new_branch} already exists`);
    }

    const baseOid = await resolveRef(c.env, gate.route.doName, targetRef, gate.cacheCtx);
    if (!baseOid) return gErr(c, 400, `branch not found: ${branch}`);

    const author = req.author?.name
      ? `${req.author.name} <${req.author.email ?? "web@delta-git.invalid>"}`
      : `${gate.actor} <web@delta-git.invalid>`;
    const built = await commitFileActions({
      env: c.env,
      repoId: gate.route.doName,
      baseCommitOid: baseOid,
      req,
      author,
      cacheCtx: gate.cacheCtx,
    });
    if (built.kind === "failed") return gErr(c, 422, built.reason);

    const pack = await writeServerPack(built.objects);
    const packKey = r2PackKey(
      doPrefix(stub.id.toString()),
      `pack-web-${built.commitOid.slice(0, 12)}.pack`
    );
    await c.env.REPO_BUCKET.put(packKey, pack.packBytes);
    await c.env.REPO_BUCKET.put(packIndexKey(packKey), pack.idxBytes);

    const accepted = await stub.acceptPatchCommit({
      targetRef,
      newOid: built.commitOid,
      actor: gate.actor,
      kind: "push.web",
      stagedPack: {
        packKey,
        packBytes: pack.packBytes.length,
        idxBytes: pack.idxBytes.length,
        objectCount: pack.objectCount,
      },
    });
    if (gate.cacheCtx?.memo) {
      // acceptPatchCommit registered the new pack; drop the memoized catalog.
      gate.cacheCtx.memo.packCatalog = undefined;
      gate.cacheCtx.memo.packCatalogPromise = undefined;
    }
    const merge = await attemptMerge({
      env: c.env,
      repoId: gate.route.doName,
      stub,
      intentId: accepted.intent.id,
      actor: gate.actor,
      cacheCtx: gate.cacheCtx,
    });
    if (merge.kind === "conflict") {
      return gErr(c, 422, `commit conflicts: ${merge.conflicts.join(", ")}`);
    }
    const landed = merge.kind === "merged" ? merge.mergeOid : built.commitOid;
    return c.json({
      commit_id: landed,
      changed_files: (req.actions ?? []).filter((a) => a.path).map((a) => ({ path: a.path })),
    });
  });
}

/**
 * Ref create/delete ride `setRefs`, which rewrites the whole refs array.
 * Read-modify-write through the stub keeps delta refs and concurrent intent
 * ref additions intact — getHeadAndRefs returns the freshest DO state.
 */
async function addRefViaStub(
  env: Env,
  doName: string,
  name: string,
  oid: string
): Promise<"ok" | "exists"> {
  const stub = getRepoStub(env, doName);
  const { refs } = await stub.getHeadAndRefs();
  if (refs.some((r) => r.name === name)) return "exists";
  await stub.setRefs([...refs, { name, oid }]);
  return "ok";
}

async function removeRefViaStub(
  env: Env,
  doName: string,
  name: string
): Promise<"ok" | "missing" | "protected"> {
  // Active protection rules block matching ref deletions — the rules CRUD in
  // repos.ts writes the same store this reads.
  const rules = await readRepoRules(env, doName);
  if (ruleBlocksRef(rules, name, "delete")) return "protected";
  const stub = getRepoStub(env, doName);
  const { refs } = await stub.getHeadAndRefs();
  const next = refs.filter((r) => r.name !== name);
  if (next.length === refs.length) return "missing";
  await stub.setRefs(next);
  return "ok";
}
