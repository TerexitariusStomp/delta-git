import type { DiscussionCommentRow, DiscussionRow, ReactionRow } from "../db/schema";

import { newPrefixedId } from "@/worker/common";
import { getDb } from "../db";
import {
  countDiscussionComments,
  deleteDiscussionComment,
  deleteReaction,
  getDiscussionById,
  getDiscussionByNumber,
  getDiscussionComment,
  insertDiscussion,
  insertDiscussionComment,
  insertReaction,
  listDiscussionComments,
  listDiscussions,
  listReactions,
  nextDiscussionNumber,
  updateDiscussion,
  updateDiscussionComment,
} from "../db";
import { appendOpLogEntry } from "./oplog";

// Discussion state operations — same op-log discipline as issues. No
// open/closed lifecycle: a discussion's resolution is an accepted answer
// (Q&A categories) or simply the thread itself.

export const DISCUSSION_CATEGORIES = [
  "general",
  "announcements",
  "ideas",
  "q-a",
  "show-and-tell",
  "polls",
] as const;
export type DiscussionCategory = (typeof DISCUSSION_CATEGORIES)[number];

function validCategory(category: string | undefined): DiscussionCategory | null {
  if (!category) return "general";
  return (DISCUSSION_CATEGORIES as readonly string[]).includes(category)
    ? (category as DiscussionCategory)
    : null;
}

export type DiscussionView = DiscussionRow & {
  comments: number;
};

async function toDiscussionView(
  ctx: DurableObjectState,
  row: DiscussionRow,
  args: { withComments?: boolean } = {}
): Promise<DiscussionView> {
  const db = getDb(ctx.storage);
  const comments = args.withComments ? await countDiscussionComments(db, row.id) : 0;
  return { ...row, comments };
}

export async function createDiscussionState(args: {
  ctx: DurableObjectState;
  title: string;
  body: string | null;
  category?: string;
  actor: string;
}): Promise<
  { status: "created"; discussion: DiscussionView } | { status: "invalid"; reason: string }
> {
  const title = args.title.trim();
  if (!title) return { status: "invalid", reason: "title required" };
  const category = validCategory(args.category);
  if (!category) return { status: "invalid", reason: "unknown category" };
  const db = getDb(args.ctx.storage);
  const now = Date.now();
  const row: DiscussionRow = {
    id: newPrefixedId("dsc"),
    number: await nextDiscussionNumber(db),
    title,
    body: args.body,
    category,
    author: args.actor,
    answerCommentId: null,
    createdAt: now,
    updatedAt: now,
  };
  await insertDiscussion(db, row);
  await appendOpLogEntry(
    db,
    {
      kind: "discussion.create",
      actor: args.actor,
      payload: { id: row.id, number: row.number, title, category },
    },
    now
  );
  return { status: "created", discussion: await toDiscussionView(args.ctx, row) };
}

export async function listDiscussionsState(
  ctx: DurableObjectState,
  args: { category?: string; limit?: number }
): Promise<DiscussionView[]> {
  const db = getDb(ctx.storage);
  const rows = await listDiscussions(db, args);
  return await Promise.all(rows.map((row) => toDiscussionView(ctx, row, { withComments: true })));
}

export async function getDiscussionState(
  ctx: DurableObjectState,
  number: number
): Promise<{ status: "ok"; discussion: DiscussionView } | { status: "not-found" }> {
  const db = getDb(ctx.storage);
  const row = await getDiscussionByNumber(db, number);
  if (!row) return { status: "not-found" };
  return { status: "ok", discussion: await toDiscussionView(ctx, row, { withComments: true }) };
}

export async function updateDiscussionState(args: {
  ctx: DurableObjectState;
  number: number;
  patch: { title?: string; body?: string | null; category?: string };
  actor: string;
}): Promise<
  | { status: "updated"; discussion: DiscussionView }
  | { status: "not-found" }
  | { status: "invalid"; reason: string }
> {
  const db = getDb(args.ctx.storage);
  const row = await getDiscussionByNumber(db, args.number);
  if (!row) return { status: "not-found" };
  const next: Partial<DiscussionRow> = { updatedAt: Date.now() };
  if (args.patch.title !== undefined) {
    const title = args.patch.title.trim();
    if (!title) return { status: "invalid", reason: "title required" };
    next.title = title;
  }
  if (args.patch.body !== undefined) next.body = args.patch.body;
  if (args.patch.category !== undefined) {
    const category = validCategory(args.patch.category);
    if (!category) return { status: "invalid", reason: "unknown category" };
    next.category = category;
  }
  await updateDiscussion(db, row.id, next);
  await appendOpLogEntry(
    db,
    {
      kind: "discussion.update",
      actor: args.actor,
      payload: { id: row.id, number: row.number, fields: Object.keys(args.patch) },
    },
    Date.now()
  );
  const updated = (await getDiscussionById(db, row.id))!;
  return {
    status: "updated",
    discussion: await toDiscussionView(args.ctx, updated, { withComments: true }),
  };
}

export async function addDiscussionCommentState(args: {
  ctx: DurableObjectState;
  number: number;
  body: string;
  actor: string;
}): Promise<
  | { status: "created"; comment: DiscussionCommentRow }
  | { status: "not-found" }
  | { status: "invalid" }
