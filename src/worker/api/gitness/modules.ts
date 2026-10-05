// Gitness module endpoints — notifications inbox, space environments, and
// space-level artifact listing. Registered before the greedy space routes so
// the nested paths win.

import type { AppRouter } from "@/worker/routes/hono";

import { loadViewer } from "@/worker/auth/session";
import {
  countUnreadNotifications,
  deleteEnvironment,
  findEnvironment,
  insertEnvironment,
  listArtifactsForNamespace,
  listEnvironments,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
  updateEnvironment,
} from "@/worker/db/d1/dal/modules";
import { findNamespaceBySlug } from "@/worker/db/d1/dal/namespaces";
import { viewerIsNamespaceMember } from "@/worker/auth/pat";
import { newPrefixedId } from "@/worker/common";
import { isValidOwnerRepo } from "@/shared/web";
import { gErr, gNotFound, numericId } from "./shared";
import type { GitnessContext } from "./shared";

async function resolveMemberSpace(
  c: GitnessContext,
  ref: string
): Promise<{ id: string; slug: string } | Response> {
  const viewer = await loadViewer(c);
  if (!viewer) return gErr(c, 401, "unauthorized");
  const slug = ref.replace(/\/+$/, "");
  if (!isValidOwnerRepo(slug)) return gNotFound(c, "space");
  const ns = await findNamespaceBySlug(c.var.db, slug);
  if (!ns) return gNotFound(c, "space");
  if (!(await viewerIsNamespaceMember(c.var.db, viewer.userId, ns.id))) {
    return gErr(c, 403, "forbidden");
  }
  return { id: ns.id, slug: ns.slug };
}

export function registerGitnessModules(router: AppRouter) {
  // --- notifications --------------------------------------------------------

  router.get("/api/v1/notifications", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const rows = await listNotificationsForUser(c.var.db, viewer.userId);
    const unread = await countUnreadNotifications(c.var.db, viewer.userId);
    return c.json({
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        link: n.link,
        created: n.createdAt,
        read: n.readAt !== null,
      })),
      unread,
    });
  });

  router.patch("/api/v1/notifications/read-all", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    await markAllNotificationsRead(c.var.db, viewer.userId, Date.now());
    return c.json({});
  });

  router.patch("/api/v1/notifications/:id", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as { read?: boolean } | null;
    const ok = await markNotificationRead(
      c.var.db,
      c.req.param("id"),
      viewer.userId,
      body?.read === false ? null : Date.now()
    );
    if (!ok) return gNotFound(c, "notification");
    return c.json({});
  });

  // --- environments -----------------------------------------------------------

  router.get("/api/v1/spaces/:space_ref{.+}/environments", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listEnvironments(c.var.db, ns.id);
    return c.json(
      rows.map((row) => ({
        id: numericId(row.id),
        identifier: row.identifier,
        description: row.description ?? "",
        type: row.type,
        created: row.createdAt,
        updated: row.updatedAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/environments", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      description?: string;
      type?: string;
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !isValidOwnerRepo(identifier)) {
      return gErr(c, 400, "valid identifier required");
    }
    if (await findEnvironment(c.var.db, ns.id, identifier)) {
      return gErr(c, 409, "environment exists");
    }
    const now = Date.now();
    const row = await insertEnvironment(c.var.db, {
      id: newPrefixedId("env"),
      namespaceId: ns.id,
      identifier,
      description: body?.description ?? null,
      type: body?.type ?? "pre_production",
      createdAt: now,
      updatedAt: now,
    });
    return c.json(
      {
        id: numericId(row.id),
        identifier: row.identifier,
        description: row.description ?? "",
        type: row.type,
        created: row.createdAt,
        updated: row.updatedAt,
      },
      201
    );
  });

  router.patch("/api/v1/spaces/:space_ref{.+}/environments/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      description?: string;
      type?: string;
    } | null;
    // The SPA passes numericId; match by identifier too since ids squash.
    const key = decodeURIComponent(c.req.param("id"));
    const current =
      (await findEnvironment(c.var.db, ns.id, key)) ??
      (await listEnvironments(c.var.db, ns.id)).find(
        (r) => numericId(r.id) === Number(key) || r.id === key
      );
    if (!current) return gNotFound(c, "environment");
    const row = await updateEnvironment(
      c.var.db,
      current.id,
      {
        ...(body?.identifier ? { identifier: body.identifier.trim().toLowerCase() } : {}),
        ...(body?.description !== undefined ? { description: body.description } : {}),
        ...(body?.type ? { type: body.type } : {}),
      },
      Date.now()
    );
    return c.json({
      id: numericId(row!.id),
      identifier: row!.identifier,
      description: row!.description ?? "",
      type: row!.type,
      created: row!.createdAt,
      updated: row!.updatedAt,
    });
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/environments/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const key = decodeURIComponent(c.req.param("id"));
    const current =
      (await findEnvironment(c.var.db, ns.id, key)) ??
      (await listEnvironments(c.var.db, ns.id)).find(
        (r) => numericId(r.id) === Number(key) || r.id === key
      );
    if (!current) return gNotFound(c, "environment");
    await deleteEnvironment(c.var.db, current.id);
    return c.body(null, 204);
  });

  // --- artifacts (space listing) ------------------------------------------------

  router.get("/api/v1/spaces/:space_ref{.+}/artifacts", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listArtifactsForNamespace(c.var.db, ns.id);
    return c.json(
      rows.map((row) => ({
        name: row.name,
        version: row.version,
        path: row.path,
        repo: row.repoSlug,
        size: row.size,
        sha256: row.sha256,
        content_type: row.contentType,
        created_by: row.createdBy,
        created: row.createdAt,
      }))
    );
  });
}
