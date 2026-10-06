import type { AppRouter } from "@/worker/routes/hono";
import type { ProjectBoard } from "@/worker/do/repo/catalog/projects";
import type { ProjectCardRow, ProjectRow } from "@/worker/do/repo/db/schema";

import { getRepoStub } from "@/worker/common";
import { gErr, gNotFound, pageParams, paginate, requireWriter, resolveGitnessRepo } from "./shared";

// GitHub Projects (classic shape) — numbered boards of columns; cards are
// issue references or free-text notes, repo-local in the DO.

function cardJson(card: ProjectCardRow) {
  return {
    id: card.id,
    kind: card.kind,
    issue_number: card.issueNumber ?? null,
    note: card.note ?? null,
    position: card.position,
    creator: { login: card.author },
    created_at: new Date(card.createdAt).toISOString(),
  };
}

function boardJson(p: ProjectBoard) {
  return {
    number: p.number,
    name: p.title,
    body: p.description ?? null,
    state: p.state,
    creator: { login: p.author },
    columns: p.columns.map((col) => ({
      id: col.id,
      name: col.name,
      position: col.position,
      cards: col.cards.map(cardJson),
    })),
    created_at: new Date(p.createdAt).toISOString(),
    updated_at: new Date(p.updatedAt).toISOString(),
  };
}

function projectJson(p: ProjectRow) {
  return {
    number: p.number,
    name: p.title,
    body: p.description ?? null,
    state: p.state,
    creator: { login: p.author },
    created_at: new Date(p.createdAt).toISOString(),
    updated_at: new Date(p.updatedAt).toISOString(),
  };
}

function num(c: Parameters<typeof gNotFound>[0], what = "project"): number | Response {
  const n = parseInt(c.req.param("number") ?? "", 10);
  return Number.isNaN(n) ? gNotFound(c, what) : n;
}

export function registerGitnessProjects(router: AppRouter) {
  router.get("/api/v1/repos/:repo_ref{.+}/projects", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const state = c.req.query("state");
    const stub = getRepoStub(c.env, access.route.doName);
    const rows = await stub.listProjects({
      state: state === "open" || state === "closed" ? state : undefined,
    });
    const page = pageParams(c);
    return c.json(paginate(rows.map(projectJson), page));
  });

  router.post("/api/v1/repos/:repo_ref{.+}/projects", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      body?: string;
    } | null;
    if (!body?.name?.trim()) return gErr(c, 422, "name required");
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await stub.createProject({
      title: body.name,
      description: body.body ?? null,
      actor: gate.actor,
    });
    if (result.status !== "created") return gErr(c, 422, "name required");
    return c.json(boardJson(result.project), 201);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/projects/:number", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const n = num(c);
    if (n instanceof Response) return n;
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.getProject(n);
    if (result.status !== "ok") return gNotFound(c, "project");
    return c.json(boardJson(result.project));
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/projects/:number", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const n = num(c);
    if (n instanceof Response) return n;
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      body?: string | null;
      state?: string;
    } | null;
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await stub.updateProject({
      number: n,
      patch: {
        title: body?.name,
        description: body?.body,
        state: body?.state === "closed" ? "closed" : body?.state === "open" ? "open" : undefined,
      },
      actor: gate.actor,
    });
    if (result.status === "not-found") return gNotFound(c, "project");
    if (result.status === "invalid") return gErr(c, 422, "invalid patch");
    return c.json(boardJson(result.project));
  });

  router.post("/api/v1/repos/:repo_ref{.+}/projects/:number/columns", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const n = num(c);
    if (n instanceof Response) return n;
    const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
    if (!body?.name?.trim()) return gErr(c, 422, "name required");
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await stub.addProjectColumn({ number: n, name: body.name, actor: gate.actor });
    if (result.status === "not-found") return gNotFound(c, "project");
    if (result.status === "invalid") return gErr(c, 422, "name required");
    return c.json(
      { id: result.column.id, name: result.column.name, position: result.column.position },
      201
    );
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/projects/:number/columns/:column_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const n = num(c);
    if (n instanceof Response) return n;
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await stub.deleteProjectColumn({
      number: n,
      columnId: c.req.param("column_id"),
      actor: gate.actor,
    });
    if (result.status !== "deleted") return gNotFound(c, "column");
    return c.json({ deleted: true });
  });

  router.post("/api/v1/repos/:repo_ref{.+}/projects/:number/cards", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const n = num(c);
    if (n instanceof Response) return n;
    const body = (await c.req.json().catch(() => null)) as {
      column_id?: string;
      issue?: number;
      note?: string;
    } | null;
    if (!body?.column_id) return gErr(c, 422, "column_id required");
    const kind = body.issue !== undefined ? "issue" : "note";
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await stub.addProjectCard({
      number: n,
      columnId: body.column_id,
      kind,
      issueNumber: body.issue,
      note: body.note,
      actor: gate.actor,
    });
    if (result.status === "not-found") return gNotFound(c, "column");
    if (result.status === "invalid") return gErr(c, 422, result.reason);
    return c.json(cardJson(result.card), 201);
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/projects/:number/cards/:card_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const n = num(c);
    if (n instanceof Response) return n;
    const body = (await c.req.json().catch(() => null)) as {
      column_id?: string;
      position?: number;
    } | null;
    if (!body?.column_id) return gErr(c, 422, "column_id required");
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await stub.moveProjectCard({
      number: n,
      cardId: c.req.param("card_id"),
      columnId: body.column_id,
      position: body.position,
      actor: gate.actor,
    });
    if (result.status === "not-found") return gNotFound(c, "card");
    if (result.status === "invalid") return gErr(c, 422, "column not in this project");
    return c.json({ moved: true });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/projects/:number/cards/:card_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const n = num(c);
    if (n instanceof Response) return n;
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await stub.deleteProjectCard({
      number: n,
      cardId: c.req.param("card_id"),
      actor: gate.actor,
    });
    if (result.status !== "deleted") return gNotFound(c, "card");
    return c.json({ deleted: true });
  });
}
