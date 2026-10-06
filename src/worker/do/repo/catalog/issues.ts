import type { IssueCommentRow, IssueRow, LabelRow, MilestoneRow, ReactionRow } from "../db/schema";
import type { WorkIntentRow } from "../db/schema";

import { newPrefixedId } from "@/worker/common";
import { getDb } from "../db";
import {
  countIssueComments,
  deleteIssueComment,
  deleteReaction,
  getIssueById,
  getIssueByNumber,
  getIssueComment,
  getLabelByName,
  getMilestoneById,
  getMilestoneByNumber,
  insertIssue,
  insertIssueComment,
  insertLabel,
  insertMilestone,
  insertReaction,
  insertWorkIntent,
  listIssueAssignees,
  listIssueComments,
  listIssueLabels,
  listIssues,
  listLabels,
  listMilestones,
  listReactions,
  nextIssueNumber,
  nextMilestoneNumber,
  replaceIssueAssignees,
  replaceIssueLabels,
  updateIssue,
  updateIssueComment,
  updateMilestone,
  updateWorkIntent,
} from "../db";
import { appendOpLogEntry } from "./oplog";

// Issue state operations — every mutation writes an op-log entry, and
// create/close keep the materialized work_intents row in lockstep so the
// agent claim lane and the GitHub-shaped UX share one truth.

export type IssueView = IssueRow & {
  labels: LabelRow[];
  assignees: string[];
  comments: number;
  milestone: MilestoneRow | null;
};

async function toIssueView(
  ctx: DurableObjectState,
  row: IssueRow,
  args: { withComments?: boolean } = {}
): Promise<IssueView> {
  const db = getDb(ctx.storage);
  const [labels, assigneeRows, comments, milestone] = await Promise.all([
    listIssueLabels(db, row.id),
    listIssueAssignees(db, row.id),
    args.withComments ? countIssueComments(db, row.id) : Promise.resolve(0),
    row.milestoneId ? getMilestoneById(db, row.milestoneId) : Promise.resolve(undefined),
  ]);
  return {
    ...row,
    labels,
    assignees: assigneeRows.map((a) => a.assignee),
    comments,
    milestone: milestone ?? null,
  };
}

export async function createIssueState(args: {
  ctx: DurableObjectState;
  title: string;
  body: string | null;
  actor: string;
  assignees?: string[];
  labelIds?: string[];
  milestoneId?: string | null;
}): Promise<{ status: "created"; issue: IssueView } | { status: "invalid"; reason: string }> {
  const title = args.title.trim();
  if (!title) return { status: "invalid", reason: "title required" };
  const db = getDb(args.ctx.storage);
  const now = Date.now();
  const id = newPrefixedId("iss");
  const number = await nextIssueNumber(db);

  // Materialize the agent-claimable work intent in the same write — the
  // issue is the GitHub-shaped view of what is, underneath, a work item.
  const workIntent: WorkIntentRow = {
    id: newPrefixedId("wi"),
    title,
    body: args.body,
    createdBy: args.actor,
    kind: "issue",
    sourceUri: null,
    result: null,
    status: "open",
    claimedBy: null,
    claimExpiresAt: null,
    createdAt: now,
    closedAt: null,
  };
  await insertWorkIntent(db, workIntent);

  const row: IssueRow = {
    id,
    number,
    title,
    body: args.body,
    state: "open",
    stateReason: null,
    author: args.actor,
    workIntentId: workIntent.id,
    milestoneId: args.milestoneId ?? null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    closedBy: null,
  };
  await insertIssue(db, row);
  if (args.assignees?.length) await replaceIssueAssignees(db, id, args.assignees, now);
  if (args.labelIds?.length) await replaceIssueLabels(db, id, args.labelIds);

  await appendOpLogEntry(
    db,
    { kind: "issue.create", actor: args.actor, payload: { id, number, title } },
    now
  );
  return { status: "created", issue: await toIssueView(args.ctx, row) };
}

export async function listIssuesState(
  ctx: DurableObjectState,
  args: { state?: "open" | "closed"; limit?: number }
): Promise<IssueView[]> {
  const db = getDb(ctx.storage);
  const rows = await listIssues(db, args);
  return await Promise.all(rows.map((row) => toIssueView(ctx, row, { withComments: true })));
}

export async function getIssueState(
  ctx: DurableObjectState,
  number: number
): Promise<{ status: "ok"; issue: IssueView } | { status: "not-found" }> {
  const db = getDb(ctx.storage);
  const row = await getIssueByNumber(db, number);
  if (!row) return { status: "not-found" };
  return { status: "ok", issue: await toIssueView(ctx, row, { withComments: true }) };
}

export type IssuePatch = {
  title?: string;
  body?: string | null;
  state?: "open" | "closed";
  stateReason?: "completed" | "not_planned" | null;
  milestoneId?: string | null;
  assignees?: string[];
  labelIds?: string[];
};

