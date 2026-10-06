import type { AppRouter } from "@/worker/routes/hono";
import type { IssueView } from "@/worker/do/repo/catalog/issues";
import type {
  IssueCommentRow,
  LabelRow,
  MilestoneRow,
  ReactionRow,
} from "@/worker/do/repo/db/schema";

import { getRepoStub } from "@/worker/common";
import { parseIssueQuery } from "@/worker/do/repo/catalog/issueQuery";
import { readPath } from "@/worker/git/operations/read/tree";
import {
  emitRepoEvent,
  gErr,
  gNotFound,
  notifyMembers,
  pageParams,
  paginate,
  requireWriter,
  resolveGitnessRepo,
} from "./shared";
import {
  MAX_PINNED_ISSUES,
  MAX_SAVED_VIEWS,
  readIssueLocks,
  readPinnedIssues,
  readSavedViews,
  readIssueTypes,
  writeIssueLocks,
  writePinnedIssues,
  writeSavedViews,
  writeIssueTypes,
  type SavedView,
} from "./stores";

// GitHub-shaped issues surface for the SPA — session-authed like every
// /api/v1 route. The same model is re-exposed as REST v3 for gh/agent
// clients in routes/apiv3Issues.ts; both share the DO's IssueView shape.

const ISSUE_REACTIONS = new Set([
  "+1",
  "-1",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
]);

function labelView(row: LabelRow) {
  return { name: row.name, color: row.color, description: row.description ?? null };
}

function milestoneView(row: MilestoneRow) {
  return {
    number: row.number,
    title: row.title,
    description: row.description ?? null,
    state: row.state,
    due_on: row.dueOn ? new Date(row.dueOn).toISOString() : null,
    created_at: new Date(row.createdAt).toISOString(),
    closed_at: row.closedAt ? new Date(row.closedAt).toISOString() : null,
  };
}

function issueView(issue: IssueView) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state,
    state_reason: issue.stateReason ?? null,
    user: { login: issue.author },
    labels: issue.labels.map(labelView),
    assignees: issue.assignees.map((login) => ({ login })),
    milestone: issue.milestone ? milestoneView(issue.milestone) : null,
    comments: issue.comments,
    work_intent_id: issue.workIntentId,
    created_at: new Date(issue.createdAt).toISOString(),
    updated_at: new Date(issue.updatedAt).toISOString(),
    closed_at: issue.closedAt ? new Date(issue.closedAt).toISOString() : null,
  };
}

function commentView(row: IssueCommentRow) {
  return {
    id: row.id,
    body: row.body,
    user: { login: row.author },
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
  };
}

function reactionSummary(rows: ReactionRow[]) {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.reaction] = (out[r.reaction] ?? 0) + 1;
  return out;
}

/**
 * Pull `type:`/`type:"Name"` tokens out of the raw `q` string — types are a
 * worker-side KV overlay, so the DO-side parser must not see them (it would
 * treat them as free-text terms). Returns the wanted type (if any) and the
 * remaining query for `parseIssueQuery`.
 */
function extractTypeQualifier(raw: string): { type?: string; rest: string } {
  let type: string | undefined;
  const rest = raw
    .replace(/type:"([^"]*)"/g, (_m, name: string) => {
      type = name;
      return " ";
    })
    .replace(/type:([^\s]+)/g, (_m, name: string) => {
      type = name;
      return " ";
    })
    .trim();
  return { type, rest };
}

