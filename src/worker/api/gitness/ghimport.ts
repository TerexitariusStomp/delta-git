// GitHub metadata import — issues, labels, and comments from a REST dump.
//
// The caller fetches the GitHub data (`gh api repos/o/r/issues`, `…/issues/comments`)
// and posts it here — no outbound fetch on our side, so no token handling or
// SSRF surface. GitHub issue numbers can't be preserved (the DO assigns
// sequential ids), so the response carries an old→new number map the caller
// can use to rewrite cross-references.
//
// Original authorship is preserved as a citation line at the top of each
// imported body — the write actor stays the importer, which is honest: we
// can't prove the GitHub user controlled a delta-git identity.

import type { AppRouter } from "@/worker/routes/hono";
import { getRepoStub } from "@/worker/common";
import { gErr, requireWriter, type GitnessContext } from "./shared";

// GitHub REST shapes — the subset of fields the import consumes.
interface GhUser {
  login?: string;
}
interface GhLabel {
  name?: string;
  color?: string;
}
interface GhIssue {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  user?: GhUser | null;
  labels?: (GhLabel | string)[];
  pull_request?: unknown;
  comments?: number;
  created_at?: string;
  closed_at?: string | null;
}
interface GhComment {
  body?: string | null;
  user?: GhUser | null;
  created_at?: string;
}
interface ImportBody {
  source?: string;
  issues?: GhIssue[];
  // Issue comments keyed by the GITHUB number — `gh api …/issues/comments`
  // returns a flat list, so a flat array with `issue_url` is also accepted.
  comments?: Record<string, GhComment[]> | GhCommentWithIssue[];
}
interface GhCommentWithIssue extends GhComment {
  issue_url?: string;
}

const MAX_ISSUES = 500;
const MAX_COMMENTS_PER_ISSUE = 200;

function attribution(user: GhUser | null | undefined, kind: string, when?: string): string {
  const login = user?.login?.trim();
  const stamp = when?.slice(0, 10);
  const who = login ? `@${login}` : "unknown";
  return `> _Imported from GitHub — ${kind} by ${who}${stamp ? ` on ${stamp}` : ""}._\n\n`;
}

/**
 * Import one issue + its comments. Returns the new issue number, or null
 * when the payload is a PR record (GitHub's /issues list embeds them).
 */
async function importIssue(
  c: GitnessContext,
  args: { doName: string; actor: string },
  issue: GhIssue,
  comments: GhComment[]
): Promise<number | null> {
  if (issue.pull_request !== undefined || !issue.title?.trim()) return null;
  const stub = getRepoStub(c.env, args.doName);

  const labelIds: string[] = [];
  for (const l of issue.labels ?? []) {
    const name = typeof l === "string" ? l : l.name;
    if (!name?.trim()) continue;
    const color = typeof l === "string" ? "ededed" : (l.color ?? "ededed").replace(/^#/, "");
    const created = await stub.createLabel({
      name: name.trim(),
      color: /^[0-9a-f]{6}$/i.test(color) ? color : "ededed",
      description: null,
      actor: args.actor,
    });
    if (created.status !== "invalid") labelIds.push(created.label.id);
  }

  const created = await stub.createIssue({
    title: issue.title.trim(),
    body: `${attribution(issue.user, "issue", issue.created_at)}${issue.body ?? ""}`,
    actor: args.actor,
    assignees: [],
    labelIds,
  });
  if (created.status !== "created") return null;
  const number = created.issue.number;

  for (const comment of comments.slice(0, MAX_COMMENTS_PER_ISSUE)) {
    if (!comment.body?.trim()) continue;
    await stub.addIssueComment({
      number,
      body: `${attribution(comment.user, "comment", comment.created_at)}${comment.body}`,
      actor: args.actor,
    });
  }

  if (issue.state === "closed") {
    await stub.updateIssue({ number, patch: { state: "closed" }, actor: args.actor });
  }
  return number;
}

export function registerGitnessGhImport(router: AppRouter) {
  router.post("/api/v1/repos/:repo_ref{.+}/import-metadata", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const body = (await c.req.json().catch(() => null)) as ImportBody | null;
    if (!body || (body.source !== undefined && body.source !== "github")) {
      return gErr(c, 422, "expected { source: 'github', issues: [...], comments: {...} }");
    }
    const issues = Array.isArray(body.issues) ? body.issues : [];
    if (issues.length > MAX_ISSUES) {
      return gErr(c, 422, `too many issues — cap is ${MAX_ISSUES} per call`);
    }

    // Comments arrive either keyed by issue number or as a flat
    // /issues/comments list whose issue_url tail carries the number.
    const commentsByNumber = new Map<number, GhComment[]>();
    if (body.comments && !Array.isArray(body.comments)) {
      for (const [n, list] of Object.entries(body.comments)) {
        const num = parseInt(n, 10);
        if (Number.isFinite(num) && Array.isArray(list)) commentsByNumber.set(num, list);
      }
    } else if (Array.isArray(body.comments)) {
      for (const comment of body.comments) {
        const tail = /\/issues\/(\d+)$/.exec(comment.issue_url ?? "");
        if (!tail) continue;
        const num = parseInt(tail[1], 10);
        commentsByNumber.set(num, [...(commentsByNumber.get(num) ?? []), comment]);
      }
    }

    const args = { doName: access.route.doName, actor: access.actor };
    const numberMap: Record<number, number> = {};
    let created = 0;
    let skipped = 0;
    for (const issue of issues) {
      const next = await importIssue(
        c,
        args,
        issue,
        commentsByNumber.get(issue.number ?? -1) ?? []
      );
      if (next === null) {
        skipped++;
        continue;
      }
      created++;
      if (issue.number !== undefined) numberMap[issue.number] = next;
    }
    const commentCount = [...commentsByNumber.values()].reduce((n, l) => n + l.length, 0);
    return c.json(
      {
        issues_created: created,
        comments_imported: commentCount,
        skipped_pull_requests: skipped,
        number_map: numberMap,
      },
      201
    );
  });
}