export async function updateIssueState(args: {
  ctx: DurableObjectState;
  number: number;
  patch: IssuePatch;
  actor: string;
}): Promise<
  | { status: "updated"; issue: IssueView }
  | { status: "not-found" }
  | { status: "invalid"; reason: string }
> {
  const db = getDb(args.ctx.storage);
  const row = await getIssueByNumber(db, args.number);
  if (!row) return { status: "not-found" };

  const now = Date.now();
  const next: Partial<IssueRow> = { updatedAt: now };
  const intentPatch: Partial<WorkIntentRow> = {};

  if (args.patch.title !== undefined) {
    const title = args.patch.title.trim();
    if (!title) return { status: "invalid", reason: "title required" };
    next.title = title;
    intentPatch.title = title;
  }
  if (args.patch.body !== undefined) {
    next.body = args.patch.body;
    intentPatch.body = args.patch.body;
  }
  if (args.patch.milestoneId !== undefined) next.milestoneId = args.patch.milestoneId;

  if (args.patch.state && args.patch.state !== row.state) {
    if (args.patch.state === "closed") {
      next.state = "closed";
      next.stateReason = args.patch.stateReason ?? "completed";
      next.closedAt = now;
      next.closedBy = args.actor;
      // Mirrored close: agents see the work item leave the claim pool.
      intentPatch.status = "closed";
      intentPatch.closedAt = now;
    } else {
      next.state = "open";
      next.stateReason = "reopened";
      next.closedAt = null;
      next.closedBy = null;
      intentPatch.status = "open";
      intentPatch.closedAt = null;
    }
  } else if (args.patch.stateReason !== undefined) {
    next.stateReason = args.patch.stateReason;
  }

  await updateIssue(db, row.id, next);
  if (row.workIntentId && Object.keys(intentPatch).length > 0) {
    await updateWorkIntent(db, row.workIntentId, intentPatch);
  }
  if (args.patch.assignees) await replaceIssueAssignees(db, row.id, args.patch.assignees, now);
  if (args.patch.labelIds) await replaceIssueLabels(db, row.id, args.patch.labelIds);

  await appendOpLogEntry(
    db,
    {
      kind: "issue.update",
      actor: args.actor,
      payload: { id: row.id, number: row.number, fields: Object.keys(args.patch) },
    },
    now
  );
  const updated = (await getIssueById(db, row.id))!;
  return { status: "updated", issue: await toIssueView(args.ctx, updated, { withComments: true }) };
}

export async function addIssueCommentState(args: {
  ctx: DurableObjectState;
  number: number;
  body: string;
  actor: string;
}): Promise<
  { status: "created"; comment: IssueCommentRow } | { status: "not-found" } | { status: "invalid" }
> {
  if (!args.body.trim()) return { status: "invalid" };
  const db = getDb(args.ctx.storage);
  const issue = await getIssueByNumber(db, args.number);
  if (!issue) return { status: "not-found" };
  const now = Date.now();
  const row: IssueCommentRow = {
    id: newPrefixedId("isc"),
    issueId: issue.id,
    body: args.body,
    author: args.actor,
    createdAt: now,
    updatedAt: now,
  };
  await insertIssueComment(db, row);
  await updateIssue(db, issue.id, { updatedAt: now });
  await appendOpLogEntry(
    db,
    { kind: "issue.comment", actor: args.actor, payload: { id: issue.id, number: issue.number } },
    now
  );
  return { status: "created", comment: row };
}

export async function listIssueCommentsState(
  ctx: DurableObjectState,
  number: number
): Promise<{ status: "ok"; comments: IssueCommentRow[] } | { status: "not-found" }> {
  const db = getDb(ctx.storage);
  const issue = await getIssueByNumber(db, number);
  if (!issue) return { status: "not-found" };
  const comments = await listIssueComments(db, issue.id);
  return { status: "ok", comments };
}

export async function editIssueCommentState(args: {
  ctx: DurableObjectState;
  commentId: string;
  body: string;
  actor: string;
}): Promise<
  { status: "updated" } | { status: "not-found" } | { status: "forbidden" } | { status: "invalid" }
> {
  if (!args.body.trim()) return { status: "invalid" };
  const db = getDb(args.ctx.storage);
  const comment = await getIssueComment(db, args.commentId);
  if (!comment) return { status: "not-found" };
  if (comment.author !== args.actor) return { status: "forbidden" };
  await updateIssueComment(db, args.commentId, args.body, Date.now());
  return { status: "updated" };
}

export async function deleteIssueCommentState(args: {
  ctx: DurableObjectState;
  commentId: string;
  actor: string;
}): Promise<{ status: "deleted" } | { status: "not-found" } | { status: "forbidden" }> {
  const db = getDb(args.ctx.storage);
  const comment = await getIssueComment(db, args.commentId);
  if (!comment) return { status: "not-found" };
  if (comment.author !== args.actor) return { status: "forbidden" };
  await deleteIssueComment(db, args.commentId);
  return { status: "deleted" };
}

