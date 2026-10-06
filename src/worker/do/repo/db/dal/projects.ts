import { asc, desc, eq, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  projectCards,
  projectColumns,
  projects,
  type ProjectCardRow,
  type ProjectColumnRow,
  type ProjectRow,
} from "../schema";

// --- projects ----------------------------------------------------------------

export async function nextProjectNumber(db: DrizzleSqliteDODatabase): Promise<number> {
  const rows = await db.select({ n: sql<number>`coalesce(max("number"), 0)` }).from(projects);
  return (rows[0]?.n ?? 0) + 1;
}

export async function insertProject(db: DrizzleSqliteDODatabase, row: ProjectRow): Promise<void> {
  await db.insert(projects).values(row);
}

export async function getProjectById(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<ProjectRow | undefined> {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0];
}

export async function getProjectByNumber(
  db: DrizzleSqliteDODatabase,
  number: number
): Promise<ProjectRow | undefined> {
  const rows = await db.select().from(projects).where(eq(projects.number, number)).limit(1);
  return rows[0];
}

export async function listProjects(
  db: DrizzleSqliteDODatabase,
  args: { state?: "open" | "closed"; limit?: number } = {}
): Promise<ProjectRow[]> {
  const limit = Math.min(100, Math.max(1, args.limit ?? 30));
  if (args.state) {
    return await db
      .select()
      .from(projects)
      .where(eq(projects.state, args.state))
      .orderBy(desc(projects.number))
      .limit(limit);
  }
  return await db.select().from(projects).orderBy(desc(projects.number)).limit(limit);
}

export async function updateProject(
  db: DrizzleSqliteDODatabase,
  id: string,
  patch: Partial<ProjectRow>
): Promise<void> {
  await db.update(projects).set(patch).where(eq(projects.id, id));
}

export async function deleteProject(db: DrizzleSqliteDODatabase, id: string): Promise<void> {
  await db.delete(projects).where(eq(projects.id, id));
}

// --- columns -----------------------------------------------------------------

export async function insertProjectColumn(
  db: DrizzleSqliteDODatabase,
  row: ProjectColumnRow
): Promise<void> {
  await db.insert(projectColumns).values(row);
}

export async function getProjectColumn(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<ProjectColumnRow | undefined> {
  const rows = await db.select().from(projectColumns).where(eq(projectColumns.id, id)).limit(1);
  return rows[0];
}

export async function listProjectColumns(
  db: DrizzleSqliteDODatabase,
  projectId: string
): Promise<ProjectColumnRow[]> {
  return await db
    .select()
    .from(projectColumns)
    .where(eq(projectColumns.projectId, projectId))
    .orderBy(asc(projectColumns.position));
}

export async function deleteProjectColumn(db: DrizzleSqliteDODatabase, id: string): Promise<void> {
  await db.delete(projectColumns).where(eq(projectColumns.id, id));
}

export async function nextColumnPosition(
  db: DrizzleSqliteDODatabase,
  projectId: string
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`coalesce(max("position"), -1)` })
    .from(projectColumns)
    .where(eq(projectColumns.projectId, projectId));
  return (rows[0]?.n ?? -1) + 1;
}

// --- cards -------------------------------------------------------------------

export async function insertProjectCard(
  db: DrizzleSqliteDODatabase,
  row: ProjectCardRow
): Promise<void> {
  await db.insert(projectCards).values(row);
}

export async function getProjectCard(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<ProjectCardRow | undefined> {
  const rows = await db.select().from(projectCards).where(eq(projectCards.id, id)).limit(1);
  return rows[0];
}

export async function listProjectCards(
  db: DrizzleSqliteDODatabase,
  columnId: string
): Promise<ProjectCardRow[]> {
  return await db
    .select()
    .from(projectCards)
    .where(eq(projectCards.columnId, columnId))
    .orderBy(asc(projectCards.position));
}

export async function updateProjectCard(
  db: DrizzleSqliteDODatabase,
  id: string,
  patch: Partial<ProjectCardRow>
): Promise<void> {
  await db.update(projectCards).set(patch).where(eq(projectCards.id, id));
}

export async function deleteProjectCard(db: DrizzleSqliteDODatabase, id: string): Promise<void> {
  await db.delete(projectCards).where(eq(projectCards.id, id));
}

export async function nextCardPosition(
  db: DrizzleSqliteDODatabase,
  columnId: string
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`coalesce(max("position"), -1)` })
    .from(projectCards)
    .where(eq(projectCards.columnId, columnId));
  return (rows[0]?.n ?? -1) + 1;
}
