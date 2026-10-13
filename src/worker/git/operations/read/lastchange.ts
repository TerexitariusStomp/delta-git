import type { CacheContext } from "@/worker/cache";
import { readLooseObjectRaw } from "./objects";
import { resolveRef } from "./refs";
import { readCommitInfo } from "./commits";
import { isTreeMode, joinTreePath, readTree } from "./tree";
import type { CommitInfo, TreeEntry } from "./types";

/** A single "last touched by" record for a directory listing row. */
export type PathLastChange = {
  /** Full commit OID that most recently touched the path. */
  oid: string;
  /** First line of the commit message. */
  subject: string;
  /** Author timestamp (unix seconds). */
  when: number;
  /** Author display name. */
  author?: string;
};

export type DirLastChangeResult = {
  /** Resolved commit OID the walk started from (ref or oid input). */
  headOid: string;
  /** Entry name → last-change commit, keyed by the directory entry name. */
  entries: Record<string, PathLastChange>;
  /**
   * Total first-parent commit count — only set when the walk reached the root
   * commit inside its budget, i.e. the count is exact rather than truncated.
   */
  commitCount?: number;
};

export type DirEntryForLastChange = { name: string; isDir: boolean };

const DEFAULT_MAX_COMMITS = 100;
const DEFAULT_TIME_BUDGET_MS = 1500;

const EMPTY_TREE: TreeEntry[] = [];

/**
 * Compute the most recent commit that touched each entry of a directory —
 * the GitHub file-table "last commit" column.
 *
 * Walks first-parent history from `ref`. For each commit, every still-
 * unmatched path is resolved in the commit's tree and its first parent's
 * tree in lockstep: identical subtree oids short-circuit immediately, so
 * an entry only counts as touched when its own blob/tree oid changed.
 * Directory entries are covered for free — any descendant change alters
 * the directory's tree oid, no changed-file enumeration needed (which
 * also makes the walk immune to diff-truncation misses).
 *
 * Cost is ~1 commit read + ~1 new tree read per step because per-path
 * checks run in parallel and parsed trees are memoized across the walk
 * (a commit's parent tree is the next commit's own). Paths left
 * unresolved when the budget runs out are absent from the result —
 * callers render `—`.
 */
export async function listPathsLastChange(
  env: Env,
  repoId: string,
  ref: string,
  dirPath: string,
  wanted: DirEntryForLastChange[],
  cacheCtx?: CacheContext,
  opts?: { maxCommits?: number; timeBudgetMs?: number }
): Promise<DirLastChangeResult | null> {
  if (wanted.length === 0) return null;
  const maxCommits = Math.max(1, Math.floor(opts?.maxCommits ?? DEFAULT_MAX_COMMITS));
  const timeBudgetMs = Math.max(100, Math.floor(opts?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS));
  const startedAt = Date.now();

  // Same ref resolution as listCommitsFirstParentRange: ref name → oid, raw
  // oid passthrough, annotated-tag peel to the commit underneath.
  let headOid = await resolveRef(env, repoId, ref);
  if (!headOid && /^[0-9a-f]{40}$/i.test(ref)) headOid = ref.toLowerCase();
  if (headOid) {
    const obj = await readLooseObjectRaw(env, repoId, headOid, cacheCtx);
    if (obj && obj.type === "tree") {
      // Raw tree refs can't walk — a tree has no parent history.
      return null;
    }
    if (obj && obj.type === "tag") {
      const text = new TextDecoder().decode(obj.payload);
      const m = text.match(/^object ([0-9a-f]{40})/m);
      if (m) headOid = m[1];
    }
  }
  if (!headOid) return null;

  // Per-walk memo of parsed tree entries. Storing the promise (not the
  // resolved value) dedupes concurrent reads of the same tree both
  // across the parallel per-path checks and across commits — the parent
  // tree resolved in this step is re-read as the current tree next step.
  const treeMemo = new Map<string, Promise<TreeEntry[]>>();
  const readTreeEntries = (oid: string | null | undefined): Promise<TreeEntry[]> => {
    if (!oid) return Promise.resolve(EMPTY_TREE);
    let pending = treeMemo.get(oid);
    if (!pending) {
      pending = readTree(env, repoId, oid, cacheCtx).catch(() => EMPTY_TREE);
      treeMemo.set(oid, pending);
    }
    return pending;
  };

  // Index wanted entries by their full repo-relative path.
  const unmatched = new Map<string, DirEntryForLastChange>();
  for (const w of wanted) {
    unmatched.set(joinTreePath(dirPath, w.name), w);
  }
  const result: Record<string, PathLastChange> = {};

  // Whether `fullPath`'s entry oid differs between curTree and parTree.
  // Descends segment by segment only while both sides still differ; a
  // null tree reads as empty, which makes the root-commit case (no
  // parent) resolve to "present in the tree → touched by the root".
  const pathTouched = async (
    curTree: string | null,
    parTree: string | null,
    fullPath: string
  ): Promise<boolean> => {
    const segs = fullPath.split("/");
    let cur: string | null = curTree;
    let par: string | null = parTree;
    for (let i = 0; i < segs.length && cur; i++) {
      const curEntries = await readTreeEntries(cur);
      const parEntries = par === cur ? curEntries : await readTreeEntries(par);
      const cn = curEntries.find((e) => e.name === segs[i]);
      const pn = parEntries.find((e) => e.name === segs[i]);
      // Identical entry oid (or absent on both sides) → untouched; any
      // content change under a directory rewrites its tree oid.
      if (cn?.oid === pn?.oid) return false;
      if (i === segs.length - 1) return true;
      // Descend only while both sides are still directories — a type
      // change or missing ancestor means the path simply doesn't exist
      // on one side, which is a difference by itself.
      if (!cn || !pn || !isTreeMode(cn.mode) || !isTreeMode(pn.mode)) return true;
      cur = cn.oid;
      par = pn.oid;
    }
    return false;
  };

  const seen = new Set<string>();
  let info: CommitInfo;
  try {
    info = await readCommitInfo(env, repoId, headOid, cacheCtx);
  } catch {
    return null;
  }
  let scanned = 0;
  let commitCount: number | undefined;
  while (
    !seen.has(info.oid) &&
    scanned < maxCommits &&
    unmatched.size > 0 &&
    Date.now() - startedAt < timeBudgetMs
  ) {
    seen.add(info.oid);
    scanned++;
    const parOid = info.parents[0];
    let parInfo: CommitInfo | undefined;
    if (parOid) {
      // The parent commit object doubles as next iteration's current —
      // carry it forward instead of re-reading.
      parInfo = await readCommitInfo(env, repoId, parOid, cacheCtx).catch(() => undefined);
    }
    const commit = info;
    const parTree = parInfo?.tree ?? null;
    await Promise.all(
      [...unmatched.entries()].map(async ([path, w]) => {
        if (await pathTouched(commit.tree, parTree, path)) {
          unmatched.delete(path);
          result[w.name] = toLastChange(commit);
        }
      })
    );
    if (!parOid) {
      // Reached the root commit — the first-parent count is exact.
      commitCount = scanned;
      break;
    }
    if (!parInfo) break;
    info = parInfo;
  }

  return { headOid, entries: result, commitCount };
}

function toLastChange(info: CommitInfo): PathLastChange {
  const subject = info.message.split("\n", 1)[0] ?? "";
  return {
    oid: info.oid,
    subject,
    when: info.author?.when ?? info.committer?.when ?? 0,
    author: info.author?.name ?? info.committer?.name,
  };
}