export async function setIssueReactionState(args: {
  ctx: DurableObjectState;
  number: number;
  reaction: string;
  actor: string;
  add: boolean;
}): Promise<{ status: "ok" } | { status: "not-found" }> {
  const db = getDb(args.ctx.storage);
  const issue = await getIssueByNumber(db, args.number);
  if (!issue) return { status: "not-found" };
  if (args.add) {
    await insertReaction(db, {
      targetType: "issue",
      targetId: issue.id,
      reaction: args.reaction,
      actor: args.actor,
      createdAt: Date.now(),
    });
  } else {
    await deleteReaction(db, {
      targetType: "issue",
      targetId: issue.id,
      reaction: args.reaction,
      actor: args.actor,
    });
  }
  return { status: "ok" };
}

export async function listIssueReactionsState(
  ctx: DurableObjectState,
  number: number
): Promise<{ status: "ok"; reactions: ReactionRow[] } | { status: "not-found" }> {
  const db = getDb(ctx.storage);
  const issue = await getIssueByNumber(db, number);
  if (!issue) return { status: "not-found" };
  return {
    status: "ok",
    reactions: await listReactions(db, { targetType: "issue", targetId: issue.id }),
  };
}

// ---------------------------------------------------------------------------
// Milestones + labels — the registry rows issues point at.
// ---------------------------------------------------------------------------

export async function createMilestoneState(args: {
  ctx: DurableObjectState;
  title: string;
  description: string | null;
  dueOn: number | null;
  actor: string;
}): Promise<{ status: "created"; milestone: MilestoneRow } | { status: "invalid" }> {
  if (!args.title.trim()) return { status: "invalid" };
  const db = getDb(args.ctx.storage);
  const now = Date.now();
  const row: MilestoneRow = {
    id: newPrefixedId("ms"),
    number: await nextMilestoneNumber(db),
    title: args.title.trim(),
    description: args.description,
    state: "open",
    dueOn: args.dueOn,
    createdBy: args.actor,
    createdAt: now,
    closedAt: null,
  };
  await insertMilestone(db, row);
  await appendOpLogEntry(
    db,
    { kind: "milestone.create", actor: args.actor, payload: { id: row.id, number: row.number } },
    now
  );
  return { status: "created", milestone: row };
}

export async function listMilestonesState(
  ctx: DurableObjectState,
  args: { state?: "open" | "closed" }
): Promise<MilestoneRow[]> {
  return await listMilestones(getDb(ctx.storage), args);
}

export async function updateMilestoneState(args: {
  ctx: DurableObjectState;
  number: number;
  patch: {
    title?: string;
    description?: string | null;
    state?: "open" | "closed";
    dueOn?: number | null;
  };
  actor: string;
}): Promise<{ status: "updated"; milestone: MilestoneRow } | { status: "not-found" }> {
  const db = getDb(args.ctx.storage);
  const row = await getMilestoneByNumber(db, args.number);
  if (!row) return { status: "not-found" };
  const patch: Partial<MilestoneRow> = {};
  if (args.patch.title !== undefined) patch.title = args.patch.title;
  if (args.patch.description !== undefined) patch.description = args.patch.description;
  if (args.patch.dueOn !== undefined) patch.dueOn = args.patch.dueOn;
  if (args.patch.state !== undefined) {
    patch.state = args.patch.state;
    patch.closedAt = args.patch.state === "closed" ? Date.now() : null;
  }
  await updateMilestone(db, row.id, patch);
  const updated = (await getMilestoneById(db, row.id))!;
  return { status: "updated", milestone: updated };
}

export async function createLabelState(args: {
  ctx: DurableObjectState;
  name: string;
  color: string;
  description: string | null;
  actor: string;
}): Promise<
  | { status: "created"; label: LabelRow }
  | { status: "exists"; label: LabelRow }
  | { status: "invalid" }
> {
  const name = args.name.trim();
  const color = args.color.replace(/^#/, "");
  if (!name || !/^[0-9a-fA-F]{6}$/.test(color)) return { status: "invalid" };
  const db = getDb(args.ctx.storage);
  const existing = await getLabelByName(db, name);
  if (existing) return { status: "exists", label: existing };
  const row: LabelRow = {
    id: newPrefixedId("lbl"),
    name,
    color: color.toLowerCase(),
    description: args.description,
    createdBy: args.actor,
    createdAt: Date.now(),
  };
  await insertLabel(db, row);
  return { status: "created", label: row };
}

export async function listLabelsState(ctx: DurableObjectState): Promise<LabelRow[]> {
  return await listLabels(getDb(ctx.storage));
}
