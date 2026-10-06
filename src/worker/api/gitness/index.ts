// Gitness `/api/v1` facade — registration.
//
// Route-order contract: `:repo_ref{.+}` and `:space_ref{.+}` are greedy, so
// every bare `/{ref}` GET must register after all of its `/{ref}/<tail>`
// siblings. `registerGitnessRepos` owns the bare repo-detail GET and is
// therefore called last, after gitdata/pullreqs have claimed their tails.
// The trailing `all("/api/v1/*")` is a 404 for paths no route claimed —
// every endpoint the SPA calls is implemented.

import type { AppRouter } from "@/worker/routes/hono";
import { isRequestPrivate } from "@/worker/cache";
import { loadViewer, generateUserId, generateNamespaceId } from "@/worker/auth/session";
import { insertPatWithGrants, listPatsForUser, revokePatById } from "@/worker/db/d1/dal/tokens";
import { insertSecurityEvent, listSecurityEventsForUser } from "@/worker/db/d1/dal/securityEvents";
import { insertUserIfNew, deleteUserRow } from "@/worker/db/d1/dal/users";
import {
  claimNamespace,
  insertMembershipIfMissing,
  deleteNamespaceRow,
  findNamespaceBySlug,
  listMembershipsForNamespace,
  listNamespacesForUser,
} from "@/worker/db/d1/dal/namespaces";
import { listRepositoriesForNamespace } from "@/worker/db/d1/dal/repositories";
import type { GitnessContext } from "./shared";
import { validateSlugForRoute } from "@/shared/slugs";
import { generatePatPlaintext, hashPatPlaintext } from "@/worker/auth/pat";
import { newPrefixedId } from "@/worker/common";
import { numericId, gErr, gNotFound, normalizeIdentifier } from "./shared";
import { parseAuthorizedKey, sshFingerprint } from "@/worker/git/core/sshsig";
import { readUserFavorites, writeUserFavorites } from "./stores";
import { registerGitnessSpaceDetail, registerGitnessSpaces } from "./spaces";
import { registerGitnessGitdata } from "./gitdata";
import { registerGitnessPullreqs } from "./pullreqs";
import { registerGitnessDiscussions } from "./discussions";
import { registerGitnessIssues } from "./issues";
import { registerGitnessCodeowners } from "./codeowners";
import { registerGitnessSocial } from "./social";
import { registerGitnessInsights } from "./insights";
import { registerGitnessProjects } from "./projects";
import { registerGitnessCodeScan } from "./codescan";
import { registerGitnessModeration } from "./moderation";
import { registerGitnessDepGraph } from "./depgraph";
import { registerGitnessWorkflows } from "./workflows";
import { registerGitnessGists } from "./gists";
import { registerGitnessGhImport } from "./ghimport";
import { registerGitnessRepoDr } from "./dr";
import { registerGitnessReleases } from "./releases";
import { registerGitnessWiki } from "./wiki";
import { registerGitnessRepos } from "./repos";
import { registerGitnessSearch } from "./search";
import { registerGitnessExecutions } from "./executions";
import { registerGitnessRepoKeys } from "./repokeys";
import { registerGitnessKnowledge } from "./knowledge";
import { registerGitnessRbac } from "./rbac";
import { registerGitnessModules } from "./modules";
import { registerGitnessDelivery, registerGitnessFlags } from "./delivery";
import { registerGitnessReliability } from "./reliability";
import { registerGitnessDevx, registerGitnessDr } from "./devx";

const GITIGNORE_PRESETS = ["Node", "Python", "Go", "Rust", "Java", "C++"];
const LICENSE_PRESETS = ["MIT", "Apache-2.0", "GPL-3.0", "BSD-3-Clause", "ISC"];

