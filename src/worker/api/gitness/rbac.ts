// RBAC surfaces behind the gitness `/api/v1` facade — user groups, service
// accounts, resource groups, and the roles they bind to. Enforcement is
// casbin-backed: every membership/group/service-account row synthesizes g
// rules in `policyForNamespace`, and admin mutations require the caller to
// hold an owner (admin) role in the space.
//
// Route conventions match the existing space-scoped CRUD modules; the
// vendored admin pages call these paths.

import type { AppRouter } from "@/worker/routes/hono";
import { loadViewer } from "@/worker/auth/session";
import { findNamespaceBySlug } from "@/worker/db/d1/dal/namespaces";
import {
  deleteResourceGroup,
  deleteResourceGroupItem,
  deleteServiceAccount,
  deleteUserGroup,
  deleteUserGroupMember,
  findResourceGroup,
  findServiceAccount,
  findServiceAccountById,
  findUserGroup,
  insertResourceGroup,
  insertResourceGroupItem,
  insertServiceAccount,
  insertUserGroup,
  insertUserGroupMember,
  listCasbinRules,
  listResourceGroupItems,
  listResourceGroups,
  listServiceAccounts,
  listUserGroupMembers,
  listUserGroups,
  updateServiceAccount,
} from "@/worker/db/d1/dal/rbac";
import { updateMembershipRole, findMembership } from "@/worker/db/d1/dal/namespaces";
import { insertUserIfNew, findUserById } from "@/worker/db/d1/dal/users";
import { insertPatWithGrants } from "@/worker/db/d1/dal/tokens";
import { generatePatPlaintext, hashPatPlaintext } from "@/worker/auth/pat";
import { newPrefixedId } from "@/worker/common";
import { enforceInNamespace, principalForUser, VALID_ROLES, ROLE_ACTIONS } from "@/worker/rbac";
import { gErr, gNotFound, numericId, type GitnessContext } from "./shared";

/** Resolve the space + require the caller holds an owner role in it. */
async function requireSpaceAdmin(
  c: GitnessContext,
  ref: string
): Promise<{ nsId: string; viewerId: string } | Response> {
  const viewer = await loadViewer(c);
  if (!viewer) return gErr(c, 401, "unauthorized");
  const slug = ref.replace(/\/+$/, "");
  const ns = await findNamespaceBySlug(c.var.db, slug);
  if (!ns) return gNotFound(c, "space");
  const allowed = await enforceInNamespace(
    c.var.db,
    ns.id,
    principalForUser(viewer.userId),
    `space:${ns.id}`,
    "admin"
  );
  if (!allowed) return gErr(c, 403, "space admin role required");
  return { nsId: ns.id, viewerId: viewer.userId };
}

/** Read-level gate — any member (any role) may list RBAC objects. */
async function requireSpaceMember(
  c: GitnessContext,
  ref: string
): Promise<{ nsId: string } | Response> {
  const viewer = await loadViewer(c);
  if (!viewer) return gErr(c, 401, "unauthorized");
  const slug = ref.replace(/\/+$/, "");
  const ns = await findNamespaceBySlug(c.var.db, slug);
  if (!ns) return gNotFound(c, "space");
  const member = await findMembership(c.var.db, ns.id, viewer.userId);
  if (!member) {
    // Group-derived membership also counts (viewerIsNamespaceMember
    // expands groups the same way).
    const { viewerIsNamespaceMember } = await import("@/worker/auth/pat");
    if (!(await viewerIsNamespaceMember(c.var.db, viewer.userId, ns.id))) {
      return gErr(c, 403, "not a member of this space");
    }
  }
  return { nsId: ns.id };
}

function validRole(role: unknown): role is string {
  return typeof role === "string" && VALID_ROLES.includes(role);
}