export function registerGitnessIssues(router: AppRouter) {
  router.get("/api/v1/repos/:repo_ref{.+}/issues", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const state = c.req.query("state");
    const rawQuery = c.req.query("q");
    const { type: wantedType, rest } = rawQuery?.trim()
      ? extractTypeQualifier(rawQuery)
      : { type: undefined, rest: "" };
    const query = rest ? parseIssueQuery(rest) : undefined;
    const issues = await stub.listIssues({
      state: state === "open" || state === "closed" ? state : undefined,
      query,
    });
    // Pinned issues float to the top in pin order (GitHub behavior), then
    // everything else keeps the catalog's default ordering.
    const pins = await readPinnedIssues(c.env, access.route.doName);
    const locks = await readIssueLocks(c.env, access.route.doName);
    const types = await readIssueTypes(c.env, access.route.doName);
    const pinRank = new Map(pins.map((n, i) => [n, i]));
    const ranked = issues
      .filter((i) => wantedType === undefined || types[i.number] === wantedType)
      .map((i) => ({
        view: {
          ...issueView(i),
          type: types[i.number] ?? null,
          pinned: pinRank.has(i.number),
          locked: locks[i.number] !== undefined,
          active_lock_reason: locks[i.number]?.reason ?? null,
        },
        num: i.number,
      }))
      .sort(
        (a, b) =>
          (pinRank.get(a.num) ?? Number.MAX_SAFE_INTEGER) -
          (pinRank.get(b.num) ?? Number.MAX_SAFE_INTEGER)
      )
      .map((r) => r.view);
    const page = pageParams(c);
    return c.json(paginate(ranked, page));
  });

  router.post("/api/v1/repos/:repo_ref{.+}/issues", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const body = (await c.req.json().catch(() => null)) as {
      title?: string;
      body?: string;
      labels?: string[];
      assignees?: string[];
      milestone?: number;
      type?: string;
    } | null;
    if (!body?.title?.trim()) return gErr(c, 422, "title required");

    const stub = getRepoStub(c.env, access.route.doName);
    // Label names → ids, auto-creating labels so issue creation with
    // arbitrary names works like GitHub's API.
    const labelIds: string[] = [];
    for (const name of body.labels ?? []) {
      const created = await stub.createLabel({
        name,
        color: "ededed",
        description: null,
        actor: access.actor,
      });
      if (created.status !== "invalid") labelIds.push(created.label.id);
    }

    const result = await stub.createIssue({
      title: body.title,
      body: body.body ?? null,
      actor: access.actor,
      assignees: body.assignees,
      labelIds,
    });
    if (result.status !== "created") return gErr(c, 422, result.reason);
    if (body.type?.trim()) {
      const types = await readIssueTypes(c.env, access.route.doName);
      types[result.issue.number] = body.type.trim();
      await writeIssueTypes(c.env, access.route.doName, types);
    }
    emitRepoEvent(c, access, "issues", {
      action: "opened",
      number: result.issue.number,
      title: result.issue.title,
      actor: access.actor,
    });
    notifyMembers(c, access, {
      kind: "issue",
      title: `issue #${result.issue.number}: ${result.issue.title}`,
      body: `${access.actor} opened a new issue`,
      excludeUserId: access.viewer?.userId,
      link: `/${access.route.routeNamespaceSlug}/repos/${access.route.routeRepoSlug}/issues/${result.issue.number}`,
    });
    return c.json(issueView(result.issue), 201);
  });

  // Saved views — repo-shared named filter presets over the `q` qualifier
  // grammar. Registered before /issues/:number so "views" isn't parsed as
  // a numeric issue id.
  router.get("/api/v1/repos/:repo_ref{.+}/issues/views", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    return c.json(await readSavedViews(c.env, access.route.doName));
  });

  router.post("/api/v1/repos/:repo_ref{.+}/issues/views", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      query?: string;
    } | null;
    if (!body?.name?.trim()) return gErr(c, 422, "name required");
    const views = await readSavedViews(c.env, access.route.doName);
    if (views.length >= MAX_SAVED_VIEWS) {
      return gErr(c, 409, `at most ${MAX_SAVED_VIEWS} saved views`);
    }
    const view: SavedView = {
      id: (views.at(-1)?.id ?? 0) + 1,
      name: body.name.trim(),
      query: body.query?.trim() ?? "",
      created: Date.now(),
    };
    await writeSavedViews(c.env, access.route.doName, [...views, view]);
    return c.json(view, 201);
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/issues/views/:view_id", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const views = await readSavedViews(c.env, access.route.doName);
    const next = views.filter((v) => v.id !== parseInt(c.req.param("view_id"), 10));
    if (next.length === views.length) return gNotFound(c, "saved view");
    await writeSavedViews(c.env, access.route.doName, next);
    return c.json({});
  });

  router.get("/api/v1/repos/:repo_ref{.+}/issues/:number", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "issue");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.getIssue(number);
    if (result.status !== "ok") return gNotFound(c, "issue");
    const lock = (await readIssueLocks(c.env, access.route.doName))[number];
    const type = (await readIssueTypes(c.env, access.route.doName))[number];
    return c.json({
      ...issueView(result.issue),
      type: type ?? null,
      locked: lock !== undefined,
      active_lock_reason: lock?.reason ?? null,
    });
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/issues/:number", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "issue");
    const body = (await c.req.json().catch(() => null)) as {
      title?: string;
      body?: string | null;
      state?: string;
      state_reason?: string | null;
      labels?: string[];
      assignees?: string[];
      milestone?: number | null;
      type?: string | null;
    } | null;

    const stub = getRepoStub(c.env, access.route.doName);
    const patch: Parameters<typeof stub.updateIssue>[0]["patch"] = {};
    if (body?.title !== undefined) patch.title = body.title;
    if (body?.body !== undefined) patch.body = body.body;
    if (body?.state === "open" || body?.state === "closed") patch.state = body.state;
    if (body?.state_reason === "completed" || body?.state_reason === "not_planned") {
      patch.stateReason = body.state_reason;
    }
    if (body?.assignees) patch.assignees = body.assignees;
    if (body?.labels) {
      const labelIds: string[] = [];
      for (const name of body.labels) {
        const created = await stub.createLabel({
          name,
          color: "ededed",
          description: null,
          actor: access.actor,
        });
        if (created.status !== "invalid") labelIds.push(created.label.id);
      }
      patch.labelIds = labelIds;
    }
    if (body?.milestone !== undefined) {
      if (body.milestone === null) {
        patch.milestoneId = null;
      } else {
        const ms = await stub
          .listMilestones({})
          .then((all) => all.find((m) => m.number === body.milestone));
        if (!ms) return gErr(c, 422, "milestone not found");
        patch.milestoneId = ms.id;
      }
    }

    const result = await stub.updateIssue({ number, patch, actor: access.actor });
    if (result.status === "not-found") return gNotFound(c, "issue");
    if (result.status === "invalid") return gErr(c, 422, result.reason);
    const types = await readIssueTypes(c.env, access.route.doName);
    if (body?.type !== undefined) {
      if (body.type?.trim()) types[number] = body.type.trim();
      else delete types[number];
      await writeIssueTypes(c.env, access.route.doName, types);
    }
    emitRepoEvent(c, access, "issues", {
      action: body?.state === "closed" ? "closed" : body?.state === "open" ? "reopened" : "edited",
      number,
      title: result.issue.title,
      actor: access.actor,
    });
    return c.json({ ...issueView(result.issue), type: types[number] ?? null });
  });

  // Pin/unpin — writer-gated; pin order is insertion order, capped at
  // MAX_PINNED_ISSUES like GitHub.
  router.put("/api/v1/repos/:repo_ref{.+}/issues/:number/pin", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "issue");
    const stub = getRepoStub(c.env, access.route.doName);
    const issue = await stub.getIssue(number);
    if (issue.status !== "ok") return gNotFound(c, "issue");
    const pins = await readPinnedIssues(c.env, access.route.doName);
    if (pins.includes(number)) return c.json({ pinned: true, pins });
    if (pins.length >= MAX_PINNED_ISSUES) {
      return gErr(c, 409, `at most ${MAX_PINNED_ISSUES} issues can be pinned`);
    }
    const next = [...pins, number];
    await writePinnedIssues(c.env, access.route.doName, next);
    return c.json({ pinned: true, pins: next });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/issues/:number/pin", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "issue");
    const pins = await readPinnedIssues(c.env, access.route.doName);
    const next = pins.filter((n) => n !== number);
    if (next.length !== pins.length) await writePinnedIssues(c.env, access.route.doName, next);
    return c.json({ pinned: false, pins: next });
  });

  // Lock/unlock — a full conversation freeze (see the store comment for why
  // collaborators aren't exempt here).
  router.put("/api/v1/repos/:repo_ref{.+}/issues/:number/lock", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "issue");
    const stub = getRepoStub(c.env, access.route.doName);
    const issue = await stub.getIssue(number);
    if (issue.status !== "ok") return gNotFound(c, "issue");
    const body = (await c.req.json().catch(() => null)) as { lock_reason?: string } | null;
    const locks = await readIssueLocks(c.env, access.route.doName);
    locks[number] = { reason: body?.lock_reason, by: access.actor, at: Date.now() };
    await writeIssueLocks(c.env, access.route.doName, locks);
    return c.json({ locked: true });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/issues/:number/lock", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = c.req.param("number");
    const locks = await readIssueLocks(c.env, access.route.doName);
    if (locks[number] !== undefined) {
      delete locks[number];
      await writeIssueLocks(c.env, access.route.doName, locks);
    }
    return c.json({ locked: false });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/issues/:number/comments", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "issue");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.listIssueComments(number);
    if (result.status !== "ok") return gNotFound(c, "issue");
    return c.json(result.comments.map(commentView));
  });

  router.post("/api/v1/repos/:repo_ref{.+}/issues/:number/comments", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "issue");
    const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
    if (!body?.body?.trim()) return gErr(c, 422, "body required");
    const locks = await readIssueLocks(c.env, access.route.doName);
    if (locks[number] !== undefined) return gErr(c, 403, "conversation is locked");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.addIssueComment({ number, body: body.body, actor: access.actor });
    if (result.status === "not-found") return gNotFound(c, "issue");
    if (result.status === "invalid") return gErr(c, 422, "body required");
    emitRepoEvent(c, access, "issue_comment", {
      action: "created",
      number,
      comment_id: result.comment.id,
      actor: access.actor,
    });
    notifyMembers(c, access, {
      kind: "issue",
      title: `issue #${number}: new comment`,
      body: `${access.actor} commented on an issue`,
      excludeUserId: access.viewer?.userId,
      link: `/${access.route.routeNamespaceSlug}/repos/${access.route.routeRepoSlug}/issues/${number}`,
    });
    return c.json(commentView(result.comment), 201);
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/issues/comments/:comment_id", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
    if (!body?.body?.trim()) return gErr(c, 422, "body required");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.editIssueComment({
      commentId: c.req.param("comment_id"),
      body: body.body,
      actor: access.actor,
    });
    if (result.status === "not-found") return gNotFound(c, "comment");
    if (result.status === "forbidden") return gErr(c, 403, "not the comment author");
    if (result.status === "invalid") return gErr(c, 422, "body required");
    return c.json({});
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/issues/comments/:comment_id", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.deleteIssueComment({
      commentId: c.req.param("comment_id"),
      actor: access.actor,
    });
    if (result.status === "not-found") return gNotFound(c, "comment");
    if (result.status === "forbidden") return gErr(c, 403, "not the comment author");
    return c.json({});
  });

  router.get("/api/v1/repos/:repo_ref{.+}/issues/:number/reactions", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "issue");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.listIssueReactions(number);
    if (result.status !== "ok") return gNotFound(c, "issue");
    return c.json(reactionSummary(result.reactions));
  });

  router.put("/api/v1/repos/:repo_ref{.+}/issues/:number/reactions/:reaction", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    const reaction = c.req.param("reaction");
    if (Number.isNaN(number) || !ISSUE_REACTIONS.has(reaction)) {
      return gErr(c, 422, "invalid reaction");
    }
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.setIssueReaction({
      number,
      reaction,
      actor: access.actor,
      add: true,
    });
    if (result.status === "not-found") return gNotFound(c, "issue");
    return c.json({});
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/issues/:number/reactions/:reaction", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    const reaction = c.req.param("reaction");
    if (Number.isNaN(number) || !ISSUE_REACTIONS.has(reaction)) {
      return gErr(c, 422, "invalid reaction");
    }
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.setIssueReaction({
      number,
      reaction,
      actor: access.actor,
      add: false,
    });
    if (result.status === "not-found") return gNotFound(c, "issue");
    return c.json({});
  });

  // --- milestones + labels --------------------------------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/milestones", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const state = c.req.query("state");
    const rows = await stub.listMilestones({
      state: state === "open" || state === "closed" ? state : undefined,
    });
    return c.json(rows.map(milestoneView));
  });

  router.post("/api/v1/repos/:repo_ref{.+}/milestones", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const body = (await c.req.json().catch(() => null)) as {
      title?: string;
      description?: string;
      due_on?: string;
    } | null;
    if (!body?.title?.trim()) return gErr(c, 422, "title required");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.createMilestone({
      title: body.title,
      description: body.description ?? null,
      dueOn: body.due_on ? Date.parse(body.due_on) : null,
      actor: access.actor,
    });
    if (result.status !== "created") return gErr(c, 422, "title required");
    return c.json(milestoneView(result.milestone), 201);
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/milestones/:number", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "milestone");
    const body = (await c.req.json().catch(() => null)) as {
      title?: string;
      description?: string | null;
      state?: string;
      due_on?: string | null;
    } | null;
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.updateMilestone({
      number,
      actor: access.actor,
      patch: {
        title: body?.title,
        description: body?.description,
        state: body?.state === "open" || body?.state === "closed" ? body.state : undefined,
        dueOn: body?.due_on === null ? null : body?.due_on ? Date.parse(body.due_on) : undefined,
      },
    });
    if (result.status !== "updated") return gNotFound(c, "milestone");
    return c.json(milestoneView(result.milestone));
  });

  router.get("/api/v1/repos/:repo_ref{.+}/labels", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    return c.json((await stub.listLabels()).map(labelView));
  });

  router.post("/api/v1/repos/:repo_ref{.+}/labels", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      color?: string;
      description?: string;
    } | null;
    if (!body?.name?.trim() || !body?.color) return gErr(c, 422, "name + color required");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.createLabel({
      name: body.name,
      color: body.color,
      description: body.description ?? null,
      actor: access.actor,
    });
    if (result.status === "invalid") return gErr(c, 422, "invalid name or color");
    return c.json(labelView(result.label), result.status === "exists" ? 200 : 201);
  });

  // GET /api/v1/repos/{ref}/issue-templates — GitHub's .github convention:
  // markdown files under ISSUE_TEMPLATE with YAML front matter become
  // chooser entries for the issue composer. Precedence follows GitHub:
  // .github/ > docs/ > repo root.
  router.get("/api/v1/repos/:repo_ref{.+}/issue-templates", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;

    for (const dir of ISSUE_TEMPLATE_DIRS) {
      const listing = await readPath(c.env, access.route.doName, "HEAD", dir).catch(() => null);
      if (!listing || listing.type !== "tree") continue;
      const files = listing.entries.filter(
        (e) => !e.mode.startsWith("40000") && /\.md$/i.test(e.name) && e.name !== "README.md"
      );
      if (files.length === 0) continue;

      const templates: IssueTemplate[] = [];
      for (const file of files) {
        const blob = await readPath(
          c.env,
          access.route.doName,
          "HEAD",
          `${dir}/${file.name}`,
          access.cacheCtx
        ).catch(() => null);
        if (!blob || blob.type !== "blob" || blob.tooLarge) continue;
        templates.push(parseIssueTemplate(file.name, td.decode(blob.content)));
      }
      if (templates.length > 0) return c.json(templates);
    }
    return c.json([]);
  });
}

