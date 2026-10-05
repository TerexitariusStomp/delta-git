import type { CacheContext } from "@/worker/cache";
import { readLooseObjectRaw } from "./objects";
import { resolveRef } from "./refs";
import { readCommitInfo } from "./commits";
import { listCommitChangedFiles } from "./diff";
import { joinTreePath } from "./tree";
import type { CommitInfo } from "./types";

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

const DEFAULT_MAX_COMMITS = 50;
const DEFAULT_TIME_BUDGET_MS = 1500;
// Floor for a single commit diff even when the outer budget is nearly spent:
// the outer while-check re-verifies the overall budget before the next commit,
// so giving each diff at least this much headroom can't blow the walk budget.
const MIN_PER_COMMIT_DIFF_BUDGET_MS = 500;

/**
 * Compute the most recent commit that touched each entry of a directory —
 * the GitHub file-table "last commit" column.
 *
 * Walks first-parent history from `ref`, diffing each commit against its
 * first parent and intersecting the changed-path set with the wanted entries.
 * Directory entries match any changed path underneath them (`dir/…`).
 * The first (newest) hit wins; entries left uncovered when the walk budget is
 * exhausted are simply absent from the result — callers render `—`.
 *
 * Bounded by `opts.maxCommits`/`opts.timeBudgetMs`, and by the shared
 * subrequest soft budget inside `listCommitChangedFiles`.
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
    if (obj && obj.type === "tag") {
      const text = new TextDecoder().decode(obj.payload);
      const m = text.match(/^object ([0-9a-f]{40})/m);
      if (m) headOid = m[1];
    }
  }
  if (!headOid) return null;

  // Index wanted entries by their full repo-relative path. Directory entries
  // match the path itself plus any descendant (`dir/` prefix).
  const unmatched = new Map<string, DirEntryForLastChange>();
  for (const w of wanted) {
    unmatched.set(joinTreePath(dirPath, w.name), w);
  }
  const result: Record<string, PathLastChange> = {};
  const assign = (info: CommitInfo, changedPath: string) => {
    const direct = unmatched.get(changedPath);
    if (direct) {
      unmatched.delete(changedPath);
      result[direct.name] = toLastChange(info);
      return;
    }
    for (const [path, w] of unmatched) {
      if (w.isDir && changedPath.startsWith(path + "/")) {
        unmatched.delete(path);
        result[w.name] = toLastChange(info);
      }
    }
  };

  let oid: string | undefined = headOid;
  const seen = new Set<string>();
  let scanned = 0;
  let commitCount: number | undefined;
  while (
    oid &&
    !seen.has(oid) &&
    scanned < maxCommits &&
    unmatched.size > 0 &&
    Date.now() - startedAt < timeBudgetMs
  ) {
    seen.add(oid);
    let info: CommitInfo;
    try {
      info = await readCommitInfo(env, repoId, oid, cacheCtx);
    } catch {
      break;
    }
    scanned++;
    const diff = await listCommitChangedFiles(env, repoId, oid, cacheCtx, {
      // Truncated diffs still credit the paths they did report — unmatched
      // entries just keep walking history. The time budget is the walk's own
      // remaining budget (floored): a hard per-commit cap turns out flaky
      // under parallel load because DO reads count against wall-clock.
      maxFiles: 1000,
      maxTreePairs: 4000,
      timeBudgetMs: Math.max(
        MIN_PER_COMMIT_DIFF_BUDGET_MS,
        timeBudgetMs - (Date.now() - startedAt)
      ),
    });
    for (const entry of diff.entries) {
      assign(info, entry.path);
      if (unmatched.size === 0) break;
    }
    const next: string | undefined = info.parents[0];
    if (!next) {
      // Reached the root commit — the first-parent count is exact.
      commitCount = scanned;
      break;
    }
    oid = next;
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
