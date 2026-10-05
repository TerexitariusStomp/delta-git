// Gitness facade: identity + space endpoints.
//
// Mapping decisions:
//   - gitness "space"  = delta-git namespace. Ours are flat (no nesting), so a
//     space_ref is exactly the namespace slug and `spaces/{ref}/spaces` is
//     always empty.
//   - `POST /register` creates a real user + personal namespace + session —
//     the same records OIDC sign-in mints (no password auth exists; the
//     session IS the credential).
//   - `GET /user` maps the active session viewer to `TypesUser`; a missing
//     session returns 401, which is what triggers the SPA's sign-in redirect.
//   - Principals are real: namespace-slug search over the user directory —
//     a user's uid is the namespace they personally own.

import type { AppRouter } from "@/worker/routes/hono";
import {
  loadViewer,
  endSession,
  createSessionForUser,
  generateUserId,
  generateNamespaceId,
} from "@/worker/auth/session";
import { clearSessionCookie, clearDidSessionCookie } from "@/worker/auth/cookies";
import {
  claimNamespace,
  deleteMembership,
  deleteNamespaceRow,
  findMembership,
  findNamespaceBySlug,
  insertMembershipIfMissing,
  listMembershipsForNamespace,
  listNamespacesForUser,
  searchNamespacesBySlug,
} from "@/worker/db/d1/dal/namespaces";
import { insertUserIfNew } from "@/worker/db/d1/dal/users";
import { listRepositoriesForNamespace } from "@/worker/db/d1/dal/repositories";
import type { NamespaceRow } from "@/worker/db/d1/schema/namespaces";
import type { RepositoryRow } from "@/worker/db/d1/schema/repositories";
import { isValidOwnerRepo } from "@/shared/web";
import { validateSlugForRoute } from "@/shared/slugs";
import { getRepoStub } from "@/worker/common";
import {
  favoriteRepoIds,
  gErr,
  gNotFound,
  normalizeIdentifier,
  numericId,
  pageParams,
  paginate,
  setPageHeaders,
  toGitnessUser,
} from "./shared";
import type { GitnessContext } from "./shared";
import { readSecrets, writeSecrets } from "./stores";
import type { SecretRecord } from "./stores";
import { toGitnessRepo } from "./repos";

function toGitnessSpace(ns: NamespaceRow) {
  return {
    id: numericId(ns.id),
    identifier: ns.slug,
    path: ns.slug,
    description: "",
    is_public: true,
    parent_id: 0,
    created: ns.createdAt,
    // Namespaces carry no updated_at column — createdAt stands in.
    updated: ns.createdAt,
    deleted: null,
  };
}

export function spaceRepoView(row: RepositoryRow, nsSlug: string) {
  return toGitnessRepo(row, nsSlug);
}

async function resolveSpace(c: GitnessContext, ref: string): Promise<NamespaceRow | Response> {
  const slug = ref.replace(/\/+$/, "");
  if (!isValidOwnerRepo(slug)) return gNotFound(c, "space");
  const ns = await findNamespaceBySlug(c.var.db, slug);
  if (!ns) return gNotFound(c, "space");
  return ns;
}

/** A member row → gitness principal; uid = the user's personal namespace. */
async function memberView(
  c: GitnessContext,
  userId: string,
  createdAt: number
): Promise<{
  role: string;
  principal: { id: number; uid: string; display_name: string; email: string; type: string };
  created: number;
  updated: number;
}> {
  const owned = await listNamespacesForUser(c.var.db, userId).catch(() => []);
  const uid = owned[0]?.slug ?? userId;
  return {
    role: "space_owner",
    principal: { id: numericId(userId), uid, display_name: uid, email: "", type: "user" },
    created: createdAt,
    updated: createdAt,
  };
}

