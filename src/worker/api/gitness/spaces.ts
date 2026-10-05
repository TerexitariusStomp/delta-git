// Gitness facade: identity + space endpoints.
//
// Mapping decisions:
//   - gitness "space"  = delta-git namespace. Ours are flat (no nesting), so a
//     space_ref is exactly the namespace slug and `spaces/{ref}/spaces` is
//     always empty.
//   - We have no password login: `POST /login` only succeeds when an OIDC or
//     DID session is already live — the SPA sign-in form will fail closed and
//     direct users to /auth (documented in docs/gitness-facade.md).
//   - `GET /user` maps the active session viewer to `TypesUser`; a missing
//     session returns 401, which is what triggers the SPA's sign-in redirect.
//   - Principal search is empty: delta-git has no cross-user lookup surface.

import type { AppRouter } from "@/worker/routes/hono";
import { loadViewer, endSession } from "@/worker/auth/session";
import { clearSessionCookie, clearDidSessionCookie } from "@/worker/auth/cookies";
import { findNamespaceBySlug, listNamespacesForUser } from "@/worker/db/d1/dal/namespaces";
import { listRepositoriesForNamespace } from "@/worker/db/d1/dal/repositories";
import type { NamespaceRow } from "@/worker/db/d1/schema/namespaces";
import type { RepositoryRow } from "@/worker/db/d1/schema/repositories";
import { isValidOwnerRepo } from "@/shared/web";
import {
  gErr,
  gNotFound,
  gStub,
  numericId,
  pageParams,
  paginate,
  setPageHeaders,
  toGitnessUser,
} from "./shared";
import type { GitnessContext } from "./shared";
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

  // Account creation flows through /auth (OIDC) — the SPA register form is a
  // dead end by design; the reskin will point it at our sign-in.
  router.post("/api/v1/register", async (c) => gStub(c, "password registration"));

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

  // SSH keys are not part of our auth model (PAT over HTTPS + DID only).
  router.get("/api/v1/user/keys", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    return c.json([]);
  });

  // --- principals -----------------------------------------------------------

  router.get("/api/v1/principals", async (c) => c.json([]));
  router.get("/api/v1/principals/scoped", async (c) => c.json([]));
  router.get("/api/v1/usergroups/scoped", async (c) => c.json([]));

  // --- spaces ---------------------------------------------------------------

  // Root space listing = the public namespace directory. Gitness uses
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
    return c.json(paginate(filtered, page).map((r) => toGitnessRepo(r, ns.slug)));
  });

  router.get("/api/v1/spaces/:space_ref{.+}/members", async (c) => {
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    // We only record the creating user; membership rows map to principals.
    return c.json([
      {
        role: "space_owner",
        principal: {
          id: numericId(ns.createdBy),
          uid: ns.slug,
          display_name: ns.slug,
          email: "",
          type: "user",
        },
        created: ns.createdAt,
        updated: ns.createdAt,
      },
    ]);
  });

  // Space-scoped surfaces we do not model: labels, rules, usergroups, checks.
  for (const tail of ["labels", "rules", "rules/:rule_id", "usergroups", "checks/recent"]) {
    router.get(`/api/v1/spaces/:space_ref{.+}/${tail}`, async (c) =>
      c.json(tail === "rules/:rule_id" ? {} : [])
    );
  }

  // Bare space GET is registered last: `:space_ref{.+}` is greedy and would
  // otherwise swallow every `/spaces/{ref}/<tail>` route above.
  router.get("/api/v1/spaces/:space_ref{.+}", async (c) => {
    const ns = await resolveSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    return c.json(toGitnessSpace(ns));
  });

  // Space mutation is not exposed through the facade (namespaces are minted
  // at sign-in; there is no space CRUD).
  router.post("/api/v1/spaces", async (c) => gStub(c, "space creation"));
  router.patch("/api/v1/spaces/:space_ref{.+}", async (c) => gStub(c, "space update"));
  router.delete("/api/v1/spaces/:space_ref{.+}", async (c) => gStub(c, "space delete"));
  router.post("/api/v1/spaces/:space_ref{.+}/members", async (c) => gStub(c, "membership"));
  router.patch("/api/v1/spaces/:space_ref{.+}/members/:user_uid", async (c) =>
    gStub(c, "membership")
  );
  router.delete("/api/v1/spaces/:space_ref{.+}/members/:user_uid", async (c) =>
    gStub(c, "membership")
  );
  router.post("/api/v1/spaces/import", async (c) => gStub(c, "space import"));
}