export function registerGitnessApi(router: AppRouter) {
  // Facade handlers return bare `Response` objects, so `c.header()` calls
  // made mid-resolution never reach the wire. Stamp `no-store` on `c.res`
  // once the private-repo marker has been applied to the request's cache
  // context — one middleware covers every facade route.
  router.use("/api/v1/*", async (c, next) => {
    await next();
    if (isRequestPrivate(c.var.cacheCtx)) {
      c.res.headers.set("Cache-Control", "no-store");
    }
  });

  // RBAC's `/spaces/{ref}/{usergroups,serviceaccounts,resourcegroups}/...`
  // tails must register before spaces.ts's greedy `/spaces/{ref}/members`
  // patterns — `:space_ref{.+}` would otherwise swallow the group/segment
  // structure into the ref.
  registerGitnessRbac(router);
  // Modules claim `/spaces/{ref}/{environments,artifacts}` tails plus the
  // top-level `/notifications` inbox — before the greedy space routes.
  registerGitnessModules(router);
  // Delivery-plane claims `/spaces/{ref}/{connectors,delegates,files,
  // freezewindows,tickets,gitops,policies,iac}` tails — same ordering rule.
  registerGitnessDelivery(router);
  // Reliability plane claims `/spaces/{ref}/{monitors,slos,downtimes,
  // incidents,certificates,costs,chaos,reliability}` tails.
  registerGitnessReliability(router);
  // Flags/overrides/gitops-sync claim `/spaces/{ref}/{flags,overrides}` tails
  // plus the gitops reconcile tail — same greedy-route ordering rule.
  registerGitnessFlags(router);
  // Devx plane claims `/spaces/{ref}/{catalog,dev-environments,databases,
  // security-tests,supply-chain,dashboards,insights}` tails.
  registerGitnessDevx(router);
  registerGitnessDr(router);
  registerGitnessSpaces(router);
  // Search claims `/api/v1/search` and `/repos/{ref}/+/...` tails — register
  // before the greedy suffix routes below.
  registerGitnessSearch(router);
  registerGitnessExecutions(router);
  registerGitnessRepoKeys(router);
  registerGitnessKnowledge(router);
  // Pullreqs before gitdata: gitdata's greedy `:repo_ref{.+}` suffix routes
  // (e.g. `/activities`) would otherwise swallow `/pullreq/:n/...` paths.
  registerGitnessPullreqs(router);
  // Issues/milestones/labels — same greedy-tail ordering as pullreqs.
  registerGitnessIssues(router);
  // CODEOWNERS — parsed rules + per-path owner resolution for reviewer
  // suggestions; literal tails before the greedy gitdata suffixes.
  registerGitnessCodeowners(router);
  // Discussions — literal tails before the greedy gitdata/repos suffixes.
  registerGitnessDiscussions(router);
  // Social (`/+/star`, `/+/topics`, `/spaces/:s/+/follow`, `/explore`,
  // `/starred`) — literal tails before the greedy gitdata/repos suffixes.
  registerGitnessSocial(router);
  // Wiki — `refs/heads/wiki` pages, literal tails before gitdata.
  registerGitnessWiki(router);
  // Releases — tag-bound metadata + R2 assets, literal tails before gitdata.
  registerGitnessReleases(router);
  // Insights — pulse/activity/contributors from the commit walk.
  registerGitnessInsights(router);
  // Projects — boards/columns/cards, literal tails before gitdata.
  registerGitnessProjects(router);
  // Code scanning — SARIF upload + alerts, literal tails before gitdata.
  registerGitnessCodeScan(router);
  // Moderation — reports, admin triage, space blocks; literal tails.
  registerGitnessModeration(router);
  // Dependency graph — snapshot submission + OSV vulnerabilities.
  registerGitnessDepGraph(router);
  // Actions — .github/workflows → pipeline materialization.
  registerGitnessWorkflows(router);
  registerGitnessGists(router);
  registerGitnessGhImport(router);
  // Repo-scoped DR export/drill/download — must precede the greedy bare-repo
  // GET in registerGitnessRepos or /dr/* reads resolve as repo refs.
  registerGitnessRepoDr(router);
  registerGitnessGitdata(router);
  // Repo meta + the greedy bare-repo GET — keep last.
  registerGitnessRepos(router);
  // Bare-space detail (PATCH/DELETE/GET `/spaces/{ref}`) — greedy, after all
  // space-subroute modules.
  registerGitnessSpaceDetail(router);

  // PATs surface as gitness "tokens" — the full lifecycle is real.
  router.get("/api/v1/user/tokens", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const pats = await listPatsForUser(c.var.db, viewer.userId);
    return c.json(
      pats.map((p) => ({
        identifier: p.name,
        type: "pat",
        principal_id: numericId(viewer.userId),
        created_by: numericId(viewer.userId),
        issued_at: p.createdAt,
        expires_at: p.expiresAt ?? null,
      }))
    );
  });

  router.post("/api/v1/user/tokens", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      lifetime?: number;
    } | null;
    const name = (body?.identifier ?? "").trim();
    if (!name || name.length > 40) return gErr(c, 400, "invalid identifier");
    // Tokens minted here are scoped to the caller's personal namespace —
    // the same grant shape /auth/api/tokens produces.
    const namespaces = await listNamespacesForUser(c.var.db, viewer.userId);
    const primary = namespaces[0];
    if (!primary) return gErr(c, 409, "no namespace — create a space first");
    const generated = generatePatPlaintext();
    const hash = await hashPatPlaintext(generated.plaintext);
    const now = Date.now();
    const patId = newPrefixedId("pat");
    const expiresAt =
      body?.lifetime && body.lifetime > 0 ? now + body.lifetime * 24 * 60 * 60 * 1000 : null;
    await insertPatWithGrants(c.var.db, {
      pat: {
        id: patId,
        userId: viewer.userId,
        name,
        prefix: generated.publicPrefix,
        hash,
        createdAt: now,
        expiresAt,
        revokedAt: null,
        lastUsedAt: null,
      },
      namespaceGrants: [{ patId, namespaceId: primary.id, level: "push" }],
      repoGrants: [],
    });
    c.executionCtx.waitUntil(
      insertSecurityEvent(c.var.db, {
        id: newPrefixedId("sev"),
        userId: viewer.userId,
        kind: "pat.create",
        detail: name,
        createdAt: Date.now(),
      }).catch(() => {})
    );
    return c.json({
      identifier: name,
      access_token: generated.plaintext,
      token: {
        identifier: patId,
        type: "pat",
        principal_id: numericId(viewer.userId),
        issued_at: now,
        expires_at: expiresAt,
      },
    });
  });

  // Favorites — the repo-header star toggle + list `is_favorite` flag.
  // Real per-user KV records (`gfav:{userId}`); only REPOSITORY resources
  // are meaningful to this SPA surface.
  router.post("/api/v1/user/favorite", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as {
      resource_id?: number;
      resource_type?: string;
    } | null;
    if (!body?.resource_id || body.resource_type !== "REPOSITORY") {
      return gErr(c, 400, "expected {resource_type: 'REPOSITORY', resource_id}");
    }
    const favs = await readUserFavorites(c.env, viewer.userId);
    if (!favs.some((f) => f.resource_type === "REPOSITORY" && f.resource_id === body.resource_id)) {
      favs.push({ resource_type: "REPOSITORY", resource_id: body.resource_id });
      await writeUserFavorites(c.env, viewer.userId, favs);
    }
    return c.json({});
  });

  router.delete("/api/v1/user/favorite/:resource_id", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const resourceId = parseInt(c.req.param("resource_id"), 10);
    const resourceType = c.req.query("resource_type") ?? "REPOSITORY";
    if (Number.isNaN(resourceId)) return gErr(c, 400, "invalid resource_id");
    const favs = await readUserFavorites(c.env, viewer.userId);
    const next = favs.filter(
      (f) => !(f.resource_type === resourceType && f.resource_id === resourceId)
    );
    await writeUserFavorites(c.env, viewer.userId, next);
    return c.json({});
  });

  router.delete("/api/v1/user/tokens/:id", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const want = c.req.param("id");
    const pats = await listPatsForUser(c.var.db, viewer.userId);
    const pat = pats.find((p) => p.id === want || p.name === want);
    if (!pat) return gNotFound(c, "token");
    const result = await revokePatById(c.var.db, pat.id, viewer.userId, Date.now());
    if (!result.ok) return gErr(c, 409, `token ${result.reason}`);
    c.executionCtx.waitUntil(
      insertSecurityEvent(c.var.db, {
        id: newPrefixedId("sev"),
        userId: viewer.userId,
        kind: "pat.revoke",
        detail: pat.name,
        createdAt: Date.now(),
      }).catch(() => {})
    );
    return c.json({});
  });

  // Security log — the user's own auth-history trail (GitHub parity).
  router.get("/api/v1/user/security-log", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const rows = await listSecurityEventsForUser(c.var.db, viewer.userId);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        detail: r.detail,
        created_at: new Date(r.createdAt).toISOString(),
      }))
    );
  });

  // SSH public keys — real KV records per user. They aren't an auth factor
  // yet (auth is PAT/DID), but the records are genuine: stored, listed,
  // deletable, and shown in the UI.
  router.get("/api/v1/user/keys/:id", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const keys =
      ((await c.env.ROUTES.get(`gkeys:${viewer.userId}`, "json").catch(() => null)) as
        | { id: number; identifier: string; key: string; created: number }[]
        | null) ?? [];
    const key = keys.find(
      (k) => k.id === parseInt(c.req.param("id"), 10) || k.identifier === c.req.param("id")
    );
    if (!key) return gNotFound(c, "key");
    return c.json(key);
  });

  router.post("/api/v1/user/keys", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      content?: string;
    } | null;
    if (!body?.content?.match(/^ssh-(rsa|ed25519|dss|ecdsa)/)) {
      return gErr(c, 400, "invalid public key content");
    }
    const keys =
      ((await c.env.ROUTES.get(`gkeys:${viewer.userId}`, "json").catch(() => null)) as
        | { id: number; identifier: string; key: string; created: number }[]
        | null) ?? [];
    const key = {
      id: (keys.at(-1)?.id ?? 0) + 1,
      identifier: body.identifier?.trim() || body.content.slice(0, 24),
      key: body.content,
      created: Date.now(),
    };
    await c.env.ROUTES.put(`gkeys:${viewer.userId}`, JSON.stringify([...keys, key]));
    // Fingerprint reverse-index for commit-signature verification: the
    // signer lookup goes fp → userId without scanning every user's keys.
    const parsed = parseAuthorizedKey(body.content);
    if (parsed) {
      const fp = await sshFingerprint(parsed.blob);
      await c.env.ROUTES.put(`gkeyfp:${fp}`, viewer.userId).catch(() => {});
    }
    return c.json(key);
  });

  router.delete("/api/v1/user/keys/:id", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const keys =
      ((await c.env.ROUTES.get(`gkeys:${viewer.userId}`, "json").catch(() => null)) as
        | { id: number; identifier: string; key: string; created: number }[]
        | null) ?? [];
    const removed = keys.filter(
      (k) => k.id === parseInt(c.req.param("id"), 10) || k.identifier === c.req.param("id")
    );
    const next = keys.filter(
      (k) => k.id !== parseInt(c.req.param("id"), 10) && k.identifier !== c.req.param("id")
    );
    if (next.length === keys.length) return gNotFound(c, "key");
    await c.env.ROUTES.put(`gkeys:${viewer.userId}`, JSON.stringify(next));
    for (const k of removed) {
      const parsed = parseAuthorizedKey(k.key);
      if (parsed) {
        const fp = await sshFingerprint(parsed.blob);
        await c.env.ROUTES.delete(`gkeyfp:${fp}`).catch(() => {});
      }
    }
    return c.json({});
  });

  // Template pickers in the create-repo dialog.
  router.get("/api/v1/resources/gitignore", async (c) => c.json(GITIGNORE_PRESETS));
  router.get("/api/v1/resources/license", async (c) => c.json(LICENSE_PRESETS));

  // --- admin user records ---------------------------------------------------
  //
  // There is no site-admin role in delta-git. These endpoints expose the
  // caller's real directory view: users are listed as the members of every
  // namespace the caller belongs to (the same principals the member pickers
  // show); record read/update/delete is self-only.

  router.get("/api/v1/admin/users", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const namespaces = await listNamespacesForUser(c.var.db, viewer.userId);
    const seen = new Map<string, { id: number; uid: string; display_name: string; type: string }>();
    for (const ns of namespaces) {
      const members = await listMembershipsForNamespace(c.var.db, ns.id).catch(() => []);
      for (const m of members) {
        if (seen.has(m.userId)) continue;
        const owned = await listNamespacesForUser(c.var.db, m.userId).catch(() => []);
        const uid = owned[0]?.slug ?? m.userId;
        seen.set(m.userId, {
          id: numericId(m.userId),
          uid,
          display_name: uid,
          type: "user",
        });
      }
    }
    return c.json([...seen.values()]);
  });

  // Admin-create = real account record minted out-of-band (no session) — the
  // user signs in via OIDC/DID afterwards, which binds them by namespace.
  router.post("/api/v1/admin/users", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as { uid?: string } | null;
    const validation = validateSlugForRoute(normalizeIdentifier(body?.uid ?? ""));
    if (!validation.ok) return gErr(c, 400, "invalid uid");
    if (await findNamespaceBySlug(c.var.db, validation.slug)) {
      return gErr(c, 409, "uid already taken");
    }
    const now = Date.now();
    const userId = generateUserId();
    const user = await insertUserIfNew(c.var.db, {
      id: userId,
      tesseraSub: `admin-create:${userId}`,
      createdAt: now,
    });
    if (!user) return gErr(c, 409, "uid already taken");
    const ns = await claimNamespace(c.var.db, {
      id: generateNamespaceId(),
      slug: validation.slug,
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
    return c.json({ uid: ns.slug, display_name: ns.slug, type: "user", created: now });
  });

  router.get("/api/v1/admin/users/:uid", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const uid = c.req.param("uid");
    const ns = await findNamespaceBySlug(c.var.db, uid);
    if (!ns) return gNotFound(c, "user");
    return c.json({ uid: ns.slug, display_name: ns.slug, type: "user", created: ns.createdAt });
  });

  // User profile fields the users table doesn't model (display name, email,
  // admin flag) live in a per-user KV record — `gprofile:{userId}`.
  async function readProfile(c: GitnessContext, userId: string) {
    const raw = await c.env.ROUTES.get(`gprofile:${userId}`, "json").catch(() => null);
    return (raw as { display_name?: string; email?: string; admin?: boolean } | null) ?? {};
  }

  router.patch("/api/v1/admin/users/:uid", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await findNamespaceBySlug(c.var.db, c.req.param("uid"));
    if (!ns || ns.createdBy !== viewer.userId) return gErr(c, 403, "not self");
    const body = (await c.req.json().catch(() => null)) as {
      display_name?: string;
      email?: string;
    } | null;
    const profile = await readProfile(c, viewer.userId);
    if (body?.display_name !== undefined) profile.display_name = body.display_name;
    if (body?.email !== undefined) profile.email = body.email;
    await c.env.ROUTES.put(`gprofile:${viewer.userId}`, JSON.stringify(profile));
    return c.json({
      uid: ns.slug,
      display_name: profile.display_name ?? ns.slug,
      email: profile.email ?? "",
      admin: profile.admin ?? false,
      type: "user",
      created: ns.createdAt,
    });
  });

  router.patch("/api/v1/admin/users/:uid/admin", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await findNamespaceBySlug(c.var.db, c.req.param("uid"));
    if (!ns || ns.createdBy !== viewer.userId) return gErr(c, 403, "not self");
    const body = (await c.req.json().catch(() => null)) as { admin?: boolean } | null;
    const profile = await readProfile(c, viewer.userId);
    profile.admin = body?.admin ?? false;
    await c.env.ROUTES.put(`gprofile:${viewer.userId}`, JSON.stringify(profile));
    return c.json({
      uid: ns.slug,
      display_name: profile.display_name ?? ns.slug,
      email: profile.email ?? "",
      admin: profile.admin,
      type: "user",
      created: ns.createdAt,
    });
  });

  // Account deletion is real but guarded: only when every namespace the user
  // owns is repo-free (same constraint as space delete — orphaned DO/R2 repo
  // state is not an acceptable side effect).
  router.delete("/api/v1/admin/users/:uid", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await findNamespaceBySlug(c.var.db, c.req.param("uid"));
    if (!ns || ns.createdBy !== viewer.userId) return gErr(c, 403, "not self");
    const owned = await listNamespacesForUser(c.var.db, viewer.userId);
    for (const n of owned) {
      const repos = await listRepositoriesForNamespace(c.var.db, n.id, viewer.userId);
      if (repos.length > 0) {
        return gErr(c, 409, `namespace ${n.slug} owns repositories — delete them first`);
      }
    }
    for (const n of owned) await deleteNamespaceRow(c.var.db, n.id);
    const removed = await deleteUserRow(c.var.db, viewer.userId);
    if (!removed) return gNotFound(c, "user");
    return c.json({});
  });

  // Catch-all: any /api/v1 path without a registered route 404s explicitly.
  router.all("/api/v1/*", async (c) =>
    c.json({ message: `not implemented: ${c.req.method} ${c.req.path}` }, 404)
  );
}