> {
  if (!args.body.trim()) return { status: "invalid" };
  const db = getDb(args.ctx.storage);
  const discussion = await getDiscussionByNumber(db, args.number);
  if (!discussion) return { status: "not-found" };
  const now = Date.now();
  const row: DiscussionCommentRow = {
    id: newPrefixedId("dcm"),
    discussionId: discussion.id,
    body: args.body,
    author: args.actor,
    createdAt: now,
    updatedAt: now,
  };
  await insertDiscussionComment(db, row);
  await updateDiscussion(db, discussion.id, { updatedAt: now });
  await appendOpLogEntry(
    db,
    {
      kind: "discussion.comment",
      actor: args.actor,
      payload: { id: discussion.id, number: discussion.number },
    },
    now
  );
  return { status: "created", comment: row };
}

export async function listDiscussionCommentsState(
  ctx: DurableObjectState,
  number: number
): Promise<{ status: "ok"; comments: DiscussionCommentRow[] } | { status: "not-found" }> {
  const db = getDb(ctx.storage);
  const discussion = await getDiscussionByNumber(db, number);
  if (!discussion) return { status: "not-found" };
  return { status: "ok", comments: await listDiscussionComments(db, discussion.id) };
}

export async function editDiscussionCommentState(args: {
  ctx: DurableObjectState;
  commentId: string;
  body: string;
  actor: string;
}): Promise<
  { status: "updated" } | { status: "not-found" } | { status: "forbidden" } | { status: "invalid" }
> {
  if (!args.body.trim()) return { status: "invalid" };
  const db = getDb(args.ctx.storage);
  const comment = await getDiscussionComment(db, args.commentId);
  if (!comment) return { status: "not-found" };
  if (comment.author !== args.actor) return { status: "forbidden" };
  await updateDiscussionComment(db, comment.id, { body: args.body, updatedAt: Date.now() });
  return { status: "updated" };
}

export async function deleteDiscussionCommentState(args: {
  ctx: DurableObjectState;
  commentId: string;
  actor: string;
}): Promise<{ status: "deleted" } | { status: "not-found" } | { status: "forbidden" }> {
  const db = getDb(args.ctx.storage);
  const comment = await getDiscussionComment(db, args.commentId);
  if (!comment) return { status: "not-found" };
  if (comment.author !== args.actor) return { status: "forbidden" };
  await deleteDiscussionComment(db, comment.id);
  const discussion = await getDiscussionById(db, comment.discussionId);
  // A deleted accepted-answer clears the marker — the thread reverts to
  // unanswered rather than pointing at a ghost comment.
  if (discussion?.answerCommentId === comment.id) {
    await updateDiscussion(db, discussion.id, { answerCommentId: null });
  }
  return { status: "deleted" };
}

/** Mark/unmark the accepted answer — Q&A discussions only. */
export async function markDiscussionAnswerState(args: {
  ctx: DurableObjectState;
  number: number;
  commentId: string | null;
  actor: string;
}): Promise<
  | { status: "updated"; discussion: DiscussionView }
  | { status: "not-found" }
  | { status: "invalid"; reason: string }
> {
  const db = getDb(args.ctx.storage);
  const discussion = await getDiscussionByNumber(db, args.number);
  if (!discussion) return { status: "not-found" };
  if (args.commentId !== null) {
    const comment = await getDiscussionComment(db, args.commentId);
    if (!comment || comment.discussionId !== discussion.id) {
      return { status: "invalid", reason: "comment not in this discussion" };
    }
  }
  const now = Date.now();
  await updateDiscussion(db, discussion.id, {
    answerCommentId: args.commentId,
    updatedAt: now,
  });
  await appendOpLogEntry(
    db,
    {
      kind: args.commentId ? "discussion.answer" : "discussion.unanswer",
      actor: args.actor,
      payload: { id: discussion.id, number: discussion.number, commentId: args.commentId },
    },
    now
  );
  const updated = (await getDiscussionById(db, discussion.id))!;
  return {
    status: "updated",
    discussion: await toDiscussionView(args.ctx, updated, { withComments: true }),
  };
}

// --- reactions (target_type='discussion' / 'discussion_comment') -----------

export async function setDiscussionReactionState(args: {
  ctx: DurableObjectState;
  number: number;
  reaction: string;
  actor: string;
  add: boolean;
}): Promise<{ status: "ok" } | { status: "not-found" }> {
  const db = getDb(args.ctx.storage);
  const discussion = await getDiscussionByNumber(db, args.number);
  if (!discussion) return { status: "not-found" };
  if (args.add) {
    await insertReaction(db, {
      targetType: "discussion",
      targetId: discussion.id,
      reaction: args.reaction,
      actor: args.actor,
      createdAt: Date.now(),
    });
  } else {
    await deleteReaction(db, {
      targetType: "discussion",
      targetId: discussion.id,
      reaction: args.reaction,
      actor: args.actor,
    });
  }
  return { status: "ok" };
}

export async function listDiscussionReactionsState(
  ctx: DurableObjectState,
  number: number
): Promise<{ status: "ok"; reactions: ReactionRow[] } | { status: "not-found" }> {
  const db = getDb(ctx.storage);
  const discussion = await getDiscussionByNumber(db, number);
  if (!discussion) return { status: "not-found" };
  return {
    status: "ok",
    reactions: await listReactions(db, { targetType: "discussion", targetId: discussion.id }),
  };
}