export function registerGitnessRbac(router: AppRouter) {
  // --- user groups -----------------------------------------------------------

  router.get("/api/v1/spaces/:space_ref{.+}/usergroups", async (c) => {
    const ctx = await requireSpaceMember(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const groups = await listUserGroups(c.var.db, ctx.nsId);
    return c.json(
      await Promise.all(
        groups.map(async (g) => ({
          id: numericId(g.id),
          identifier: g.identifier,
          description: g.description,
          role: g.role,
          users: (await listUserGroupMembers(c.var.db, g.id)).length,
          created: g.createdAt,
        }))
      )
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/usergroups", async (c) => {
    const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      description?: string;
      role?: string;
    } | null;
    const identifier = body?.identifier?.trim();
    if (!identifier || !/^[\w.-]{1,64}$/.test(identifier)) {
      return gErr(c, 400, "invalid identifier");
    }
    if (body?.role && !validRole(body.role)) {
      return gErr(c, 400, `role must be one of ${VALID_ROLES.join("/")}`);
    }
    if (await findUserGroup(c.var.db, ctx.nsId, identifier)) {
      return gErr(c, 409, "identifier in use");
    }
    const group = await insertUserGroup(c.var.db, {
      id: newPrefixedId("ug"),
      namespaceId: ctx.nsId,
      identifier,
      description: body?.description ?? "",
      role: body?.role ?? "viewer",
    });
    return c.json({ id: numericId(group.id), identifier, role: group.role }, 201);
  });

  router.post("/api/v1/spaces/:space_ref{.+}/usergroups/:gid/members", async (c) => {
    const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const group = await findUserGroup(c.var.db, ctx.nsId, c.req.param("gid"));
    if (!group) return gNotFound(c, "user group");
    const body = (await c.req.json().catch(() => null)) as { user_uid?: string } | null;
    // user_uid is the member's personal namespace slug — same convention as
    // space member add.
    const targetNs = body?.user_uid
      ? await findNamespaceBySlug(c.var.db, body.user_uid)
      : undefined;
    if (!targetNs) return gNotFound(c, "user");
    await insertUserGroupMember(c.var.db, group.id, targetNs.createdBy);
    return c.json({}, 201);
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/usergroups/:gid/members/:uid", async (c) => {
    const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const group = await findUserGroup(c.var.db, ctx.nsId, c.req.param("gid"));
    if (!group) return gNotFound(c, "user group");
    const targetNs = await findNamespaceBySlug(c.var.db, c.req.param("uid"));
    if (!targetNs) return gNotFound(c, "user");
    const removed = await deleteUserGroupMember(c.var.db, group.id, targetNs.createdBy);
    if (!removed) return gNotFound(c, "group member");
    return c.json({});
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/usergroups/:gid", async (c) => {
    const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const group = await findUserGroup(c.var.db, ctx.nsId, c.req.param("gid"));
    if (!group) return gNotFound(c, "user group");
    await deleteUserGroup(c.var.db, group.id);
    return c.json({});
  });

  // --- service accounts --------------------------------------------------------
  //
  // A service account is a named non-user principal. PATs minted for it carry
  // a synthetic `users` row (tessera_sub = svc:{id}) so the existing PAT auth
  // path works unchanged; RBAC g-rows bind the svc: principal to its role.

  router.get("/api/v1/spaces/:space_ref{.+}/serviceaccounts", async (c) => {
    const ctx = await requireSpaceMember(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const rows = await listServiceAccounts(c.var.db, ctx.nsId);
    return c.json(
      rows.map((sa) => ({
        id: numericId(sa.id),
        uid: sa.id,
        identifier: sa.identifier,
        description: sa.description,
        role: sa.role,
        active: sa.active === 1,
        created: sa.createdAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/serviceaccounts", async (c) => {
    const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      description?: string;
      role?: string;
    } | null;
    const identifier = body?.identifier?.trim();
    if (!identifier || !/^[\w.-]{1,64}$/.test(identifier)) {
      return gErr(c, 400, "invalid identifier");
    }
    if (body?.role && !validRole(body.role)) {
      return gErr(c, 400, `role must be one of ${VALID_ROLES.join("/")}`);
    }
    if (await findServiceAccount(c.var.db, ctx.nsId, identifier)) {
      return gErr(c, 409, "identifier in use");
    }
    const sa = await insertServiceAccount(c.var.db, {
      id: newPrefixedId("sa"),
      namespaceId: ctx.nsId,
      identifier,
      description: body?.description ?? "",
      role: body?.role ?? "developer",
      active: 1,
    });
    return c.json({ id: numericId(sa.id), identifier, role: sa.role }, 201);
  });

  router.patch("/api/v1/spaces/:space_ref{.+}/serviceaccounts/:said", async (c) => {
    const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const sa = await findServiceAccountById(c.var.db, c.req.param("said"));
    if (!sa || sa.namespaceId !== ctx.nsId) return gNotFound(c, "service account");
    const body = (await c.req.json().catch(() => null)) as {
      role?: string;
      active?: boolean;
      description?: string;
    } | null;
    if (body?.role && !validRole(body.role)) {
      return gErr(c, 400, `role must be one of ${VALID_ROLES.join("/")}`);
    }
    await updateServiceAccount(c.var.db, sa.id, {
      ...(body?.role ? { role: body.role } : {}),
      ...(body?.active !== undefined ? { active: body.active ? 1 : 0 } : {}),
      ...(body?.description !== undefined ? { description: body.description } : {}),
    });
    return c.json({});
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/serviceaccounts/:said", async (c) => {
    const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const sa = await findServiceAccountById(c.var.db, c.req.param("said"));
    if (!sa || sa.namespaceId !== ctx.nsId) return gNotFound(c, "service account");
    await deleteServiceAccount(c.var.db, sa.id);
    return c.json({});
  });

  // Mint a namespace-scoped PAT bound to the service-account principal. The
  // plaintext is returned once and never stored.
  router.post("/api/v1/spaces/:space_ref{.+}/serviceaccounts/:said/token", async (c) => {
    const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const sa = await findServiceAccountById(c.var.db, c.req.param("said"));
    if (!sa || sa.namespaceId !== ctx.nsId) return gNotFound(c, "service account");
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      expires_at?: number;
    } | null;
    // Synthetic user row backing the svc: principal — PAT userId FK needs a
    // users row; tessera_sub records that it isn't a real identity.
    const svcUserId = `svc:${sa.id}`;
    const user = await findUserById(c.var.db, svcUserId);
    if (!user) {
      await insertUserIfNew(c.var.db, {
        id: svcUserId,
        tesseraSub: `svc:${sa.id}`,
        createdAt: Date.now(),
      });
    }
    const generated = generatePatPlaintext();
    const hash = await hashPatPlaintext(generated.plaintext);
    const patId = newPrefixedId("pat");
    const level = sa.role === "viewer" ? "pull" : "push";
    await insertPatWithGrants(c.var.db, {
      pat: {
        id: patId,
        userId: svcUserId,
        name: body?.name?.trim() || `sa:${sa.identifier}`,
        prefix: generated.publicPrefix,
        hash,
        createdAt: Date.now(),
        expiresAt: body?.expires_at ?? null,
        revokedAt: null,
        lastUsedAt: null,
      },
      namespaceGrants: [{ patId, namespaceId: ctx.nsId, level }],
      repoGrants: [],
    });
    return c.json({ token: generated.plaintext, level }, 201);
  });

  // --- resource groups ---------------------------------------------------------

  router.get("/api/v1/spaces/:space_ref{.+}/resourcegroups", async (c) => {
    const ctx = await requireSpaceMember(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const groups = await listResourceGroups(c.var.db, ctx.nsId);
    return c.json(
      await Promise.all(
        groups.map(async (g) => ({
          id: numericId(g.id),
          identifier: g.identifier,
          description: g.description,
          items: (await listResourceGroupItems(c.var.db, g.id)).map((i) => ({
            type: i.resourceType,
            ref: i.resourceRef,
          })),
          created: g.createdAt,
        }))
      )
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/resourcegroups", async (c) => {
    const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      description?: string;
    } | null;
    const identifier = body?.identifier?.trim();
    if (!identifier || !/^[\w.-]{1,64}$/.test(identifier)) {
      return gErr(c, 400, "invalid identifier");
    }
    if (await findResourceGroup(c.var.db, ctx.nsId, identifier)) {
      return gErr(c, 409, "identifier in use");
    }
    const group = await insertResourceGroup(c.var.db, {
      id: newPrefixedId("rg"),
      namespaceId: ctx.nsId,
      identifier,
      description: body?.description ?? "",
    });
    return c.json({ id: numericId(group.id), identifier }, 201);
  });

  router.post("/api/v1/spaces/:space_ref{.+}/resourcegroups/:gid/resources", async (c) => {
    const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const group = await findResourceGroup(c.var.db, ctx.nsId, c.req.param("gid"));
    if (!group) return gNotFound(c, "resource group");
    const body = (await c.req.json().catch(() => null)) as {
      resource_type?: string;
      resource_ref?: string;
    } | null;
    if (body?.resource_type !== "repo" && body?.resource_type !== "space") {
      return gErr(c, 400, "resource_type must be repo|space");
    }
    if (!body?.resource_ref?.trim()) return gErr(c, 400, "resource_ref required");
    await insertResourceGroupItem(c.var.db, {
      groupId: group.id,
      resourceType: body.resource_type,
      resourceRef: body.resource_ref.trim(),
    });
    return c.json({}, 201);
  });

  router.delete(
    "/api/v1/spaces/:space_ref{.+}/resourcegroups/:gid/resources/:rtype/:rref{.+}",
    async (c) => {
      const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
      if (ctx instanceof Response) return ctx;
      const group = await findResourceGroup(c.var.db, ctx.nsId, c.req.param("gid"));
      if (!group) return gNotFound(c, "resource group");
      const removed = await deleteResourceGroupItem(c.var.db, {
        groupId: group.id,
        resourceType: c.req.param("rtype"),
        resourceRef: c.req.param("rref"),
      });
      if (!removed) return gNotFound(c, "resource item");
      return c.json({});
    }
  );

  router.delete("/api/v1/spaces/:space_ref{.+}/resourcegroups/:gid", async (c) => {
    const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const group = await findResourceGroup(c.var.db, ctx.nsId, c.req.param("gid"));
    if (!group) return gNotFound(c, "resource group");
    await deleteResourceGroup(c.var.db, group.id);
    return c.json({});
  });

  // --- roles -------------------------------------------------------------------
  //
  // Built-in roles + every custom policy row in this space. Custom p rows are
  // written via POST for policies the built-ins don't cover.

  router.get("/api/v1/spaces/:space_ref{.+}/roles", async (c) => {
    const ctx = await requireSpaceMember(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const custom = (await listCasbinRules(c.var.db)).filter(
      (r) => (r.ptype === "g" ? (r.v3 ?? r.v2) : r.v1) === ctx.nsId
    );
    return c.json({
      roles: Object.entries(ROLE_ACTIONS).map(([identifier, actions]) => ({
        identifier,
        actions,
        builtin: true,
      })),
      custom: custom.map((r) => ({
        ptype: r.ptype,
        v0: r.v0,
        v1: r.v1,
        v2: r.v2,
        v3: r.v3,
      })),
    });
  });

  // --- member role ---------------------------------------------------------------
  //
  // PATCH member now updates a real role column.

  router.patch("/api/v1/spaces/:space_ref{.+}/members/:user_uid/role", async (c) => {
    const ctx = await requireSpaceAdmin(c, c.req.param("space_ref"));
    if (ctx instanceof Response) return ctx;
    const body = (await c.req.json().catch(() => null)) as { role?: string } | null;
    if (!validRole(body?.role)) {
      return gErr(c, 400, `role must be one of ${VALID_ROLES.join("/")}`);
    }
    const targetNs = await findNamespaceBySlug(c.var.db, c.req.param("user_uid"));
    if (!targetNs) return gNotFound(c, "member");
    const updated = await updateMembershipRole(c.var.db, ctx.nsId, targetNs.createdBy, body!.role!);
    if (!updated) return gNotFound(c, "member");
    return c.json({});
  });
}