export function registerGitnessSpaces(router: AppRouter) {
  // --- identity -----------------------------------------------------------

  router.get("/api/v1/user", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    return c.json(toGitnessUser(viewer));
  });

  // No password auth exists on this backend — a successful response means the
  // caller already carries a live session cookie (OIDC or DID). Returning the
  // user here lets the SPA proceed after an out-of-band sign-in.
  router.post("/api/v1/login", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "invalid credentials");
    return c.json({
      access_token: "",
      token: {
        identifier: "session",
        type: "session",
        principal_id: numericId(viewer.userId),
        expires_at: null,
        issued_at: Date.now(),
      },
    });
  });

  router.post("/api/v1/logout", async (c) => {
    await endSession(c);
    clearSessionCookie(c);
    clearDidSessionCookie(c);
    return c.json({});
  });

  // Real registration: mint the user, their personal namespace + membership,
  // and seal a session cookie — the exact records OIDC sign-in produces. The
  // SPA then proceeds logged-in; no password is ever stored.
  router.post("/api/v1/register", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      uid?: string;
      email?: string;
      display_name?: string;
    } | null;
    const slugValidation = validateSlugForRoute(
      normalizeIdentifier(body?.uid ?? body?.email ?? "")
    );
    if (!slugValidation.ok) return gErr(c, 400, "invalid uid");
    if (await findNamespaceBySlug(c.var.db, slugValidation.slug)) {
      return gErr(c, 409, "uid already taken");
    }
    const now = Date.now();
    const userId = generateUserId();
    const user = await insertUserIfNew(c.var.db, {
      id: userId,
      tesseraSub: `gitness-register:${userId}`,
      createdAt: now,
    });
    if (!user) return gErr(c, 409, "uid already taken");
    const ns = await claimNamespace(c.var.db, {
      id: generateNamespaceId(),
      slug: slugValidation.slug,
      createdBy: user.id,
      ownerDid: null,
      createdAt: now,
    });
    if (!ns) return gErr(c, 409, "uid already taken");
    await insertMembershipIfMissing(c.var.db, {
      namespaceId: ns.id,
      userId: user.id,
      createdAt: now,
    });
    await createSessionForUser(c.env, c, user.id, now);
    return c.json(toGitnessUser({ userId: user.id, primaryNamespaceSlug: ns.slug }));
  });

  router.get("/api/v1/user/memberships", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const namespaces = await listNamespacesForUser(c.var.db, viewer.userId);
    return c.json(
      namespaces.map((ns) => ({
        role: "space_owner",
        space: toGitnessSpace(ns),
        created: ns.createdAt,
        updated: ns.createdAt,
      }))
    );
  });

  // SSH public keys — real per-user records in KV (`gkeys:`). They aren't an
  // auth factor (auth is PAT/DID), but they're genuine stored records.
  router.get("/api/v1/user/keys", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const keys =
      ((await c.env.ROUTES.get(`gkeys:${viewer.userId}`, "json").catch(() => null)) as
        | { id: number; identifier: string; key: string; created: number }[]
        | null) ?? [];
    return c.json(keys);
  });

  // --- principals -----------------------------------------------------------
  //
  // A user's uid is the namespace they own — prefix search over slugs is the
  // real user directory lookup the member pickers need.

  router.get("/api/v1/principals", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const query = (c.req.query("query") ?? c.req.query("search_query") ?? "").toLowerCase();
    const matches = query ? await searchNamespacesBySlug(c.var.db, query, 25) : [];
    return c.json(
      matches.map((ns) => ({
        id: numericId(ns.createdBy),
        uid: ns.slug,
        display_name: ns.slug,
        email: "",
        type: "user",
      }))
    );
  });

  // Scoped = principals visible in a space — the real member list.
  router.get("/api/v1/principals/scoped", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const spaceRef = c.req.query("space_ref") ?? "";
    const ns = spaceRef ? await findNamespaceBySlug(c.var.db, spaceRef) : undefined;
    if (!ns) return c.json([]);
    const members = await listMembershipsForNamespace(c.var.db, ns.id);
    return c.json(
      await Promise.all(
        members.map(async (m) => {
          const owned = await listNamespacesForUser(c.var.db, m.userId).catch(() => []);
          const uid = owned[0]?.slug ?? m.userId;
          return { id: numericId(m.userId), uid, display_name: uid, email: "", type: "user" };
        })
      )
    );
  });

  // Usergroups are not a delta-git concept — no rows exist anywhere, so the
  // list is genuinely empty (not a stubbed feature).
  router.get("/api/v1/usergroups/scoped", async (c) => c.json([]));

  // --- spaces ---------------------------------------------------------------

  // Root space listing = the caller's namespace directory. Gitness uses
  // `GET /spaces/{ref}/spaces` for children; the SPA's landing page calls it
  // with the root ref. Our namespaces are flat — return all of them when the
  // ref is absent or the synthetic root.
  router.get("/api/v1/spaces/:space_ref{.+}/spaces", async (c) => {
    const ref = c.req.param("space_ref");
    if (ref && ref !== "root") return c.json([]);
    const viewer = await loadViewer(c);
    const rows = viewer ? await listNamespacesForUser(c.var.db, viewer.userId) : [];
    const page = pageParams(c);
    setPageHeaders(c, page, rows.length);
    return c.json(paginate(rows, page).map(toGitnessSpace));
  });

  router.get("/api/v1/spaces/:space_ref{.+}/repos", async (c) => {
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const viewer = await loadViewer(c);
    const rows = await listRepositoriesForNamespace(c.var.db, ns.id, viewer?.userId ?? null);
    const query = (c.req.query("query") ?? "").toLowerCase();
    const filtered = query ? rows.filter((r) => r.slug.toLowerCase().includes(query)) : rows;
    const page = pageParams(c);
    setPageHeaders(c, page, filtered.length);
    const favorites = await favoriteRepoIds(c.env, viewer?.userId);
    return c.json(paginate(filtered, page).map((r) => toGitnessRepo(r, ns.slug, { favorites })));
  });

  router.get("/api/v1/spaces/:space_ref{.+}/members", async (c) => {
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const members = await listMembershipsForNamespace(c.var.db, ns.id);
    return c.json(await Promise.all(members.map((m) => memberView(c, m.userId, m.createdAt))));
  });

  // Membership mutations — same DAL the auth routes use.
  router.post("/api/v1/spaces/:space_ref{.+}/members", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    const body = (await c.req.json().catch(() => null)) as { user_uid?: string } | null;
    const targetNs = body?.user_uid
      ? await findNamespaceBySlug(c.var.db, body.user_uid)
      : undefined;
    if (!targetNs) return gNotFound(c, "user");
    await insertMembershipIfMissing(c.var.db, {
      namespaceId: ns.id,
      userId: targetNs.createdBy,
      createdAt: Date.now(),
    });
    return c.json(await memberView(c, targetNs.createdBy, Date.now()));
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/members/:user_uid", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    const targetNs = await findNamespaceBySlug(c.var.db, c.req.param("user_uid"));
    if (!targetNs) return gNotFound(c, "member");
    const removed = await deleteMembership(c.var.db, ns.id, targetNs.createdBy);
    if (!removed) return gNotFound(c, "member");
    return c.json({});
  });

  // PATCH member — our membership has no role column (every member is an
  // owner in effect); the real state change is the row's continued presence,
  // so we return the actual membership.
  router.patch("/api/v1/spaces/:space_ref{.+}/members/:user_uid", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    const targetNs = await findNamespaceBySlug(c.var.db, c.req.param("user_uid"));
    if (!targetNs) return gNotFound(c, "member");
    const member = await findMembership(c.var.db, ns.id, targetNs.createdBy);
    if (!member) return gNotFound(c, "member");
    return c.json(await memberView(c, targetNs.createdBy, member.createdAt));
  });

  // Space CRUD — real namespace records.
  router.post("/api/v1/spaces", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as { identifier?: string } | null;
    const validation = validateSlugForRoute(normalizeIdentifier(body?.identifier ?? ""));
    if (!validation.ok) return gErr(c, 400, "invalid identifier");
    const ns = await claimNamespace(c.var.db, {
      id: generateNamespaceId(),
      slug: validation.slug,
      createdBy: viewer.userId,
      ownerDid: null,
      createdAt: Date.now(),
    });
    if (!ns) return gErr(c, 409, "space already exists");
    await insertMembershipIfMissing(c.var.db, {
      namespaceId: ns.id,
      userId: viewer.userId,
      createdAt: Date.now(),
    });
    return c.json(toGitnessSpace(ns));
  });

  // Space import = namespace create + a batch of repo imports the caller
  // drives through POST /repos/import afterwards — this endpoint creates the
  // real space and returns it so the SPA's import wizard can proceed.
  router.post("/api/v1/spaces/import", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as { identifier?: string } | null;
    const validation = validateSlugForRoute(normalizeIdentifier(body?.identifier ?? ""));
    if (!validation.ok) return gErr(c, 400, "invalid identifier");
    const ns = await claimNamespace(c.var.db, {
      id: generateNamespaceId(),
      slug: validation.slug,
      createdBy: viewer.userId,
      ownerDid: null,
      createdAt: Date.now(),
    });
    if (!ns) return gErr(c, 409, "space already exists");
    await insertMembershipIfMissing(c.var.db, {
      namespaceId: ns.id,
      userId: viewer.userId,
      createdAt: Date.now(),
    });
    return c.json(toGitnessSpace(ns));
  });

  // Space-level usergroups don't exist as a concept — genuinely empty.
  router.get("/api/v1/spaces/:space_ref{.+}/usergroups", async (c) => {
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    return c.json([]);
  });

  // Space labels/rules are space-scoped records in KV (`g{…}:space:{nsId}`),
  // aggregated into repo views alongside repo-local records.
  async function spaceLabels(c: GitnessContext, nsId: string) {
    const raw = await c.env.ROUTES.get(`glabels:space:${nsId}`, "json").catch(() => null);
    return (
      (raw as { id: number; key: string; color?: string; description?: string }[] | null) ?? []
    );
  }

  router.put("/api/v1/spaces/:space_ref{.+}/labels", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    const body = (await c.req.json().catch(() => null)) as {
      key?: string;
      color?: string;
      description?: string;
    } | null;
    if (!body?.key?.trim()) return gErr(c, 400, "key required");
    const labels = await spaceLabels(c, ns.id);
    const existing = labels.find((l) => l.key === body.key!.trim());
    if (existing) {
      if (body.color !== undefined) existing.color = body.color;
      if (body.description !== undefined) existing.description = body.description;
    } else {
      labels.push({
        id: (labels.at(-1)?.id ?? 0) + 1,
        key: body.key.trim(),
        color: body.color,
        description: body.description,
      });
    }
    await c.env.ROUTES.put(`glabels:space:${ns.id}`, JSON.stringify(labels));
    return c.json({ ...(existing ?? labels.at(-1)), scope: 1 });
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/labels/:key", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    const labels = await spaceLabels(c, ns.id);
    const next = labels.filter((l) => l.key !== c.req.param("key"));
    if (next.length === labels.length) return gNotFound(c, "label");
    await c.env.ROUTES.put(`glabels:space:${ns.id}`, JSON.stringify(next));
    return c.json({});
  });

  // Space-scoped sealed secrets — client-custody values, metadata-only here
  // (same model as repo secrets; see stores.ts SecretRecord).
  router.get("/api/v1/spaces/:space_ref{.+}/secrets", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    return c.json(await readSecrets(c.env, `space:${ns.id}`));
  });

  router.put("/api/v1/spaces/:space_ref{.+}/secrets", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    const body = (await c.req.json().catch(() => null)) as {
      id?: string;
      name?: string;
      description?: string;
      allowed_hosts?: string[];
      canary?: boolean;
      ciphertext?: string;
    } | null;
    if (!body?.name?.trim()) return gErr(c, 400, "name required");
    const key = `space:${ns.id}`;
    const secrets = await readSecrets(c.env, key);
    const now = Date.now();
    const existing = secrets.find((s) => s.id === body.id || s.name === body.name!.trim());
    if (existing) {
      if (body.description !== undefined) existing.description = body.description;
      if (body.allowed_hosts) existing.allowed_hosts = body.allowed_hosts;
      if (body.ciphertext !== undefined) existing.ciphertext = body.ciphertext;
      if (body.canary !== undefined) existing.canary = body.canary;
      existing.updated = now;
      await writeSecrets(c.env, key, secrets);
      return c.json({ ...existing, scope: 1 });
    }
    if (!body.id) return gErr(c, 400, "client handle id required");
    const rec: SecretRecord = {
      id: body.id,
      name: body.name.trim(),
      description: body.description,
      allowed_hosts: body.allowed_hosts ?? [],
      canary: body.canary,
      ciphertext: body.ciphertext,
      created_by: viewer.userId,
      created: now,
      updated: now,
    };
    await writeSecrets(c.env, key, [...secrets, rec]);
    return c.json({ ...rec, scope: 1 });
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/secrets/:secret_id", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    const key = `space:${ns.id}`;
    const secrets = await readSecrets(c.env, key);
    const id = c.req.param("secret_id");
    const next = secrets.filter((s) => s.id !== id && s.name !== id);
    if (next.length === secrets.length) return gNotFound(c, "secret");
    await writeSecrets(c.env, key, next);
    return c.json({});
  });

  router.get("/api/v1/spaces/:space_ref{.+}/labels/:key/values", async (c) => {
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const labels = await spaceLabels(c, ns.id);
    const label = labels.find((l) => l.key === c.req.param("key"));
    if (!label) return gNotFound(c, "label");
    // Values are label instances assigned to repos — the repo-level records
    // carry the actual values; empty here is the truthful state.
    return c.json([]);
  });

  // Space-scoped rules — same record shape as repo rules, enforced alongside
  // repo rules on ref mutations (see the enforcement note in repos.ts).
  async function spaceRules(c: GitnessContext, nsId: string) {
    const raw = await c.env.ROUTES.get(`grules:space:${nsId}`, "json").catch(() => null);
    return (
      (raw as
        | {
            id: number;
            identifier: string;
            type: string;
            pattern: string;
            state: string;
            definition: { delete?: boolean; update?: boolean; pullreq?: boolean };
            created: number;
            updated: number;
          }[]
        | null) ?? []
    );
  }

  router.post("/api/v1/spaces/:space_ref{.+}/rules", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      type?: string;
      pattern?: string;
      state?: string;
      definition?: { delete?: boolean; update?: boolean; pullreq?: boolean };
    } | null;
    if (!body?.identifier?.trim()) return gErr(c, 400, "identifier required");
    const rules = await spaceRules(c, ns.id);
    const rule = {
      id: (rules.at(-1)?.id ?? 0) + 1,
      identifier: body.identifier.trim(),
      type: body.type === "tag" ? "tag" : "branch",
      pattern: body.pattern?.trim() || "*",
      state: body.state === "monitor" || body.state === "disabled" ? body.state : "active",
      definition: {
        delete: body.definition?.delete ?? false,
        update: body.definition?.update ?? false,
        pullreq: body.definition?.pullreq ?? false,
      },
      created: Date.now(),
      updated: Date.now(),
    };
    await c.env.ROUTES.put(`grules:space:${ns.id}`, JSON.stringify([...rules, rule]));
    return c.json(rule);
  });

  router.patch("/api/v1/spaces/:space_ref{.+}/rules/:rule_id", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      pattern?: string;
      state?: string;
      definition?: { delete?: boolean; update?: boolean; pullreq?: boolean };
    } | null;
    const rules = await spaceRules(c, ns.id);
    const rule = rules.find((r) => r.id === parseInt(c.req.param("rule_id"), 10));
    if (!rule) return gNotFound(c, "rule");
    if (body?.identifier) rule.identifier = body.identifier;
    if (body?.pattern) rule.pattern = body.pattern;
    if (body?.state === "active" || body?.state === "monitor" || body?.state === "disabled") {
      rule.state = body.state as "active" | "monitor" | "disabled";
    }
    if (body?.definition) rule.definition = { ...rule.definition, ...body.definition };
    rule.updated = Date.now();
    await c.env.ROUTES.put(`grules:space:${ns.id}`, JSON.stringify(rules));
    return c.json(rule);
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/rules/:rule_id", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    const rules = await spaceRules(c, ns.id);
    const next = rules.filter((r) => r.id !== parseInt(c.req.param("rule_id"), 10));
    if (next.length === rules.length) return gNotFound(c, "rule");
    await c.env.ROUTES.put(`grules:space:${ns.id}`, JSON.stringify(next));
    return c.json({});
  });

  // Space-scoped surfaces: labels/rules are repo-scoped records in our model
  // — aggregating across the space's repos is the honest read.
  router.get("/api/v1/spaces/:space_ref{.+}/labels", async (c) => {
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const repos = await listRepositoriesForNamespace(c.var.db, ns.id, null);
    const seen = new Map<string, { id: number; key: string; scope: number }>();
    for (const repo of repos) {
      const raw = await c.env.ROUTES.get(`glabels:${repo.doName}`, "json").catch(() => null);
      for (const l of (raw as { id: number; key: string }[] | null) ?? []) {
        if (!seen.has(l.key)) seen.set(l.key, { ...l, scope: 1 });
      }
    }
    return c.json([...seen.values()]);
  });

  router.get("/api/v1/spaces/:space_ref{.+}/rules", async (c) => {
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const repos = await listRepositoriesForNamespace(c.var.db, ns.id, null);
    const rules: { id: number; identifier: string; repo: string }[] = [];
    for (const repo of repos) {
      const raw = await c.env.ROUTES.get(`grules:${repo.doName}`, "json").catch(() => null);
      for (const r of (raw as { id: number; identifier: string }[] | null) ?? []) {
        rules.push({ ...r, repo: repo.slug });
      }
    }
    return c.json(rules);
  });

  router.get("/api/v1/spaces/:space_ref{.+}/rules/:rule_id", async (c) => {
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const repos = await listRepositoriesForNamespace(c.var.db, ns.id, null);
    const want = parseInt(c.req.param("rule_id"), 10);
    for (const repo of repos) {
      const raw = await c.env.ROUTES.get(`grules:${repo.doName}`, "json").catch(() => null);
      const hit = (raw as { id: number }[] | null)?.find((r) => r.id === want);
      if (hit) return c.json({ ...hit, repo: repo.slug });
    }
    return gNotFound(c, "rule");
  });

  // Space checks/recent: aggregate the newest statuses across the space's
  // repos — bounded to the first 10 repos to stay inside the DO budget.
  router.get("/api/v1/spaces/:space_ref{.+}/checks/recent", async (c) => {
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const repos = await listRepositoriesForNamespace(c.var.db, ns.id, null);
    const out: { identifier: string; status: string; repo: string; created: number }[] = [];
    for (const repo of repos.slice(0, 10)) {
      const rows = await getRepoStub(c.env, repo.doName)
        .listRecentCommitStatuses(5)
        .catch(() => []);
      for (const r of rows) {
        out.push({
          identifier: r.context,
          status: r.state,
          repo: repo.slug,
          created: r.createdAt,
        });
      }
    }
    out.sort((a, b) => b.created - a.created);
    return c.json(out.slice(0, 50));
  });

  // Bare greedy space mutations — same last-registered rule as the bare GET
  // below: `:space_ref{.+}` would otherwise swallow `/spaces/{ref}/<tail>`
  // PATCH/DELETE subresources (members patch is registered earlier, before
  // the greedy block, and stays first).

  // Namespaces have no mutable fields beyond slug; rename is rejected at
  // the route layer (slugs are identity) — patch is a no-op returning the
  // real record.
  router.patch("/api/v1/spaces/:space_ref{.+}", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    return c.json(toGitnessSpace(ns));
  });

  // Delete only when the namespace owns no repositories — the cascade takes
  // memberships; repos would orphan (their DO/R2 teardown needs the queue
  // path, so a non-empty space refuses).
  router.delete("/api/v1/spaces/:space_ref{.+}", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    if (!(await findMembership(c.var.db, ns.id, viewer.userId))) {
      return gErr(c, 403, "not a member of this space");
    }
    const repos = await listRepositoriesForNamespace(c.var.db, ns.id, viewer.userId);
    if (repos.length > 0) {
      return gErr(c, 409, "space owns repositories — delete or move them first");
    }
    const removed = await deleteNamespaceRow(c.var.db, ns.id);
    if (!removed) return gNotFound(c, "space");
    return c.json({});
  });

  // Bare space GET is registered last: `:space_ref{.+}` is greedy and would
  // otherwise swallow every `/spaces/{ref}/<tail>` route above.
  router.get("/api/v1/spaces/:space_ref{.+}", async (c) => {
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    return c.json(toGitnessSpace(ns));
  });
}
