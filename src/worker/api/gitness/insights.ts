import type { AppRouter } from "@/worker/routes/hono";
import type { CommitInfo } from "@/worker/git/operations/read/types";

import { getRepoStub } from "@/worker/common";
import { listCommitsFirstParentRange } from "@/worker/git/operations/read";
import { gErr, resolveGitnessRepo } from "./shared";

// Insights: pulse/activity/contributors computed on demand from the
// first-parent commit walk — no stored aggregates, so numbers always
// reflect the current DAG. Bound the walk; big histories degrade to
// "last N commits" rather than timing out.

const WALK_LIMIT = 500;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function walkHead(
  c: Parameters<typeof resolveGitnessRepo>[0],
  doName: string,
  cacheCtx: Parameters<typeof listCommitsFirstParentRange>[5]
): Promise<CommitInfo[]> {
  const commits: CommitInfo[] = [];
  let offset = 0;
  const page = 200;
  while (commits.length < WALK_LIMIT) {
    const batch = await listCommitsFirstParentRange(
      c.env,
      doName,
      "HEAD",
      offset,
      page,
      cacheCtx
    ).catch(() => [] as CommitInfo[]);
    commits.push(...batch);
    if (batch.length < page) break;
    offset += batch.length;
  }
  return commits;
}

function weekStart(tsSec: number): number {
  const d = new Date(tsSec * 1000);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // Sunday, GitHub-style
  return Math.floor(d.getTime() / 1000);
}

export function registerGitnessInsights(router: AppRouter) {
  // GET /repos/{ref}/insights/pulse — last-7/30-day rollup
  router.get("/api/v1/repos/:repo_ref{.+}/insights/pulse", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const commits = await walkHead(c, access.route.doName, access.cacheCtx);
    const now = Date.now();
    const inWindow = (days: number) =>
      commits.filter((cm) => now - (cm.committer?.when ?? 0) * 1000 <= days * 86400_000);

    const stub = getRepoStub(c.env, access.route.doName);
    const [openIssues, closedIssues, openPrs] = await Promise.all([
      stub.listIssues({ state: "open" }).catch(() => []),
      stub.listIssues({ state: "closed" }).catch(() => []),
      stub.listWorkIntentsByKind("pr").catch(() => []),
    ]);

    const uniq = (list: CommitInfo[]) =>
      new Set(list.map((cm) => cm.author?.email ?? cm.author?.name ?? "unknown")).size;

    return c.json({
      window_days: [7, 30],
      commits_7d: inWindow(7).length,
      commits_30d: inWindow(30).length,
      authors_7d: uniq(inWindow(7)),
      authors_30d: uniq(inWindow(30)),
      open_issues: openIssues.length,
      closed_issues: closedIssues.length,
      open_pull_requests: openPrs.length,
      // The walk is capped — callers treat "partial" as "≥WALK_LIMIT may exist".
      history_truncated: commits.length >= WALK_LIMIT,
    });
  });

  // GET /repos/{ref}/insights/activity — weekly commit counts (52 weeks)
  router.get("/api/v1/repos/:repo_ref{.+}/insights/activity", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const commits = await walkHead(c, access.route.doName, access.cacheCtx);
    const buckets = new Map<number, number>();
    for (const cm of commits) {
      const wk = weekStart(cm.committer?.when ?? 0);
      if (!wk) continue;
      buckets.set(wk, (buckets.get(wk) ?? 0) + 1);
    }
    // Fill a continuous 52-week series ending this week — sparse weeks are 0.
    const thisWeek = weekStart(Math.floor(Date.now() / 1000));
    const weeks: { week: number; commits: number }[] = [];
    for (let i = 51; i >= 0; i--) {
      const wk = thisWeek - i * (WEEK_MS / 1000);
      weeks.push({ week: wk, commits: buckets.get(wk) ?? 0 });
    }
    return c.json({ total_walked: commits.length, weeks });
  });

  // GET /repos/{ref}/insights/contributors — author rollups, desc by commits
  router.get("/api/v1/repos/:repo_ref{.+}/insights/contributors", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const commits = await walkHead(c, access.route.doName, access.cacheCtx);
    const byAuthor = new Map<
      string,
      { name: string; email: string; commits: number; first: number; last: number }
    >();
    for (const cm of commits) {
      const email = cm.author?.email ?? "unknown";
      const name = cm.author?.name ?? email;
      const when = cm.author?.when ?? 0;
      const row = byAuthor.get(email) ?? {
        name,
        email,
        commits: 0,
        first: when,
        last: when,
      };
      row.commits += 1;
      row.first = Math.min(row.first, when);
      row.last = Math.max(row.last, when);
      byAuthor.set(email, row);
    }
    const contributors = [...byAuthor.values()].sort((a, b) => b.commits - a.commits).slice(0, 100);
    return c.json(contributors);
  });

  // 405 on write attempts keeps the surface honest (GET-only for now).
  router.all("/api/v1/repos/:repo_ref{.+}/insights/*", (c) => gErr(c, 405, "read-only"));
}
