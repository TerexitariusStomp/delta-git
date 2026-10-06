import type { ProjectCardRow, ProjectColumnRow, ProjectRow } from "../db/schema";

import { newPrefixedId } from "@/worker/common";
import { getDb } from "../db";
import {
  deleteProjectCard,
  deleteProjectColumn,
  getIssueByNumber,
  getProjectById,
  getProjectByNumber,
  getProjectCard,
  getProjectColumn,
  insertProject,
  insertProjectCard,
  insertProjectColumn,
  listProjectCards,
  listProjectColumns,
  listProjects,
  nextCardPosition,
  nextColumnPosition,
  nextProjectNumber,
  updateProject,
  updateProjectCard,
} from "../db";
import { appendOpLogEntry } from "./oplog";

// Project boards — columns + cards where a card is an issue reference or a
// free-text note. Op-log discipline mirrors issues/discussions.

export type ProjectBoard = ProjectRow & {
  columns: (ProjectColumnRow & { cards: ProjectCardRow[] })[];
};

async function toBoard(ctx: DurableObjectState, project: ProjectRow): Promise<ProjectBoard> {
  const db = getDb(ctx.storage);
  const columns = await listProjectColumns(db, project.id);
  const withCards = await Promise.all(
    columns.map(async (col) => ({
      ...col,
      cards: await listProjectCards(db, col.id),
    }))
  );
  return { ...project, columns: withCards };
}

export async function createProjectState(args: {
  ctx: DurableObjectState;
  title: string;
  description: string | null;
  actor: string;
}): Promise<{ status: "created"; project: ProjectBoard } | { status: "invalid" }> {
  const title = args.title.trim();
  if (!title) return { status: "invalid" };
  const db = getDb(args.ctx.storage);
  const now = Date.now();
  const row: ProjectRow = {
    id: newPrefixedId("prj"),
    number: await nextProjectNumber(db),
    title,
    description: args.description,
    state: "open",
    author: args.actor,
    createdAt: now,
    updatedAt: now,
  };
  await insertProject(db, row);
  // GitHub creates three starter columns; so do we.
  for (const [i, name] of ["To do", "In progress", "Done"].entries()) {
    await insertProjectColumn(db, {
      id: newPrefixedId("pcl"),
      projectId: row.id,
      name,
      position: i,
      createdAt: now,
    });
  }
  await appendOpLogEntry(
    db,
    { kind: "project.create", actor: args.actor, payload: { id: row.id, number: row.number } },
    now
  );
  return { status: "created", project: await toBoard(args.ctx, row) };
}

export async function listProjectsState(
  ctx: DurableObjectState,
  args: { state?: "open" | "closed"; limit?: number } = {}
): Promise<ProjectRow[]> {
  const db = getDb(ctx.storage);
  return await listProjects(db, args);
}

export async function getProjectState(
  ctx: DurableObjectState,
  number: number
): Promise<{ status: "ok"; project: ProjectBoard } | { status: "not-found" }> {
  const db = getDb(ctx.storage);
  const project = await getProjectByNumber(db, number);
  if (!project) return { status: "not-found" };
  return { status: "ok", project: await toBoard(ctx, project) };
}

export async function updateProjectState(args: {
  ctx: DurableObjectState;
  number: number;
  patch: { title?: string; description?: string | null; state?: "open" | "closed" };
  actor: string;
}): Promise<
  { status: "updated"; project: ProjectBoard } | { status: "not-found" } | { status: "invalid" }
> {
  const db = getDb(args.ctx.storage);
  const project = await getProjectByNumber(db, args.number);
  if (!project) return { status: "not-found" };
  const next: Partial<ProjectRow> = { updatedAt: Date.now() };
  if (args.patch.title !== undefined) {
    const title = args.patch.title.trim();
    if (!title) return { status: "invalid" };
    next.title = title;
  }
  if (args.patch.description !== undefined) next.description = args.patch.description;
  if (args.patch.state !== undefined) next.state = args.patch.state;
  await updateProject(db, project.id, next);
  await appendOpLogEntry(
    db,
    {
      kind: "project.update",
      actor: args.actor,
      payload: { id: project.id, fields: Object.keys(args.patch) },
    },
    Date.now()
  );
  const updated = (await getProjectById(db, project.id))!;
  return { status: "updated", project: await toBoard(args.ctx, updated) };
}

