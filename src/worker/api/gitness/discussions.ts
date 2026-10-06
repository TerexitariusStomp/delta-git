import type { AppRouter } from "@/worker/routes/hono";
import type { DiscussionView } from "@/worker/do/repo/catalog/discussions";
import type { DiscussionCommentRow, ReactionRow } from "@/worker/do/repo/db/schema";

import { getRepoStub } from "@/worker/common";
import { gErr, gNotFound, pageParams, paginate, requireWriter, resolveGitnessRepo } from "./shared";

// GitHub Discussions surface — session-authed like every /api/v1 route.
// There is no GitHub REST v3 discussions API (it's GraphQL-only upstream),
// so the v1 facade is the whole surface for now.

const DISCUSSION_REACTIONS = new Set([
  "+1",
  "-1",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
]);

function discussionView(d: DiscussionView) {
  return {
    number: d.number,
    title: d.title,
    body: d.body ?? null,
    category: d.category,
    user: { login: d.author },
    comments: d.comments,
    answer_comment_id: d.answerCommentId ?? null,
    created_at: new Date(d.createdAt).toISOString(),
    updated_at: new Date(d.updatedAt).toISOString(),
  };
}

function commentView(row: DiscussionCommentRow) {
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

export function registerGitnessDiscussions(router: AppRouter) {
  router.get("/api/v1/repos/:repo_ref{.+}/discussions", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const category = c.req.query("category");
    const discussions = await stub.listDiscussions({ category: category ?? undefined });
    const page = pageParams(c);
    return c.json(paginate(discussions.map(discussionView), page));
  });

  router.post("/api/v1/repos/:repo_ref{.+}/discussions", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const body = (await c.req.json().catch(() => null)) as {
      title?: string;
      body?: string;
      category?: string;
    } | null;
    if (!body?.title?.trim()) return gErr(c, 422, "title required");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.createDiscussion({
      title: body.title,
      body: body.body ?? null,
      category: body.category,
      actor: access.actor,
    });
    if (result.status !== "created") return gErr(c, 422, result.reason);
    return c.json(discussionView(result.discussion), 201);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/discussions/:number", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "discussion");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.getDiscussion(number);
    if (result.status !== "ok") return gNotFound(c, "discussion");
    return c.json(discussionView(result.discussion));
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/discussions/:number", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "discussion");
    const body = (await c.req.json().catch(() => null)) as {
      title?: string;
      body?: string | null;
      category?: string;
    } | null;
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.updateDiscussion({
      number,
      patch: { title: body?.title, body: body?.body, category: body?.category },
      actor: access.actor,
    });
    if (result.status === "not-found") return gNotFound(c, "discussion");
    if (result.status === "invalid") return gErr(c, 422, result.reason);
    return c.json(discussionView(result.discussion));
  });

  router.get("/api/v1/repos/:repo_ref{.+}/discussions/:number/comments", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "discussion");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.listDiscussionComments(number);
    if (result.status !== "ok") return gNotFound(c, "discussion");
    return c.json(result.comments.map(commentView));
  });

  router.post("/api/v1/repos/:repo_ref{.+}/discussions/:number/comments", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "discussion");
    const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
    if (!body?.body?.trim()) return gErr(c, 422, "body required");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.addDiscussionComment({
      number,
      body: body.body,
      actor: access.actor,
    });
    if (result.status === "not-found") return gNotFound(c, "discussion");
    if (result.status === "invalid") return gErr(c, 422, "body required");
    return c.json(commentView(result.comment), 201);
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/discussions/comments/:comment_id", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
    if (!body?.body?.trim()) return gErr(c, 422, "body required");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.editDiscussionComment({
      commentId: c.req.param("comment_id"),
      body: body.body,
      actor: access.actor,
    });
    if (result.status === "not-found") return gNotFound(c, "comment");
    if (result.status === "forbidden") return gErr(c, 403, "not the comment author");
    if (result.status === "invalid") return gErr(c, 422, "body required");
    return c.json({});
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/discussions/comments/:comment_id", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.deleteDiscussionComment({
      commentId: c.req.param("comment_id"),
      actor: access.actor,
    });
    if (result.status === "not-found") return gNotFound(c, "comment");
    if (result.status === "forbidden") return gErr(c, 403, "not the comment author");
    return c.json({});
  });

  // PUT /discussions/:n/answer — mark accepted answer; DELETE clears it.
  router.put("/api/v1/repos/:repo_ref{.+}/discussions/:number/answer", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "discussion");
    const body = (await c.req.json().catch(() => null)) as { comment_id?: string } | null;
    if (!body?.comment_id) return gErr(c, 422, "comment_id required");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.markDiscussionAnswer({
      number,
      commentId: body.comment_id,
      actor: access.actor,
    });
    if (result.status === "not-found") return gNotFound(c, "discussion");
    if (result.status === "invalid") return gErr(c, 422, result.reason);
    return c.json(discussionView(result.discussion));
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/discussions/:number/answer", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "discussion");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.markDiscussionAnswer({
      number,
      commentId: null,
      actor: access.actor,
    });
    if (result.status === "not-found") return gNotFound(c, "discussion");
    if (result.status === "invalid") return gErr(c, 422, result.reason);
    return c.json(discussionView(result.discussion));
  });

  router.get("/api/v1/repos/:repo_ref{.+}/discussions/:number/reactions", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "discussion");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.listDiscussionReactions(number);
    if (result.status !== "ok") return gNotFound(c, "discussion");
    return c.json(reactionSummary(result.reactions));
  });

  router.put("/api/v1/repos/:repo_ref{.+}/discussions/:number/reactions/:reaction", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    const reaction = c.req.param("reaction");
    if (Number.isNaN(number) || !DISCUSSION_REACTIONS.has(reaction)) {
      return gErr(c, 422, "invalid reaction");
    }
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.setDiscussionReaction({
      number,
      reaction,
      actor: access.actor,
      add: true,
    });
    if (result.status === "not-found") return gNotFound(c, "discussion");
    return c.json({});
  });

  router.delete(
    "/api/v1/repos/:repo_ref{.+}/discussions/:number/reactions/:reaction",
    async (c) => {
      const access = await requireWriter(c);
      if (access instanceof Response) return access;
      const number = parseInt(c.req.param("number"), 10);
      const reaction = c.req.param("reaction");
      if (Number.isNaN(number) || !DISCUSSION_REACTIONS.has(reaction)) {
        return gErr(c, 422, "invalid reaction");
      }
      const stub = getRepoStub(c.env, access.route.doName);
      const result = await stub.setDiscussionReaction({
        number,
        reaction,
        actor: access.actor,
        add: false,
      });
      if (result.status === "not-found") return gNotFound(c, "discussion");
      return c.json({});
    }
  );
}