const ISSUE_TEMPLATE_DIRS = [".github/ISSUE_TEMPLATE", "docs/ISSUE_TEMPLATE", "ISSUE_TEMPLATE"];
const td = new TextDecoder();

type IssueTemplate = {
  file: string;
  name: string;
  about: string;
  title: string;
  labels: string[];
  assignees: string[];
  body: string;
};

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

/** Front-matter scalar — `[a, b]` and `a, b` both decode to string lists. */
function parseScalarOrList(value: string): string | string[] {
  const bare = stripQuotes(value.trim());
  if (value.trim().startsWith("[") && value.trim().endsWith("]")) {
    return value
      .trim()
      .slice(1, -1)
      .split(",")
      .map((s) => stripQuotes(s.trim()))
      .filter(Boolean);
  }
  if (bare.includes(",")) {
    return bare
      .split(",")
      .map((s) => stripQuotes(s.trim()))
      .filter(Boolean);
  }
  return bare;
}

/**
 * Subset-YAML front matter: `key: value`, `key: [a, b]`, and indented
 * `- item` lists — everything GitHub template files use in practice.
 */
function parseFrontMatter(source: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  const meta: Record<string, string | string[]> = {};
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { meta, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { meta, body: normalized };

  let lastKey: string | undefined;
  for (const line of normalized.slice(4, end).split("\n")) {
    const listItem = /^\s+-\s+(.*)$/.exec(line);
    if (listItem && lastKey) {
      const existing = meta[lastKey];
      const arr = Array.isArray(existing) ? existing : existing ? [existing] : [];
      arr.push(stripQuotes(listItem[1]!.trim()));
      meta[lastKey] = arr;
      continue;
    }
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) {
      lastKey = undefined;
      continue;
    }
    lastKey = kv[1]!.toLowerCase();
    meta[lastKey] = parseScalarOrList(kv[2]!);
  }
  return { meta, body: normalized.slice(end + 4).replace(/^\n/, "") };
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseIssueTemplate(file: string, source: string): IssueTemplate {
  const { meta, body } = parseFrontMatter(source);
  const name = asList(meta.name)[0];
  return {
    file,
    name: name || file.replace(/\.md$/i, ""),
    about: asList(meta.about)[0] ?? "",
    title: asList(meta.title)[0] ?? "",
    labels: asList(meta.labels),
    assignees: asList(meta.assignees),
    body,
  };
}