export async function addProjectColumnState(args: {
  ctx: DurableObjectState;
  number: number;
  name: string;
  actor: string;
}): Promise<
  { status: "created"; column: ProjectColumnRow } | { status: "not-found" } | { status: "invalid" }
> {
  const name = args.name.trim();
  if (!name) return { status: "invalid" };
  const db = getDb(args.ctx.storage);
  const project = await getProjectByNumber(db, args.number);
  if (!project) return { status: "not-found" };
  const row: ProjectColumnRow = {
    id: newPrefixedId("pcl"),
    projectId: project.id,
    name,
    position: await nextColumnPosition(db, project.id),
    createdAt: Date.now(),
  };
  await insertProjectColumn(db, row);
  return { status: "created", column: row };
}

export async function deleteProjectColumnState(args: {
  ctx: DurableObjectState;
  number: number;
  columnId: string;
  actor: string;
}): Promise<{ status: "deleted" } | { status: "not-found" }> {
  const db = getDb(args.ctx.storage);
  const project = await getProjectByNumber(db, args.number);
  if (!project) return { status: "not-found" };
  const column = await getProjectColumn(db, args.columnId);
  if (!column || column.projectId !== project.id) return { status: "not-found" };
  await deleteProjectColumn(db, column.id);
  return { status: "deleted" };
}

export async function addProjectCardState(args: {
  ctx: DurableObjectState;
  number: number;
  columnId: string;
  kind: "issue" | "note";
  issueNumber?: number;
  note?: string;
  actor: string;
}): Promise<
  | { status: "created"; card: ProjectCardRow }
  | { status: "not-found" }
  | { status: "invalid"; reason: string }
> {
  const db = getDb(args.ctx.storage);
  const project = await getProjectByNumber(db, args.number);
  if (!project) return { status: "not-found" };
  const column = await getProjectColumn(db, args.columnId);
  if (!column || column.projectId !== project.id) return { status: "not-found" };
  if (args.kind === "issue") {
    if (args.issueNumber === undefined) return { status: "invalid", reason: "issue required" };
    const issue = await getIssueByNumber(db, args.issueNumber);
    if (!issue) return { status: "invalid", reason: "issue not found" };
  } else if (!args.note?.trim()) {
    return { status: "invalid", reason: "note required" };
  }
  const row: ProjectCardRow = {
    id: newPrefixedId("pcd"),
    columnId: column.id,
    kind: args.kind,
    issueNumber: args.kind === "issue" ? (args.issueNumber ?? null) : null,
    note: args.kind === "note" ? (args.note?.trim() ?? null) : null,
    position: await nextCardPosition(db, column.id),
    author: args.actor,
    createdAt: Date.now(),
  };
  await insertProjectCard(db, row);
  return { status: "created", card: row };
}

export async function moveProjectCardState(args: {
  ctx: DurableObjectState;
  number: number;
  cardId: string;
  columnId: string;
  position?: number;
  actor: string;
}): Promise<{ status: "moved" } | { status: "not-found" } | { status: "invalid" }> {
  const db = getDb(args.ctx.storage);
  const project = await getProjectByNumber(db, args.number);
  if (!project) return { status: "not-found" };
  const card = await getProjectCard(db, args.cardId);
  if (!card) return { status: "not-found" };
  const column = await getProjectColumn(db, args.columnId);
  if (!column || column.projectId !== project.id) return { status: "invalid" };
  const position = args.position ?? (await nextCardPosition(db, column.id));
  await updateProjectCard(db, card.id, { columnId: column.id, position });
  return { status: "moved" };
}

export async function deleteProjectCardState(args: {
  ctx: DurableObjectState;
  number: number;
  cardId: string;
  actor: string;
}): Promise<{ status: "deleted" } | { status: "not-found" }> {
  const db = getDb(args.ctx.storage);
  const project = await getProjectByNumber(db, args.number);
  if (!project) return { status: "not-found" };
  const card = await getProjectCard(db, args.cardId);
  if (!card) return { status: "not-found" };
  await deleteProjectCard(db, card.id);
  return { status: "deleted" };
}
