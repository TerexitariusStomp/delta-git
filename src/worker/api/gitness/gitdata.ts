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
import { mergeDryRun, findMergeBase } from "@/worker/merge/engine";
import { getRepoStub } from "@/worker/common";
import { gErr, gNotFound, gStub, resolveGitnessRepo, toGitnessCommit } from "./shared";

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

interface TreeChange {
  path: string;
  status: "added" | "modified" | "deleted";
  oldOid?: string;
  newOid?: string;
}

/**
 * Recursive two-tree diff. Entries with equal oids prune whole subtrees, so
 * cost tracks actual change surface, not repo size.
 */
async function diffTrees(
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

async function commitTreeOf(
  env: Env,
  repoId: string,
  oid: string,
  cacheCtx?: CacheContext
): Promise<string | undefined> {
  const c = await readCommit(env, repoId, oid, cacheCtx).catch(() => undefined);
  return c?.tree;
}

async function diffCommitsText(
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

  router.get("/api/v1/repos/:repo_ref{.+}/content/:path{.+}", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const ref = c.req.query("git_ref") || "main";
    const path = c.req.param("path").replace(/\/+$/, "");
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
    // last-change walk — the SSR file table uses the same source.
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

  router.get("/api/v1/repos/:repo_ref{.+}/languages", async (c) => c.json({}));

  // Blame needs a line-attribution walk we do not have; honest 501.
  router.get("/api/v1/repos/:repo_ref{.+}/blame/:path{.+}", async (c) => gStub(c, "blame"));

  // Git writes via API (branch/tag creation, file commits) are not exposed —
  // our write path is git push + merge intents by design.
  for (const [method, p] of [
    ["post", "/api/v1/repos/:repo_ref{.+}/branches"],
    ["delete", "/api/v1/repos/:repo_ref{.+}/branches/:branch_name"],
    ["post", "/api/v1/repos/:repo_ref{.+}/tags"],
    ["delete", "/api/v1/repos/:repo_ref{.+}/tags/:tag_name"],
    ["post", "/api/v1/repos/:repo_ref{.+}/commits"],
  ] as const) {
    router[method](p, async (c) => gStub(c, "git write via API"));
  }
}
