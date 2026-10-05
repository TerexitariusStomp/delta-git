// Wave-2 delivery-plane endpoints — space-scoped CRUD for connectors,
// delegates, file store, freeze windows, external tickets, gitops targets,
// and policies, plus the IaC state-locking protocol. Registered before the
// greedy space routes.

import type { AppRouter } from "@/worker/routes/hono";

import { loadViewer } from "@/worker/auth/session";
import { viewerIsNamespaceMember } from "@/worker/auth/pat";
import { findNamespaceBySlug } from "@/worker/db/d1/dal/namespaces";
import { findRepositoryByDoName } from "@/worker/db/d1/dal/repositories";
import {
  deleteConnector,
  deleteDelegate,
  deleteFileRow,
  deleteFreezeWindow,
  deleteGitopsTarget,
  deletePolicy,
  findFile,
  findIacState,
  insertConnector,
  insertDelegate,
  insertFile,
  insertFreezeWindow,
  insertGitopsTarget,
  insertIacState,
  insertPolicy,
  insertTicket,
  listConnectors,
  listDelegates,
  listFiles,
  listEnabledPolicies,
  listFreezeWindows,
  listGitopsTargets,
  listPolicies,
  listTickets,
  updateFreezeWindow,
  updateIacState,
  updateTicket,
} from "@/worker/db/d1/dal/modules";
import { newPrefixedId } from "@/worker/common";
import { isValidOwnerRepo } from "@/shared/web";
import { gErr, gNotFound, numericId } from "./shared";
import {
  readRepoTemplates,
  readSecrets,
  writeRepoTemplates,
  writeSecrets,
  type RepoTemplate,
  type SecretRecord,
} from "./stores";
import type { GitnessContext } from "./shared";
import type { Db } from "@/worker/db/d1/client";

async function resolveMemberSpace(
  c: GitnessContext,
  ref: string
): Promise<{ id: string; slug: string; userId: string } | Response> {
  const viewer = await loadViewer(c);
  if (!viewer) return gErr(c, 401, "unauthorized");
  const slug = ref.replace(/\/+$/, "");
  if (!isValidOwnerRepo(slug)) return gNotFound(c, "space");
  const ns = await findNamespaceBySlug(c.var.db, slug);
  if (!ns) return gNotFound(c, "space");
  if (!(await viewerIsNamespaceMember(c.var.db, viewer.userId, ns.id))) {
    return gErr(c, 403, "forbidden");
  }
  return { id: ns.id, slug: ns.slug, userId: viewer.userId };
}

/** Evaluate a freeze-window schedule ("sa,su" or "mo-fr 17-09") against `now`
 * in UTC — pure function, also used by the merge/push enforcement hooks. */
export function freezeWindowActive(schedule: string, now = new Date()): boolean {
  const days = ["su", "mo", "tu", "we", "th", "fr", "sa"];
  const [daysPart, hoursPart] = schedule.trim().toLowerCase().split(/\s+/);
  const wanted = new Set<number>();
  for (const seg of (daysPart ?? "").split(",")) {
    const [a, b] = seg.split("-");
    const ai = days.indexOf(a ?? "");
    if (ai < 0) continue;
    const bi = b ? days.indexOf(b) : ai;
    if (bi < 0) continue;
    for (let d = ai; ; d = (d + 1) % 7) {
      wanted.add(d);
      if (d === bi) break;
    }
  }
  if (wanted.size > 0 && !wanted.has(now.getUTCDay())) return false;
  if (hoursPart) {
    const [h0, h1] = hoursPart.split("-").map(Number);
    if (Number.isFinite(h0) && Number.isFinite(h1)) {
      const hour = now.getUTCHours();
      const inRange = h0! <= h1! ? hour >= h0! && hour < h1! : hour >= h0! || hour < h1!;
      if (!inRange) return false;
    }
  }
  return true;
}

export function registerGitnessDelivery(router: AppRouter) {
  // --- connectors -------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/connectors", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listConnectors(c.var.db, ns.id);
    return c.json(
      rows.map((r) => ({
        id: numericId(r.id),
        identifier: r.identifier,
        type: r.type,
        endpoint: r.endpoint,
        description: r.description ?? "",
        // sealed_handle deliberately omitted — the broker handle is only
        // meaningful to the custody worker, never rendered.
        has_secret: r.sealedHandle !== null,
        created: r.createdAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/connectors", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      type?: string;
      endpoint?: string;
      sealed_handle?: string;
      description?: string;
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !isValidOwnerRepo(identifier)) {
      return gErr(c, 400, "valid identifier required");
    }
    const now = Date.now();
    await insertConnector(c.var.db, {
      id: newPrefixedId("con"),
      namespaceId: ns.id,
      identifier,
      type: body?.type ?? "generic-http",
      endpoint: body?.endpoint ?? null,
      sealedHandle: body?.sealed_handle ?? null,
      description: body?.description ?? null,
      createdBy: ns.userId,
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ identifier, type: body?.type ?? "generic-http" }, 201);
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/connectors/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    // Deletes key on identifier — the numericId in list responses is a
    // display-only hash, not round-trippable.
    const key = decodeURIComponent(c.req.param("id"));
    const rows = await listConnectors(c.var.db, ns.id);
    const row = rows.find((r) => r.id === key) ?? rows.find((r) => r.identifier === key);
    if (!row) return gNotFound(c, "connector");
    await deleteConnector(c.var.db, row.id);
    return c.body(null, 204);
  });

  // --- delegates ----------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/delegates", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listDelegates(c.var.db, ns.id);
    return c.json(
      rows.map((r) => ({
        id: numericId(r.id),
        identifier: r.identifier,
        tags: JSON.parse(r.tags) as string[],
        status: r.status,
        last_seen: r.lastSeenAt,
        created: r.createdAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/delegates", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      tags?: string[];
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !isValidOwnerRepo(identifier)) {
      return gErr(c, 400, "valid identifier required");
    }
    await insertDelegate(c.var.db, {
      id: newPrefixedId("dgt"),
      namespaceId: ns.id,
      identifier,
      tags: JSON.stringify(body?.tags ?? []),
      status: "offline",
      lastSeenAt: null,
      createdBy: ns.userId,
      createdAt: Date.now(),
    });
    return c.json({ identifier }, 201);
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/delegates/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    await deleteDelegate(c.var.db, decodeURIComponent(c.req.param("id")));
    return c.body(null, 204);
  });

  // --- file store -----------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/files", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listFiles(c.var.db, ns.id);
    return c.json(
      rows.map((r) => ({
        name: r.name,
        size: r.size,
        content_type: r.contentType,
        created_by: r.createdBy,
        created: r.createdAt,
      }))
    );
  });

  router.put("/api/v1/spaces/:space_ref{.+}/files/:name{.+}", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const name = decodeURIComponent(c.req.param("name"));
    const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
    if (bytes.byteLength === 0) return gErr(c, 400, "empty body");
    const r2Key = `filestore/${ns.id}/${name.replace(/\.\./g, "_")}`;
    const contentType = c.req.header("content-type") ?? "application/octet-stream";
    await c.env.REPO_BUCKET.put(r2Key, bytes, { httpMetadata: { contentType } });
    const existing = await findFile(c.var.db, ns.id, name);
    if (existing) await deleteFileRow(c.var.db, existing.id);
    await insertFile(c.var.db, {
      id: newPrefixedId("fil"),
      namespaceId: ns.id,
      name,
      r2Key,
      size: bytes.byteLength,
      contentType,
      createdBy: ns.userId,
      createdAt: Date.now(),
    });
    return c.json({ name, size: bytes.byteLength }, 201);
  });

  router.get("/api/v1/spaces/:space_ref{.+}/files/:name{.+}", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findFile(c.var.db, ns.id, decodeURIComponent(c.req.param("name")));
    if (!row) return gNotFound(c, "file");
    const obj = await c.env.REPO_BUCKET.get(row.r2Key);
    if (!obj) return gNotFound(c, "file");
    return new Response(obj.body, {
      headers: { "Content-Type": row.contentType ?? "application/octet-stream" },
    });
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/files/:name{.+}", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findFile(c.var.db, ns.id, decodeURIComponent(c.req.param("name")));
    if (!row) return gNotFound(c, "file");
    await c.env.REPO_BUCKET.delete(row.r2Key);
    await deleteFileRow(c.var.db, row.id);
    return c.body(null, 204);
  });

  // --- freeze windows ---------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/freezewindows", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listFreezeWindows(c.var.db, ns.id);
    const now = new Date();
    return c.json(
      rows.map((r) => ({
        id: numericId(r.id),
        identifier: r.identifier,
        schedule: r.schedule,
        applies_to: r.appliesTo,
        enabled: r.enabled === 1,
        active: r.enabled === 1 && freezeWindowActive(r.schedule, now),
        created: r.createdAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/freezewindows", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      schedule?: string;
      applies_to?: string;
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !body?.schedule?.trim()) {
      return gErr(c, 400, "identifier + schedule required");
    }
    await insertFreezeWindow(c.var.db, {
      id: newPrefixedId("frz"),
      namespaceId: ns.id,
      identifier,
      schedule: body.schedule.trim(),
      appliesTo: body?.applies_to ?? "all",
      enabled: 1,
      createdAt: Date.now(),
    });
    return c.json({ identifier }, 201);
  });

  router.patch("/api/v1/spaces/:space_ref{.+}/freezewindows/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null;
    await updateFreezeWindow(c.var.db, decodeURIComponent(c.req.param("id")), {
      enabled: body?.enabled === false ? 0 : 1,
    });
    return c.json({});
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/freezewindows/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    await deleteFreezeWindow(c.var.db, decodeURIComponent(c.req.param("id")));
    return c.body(null, 204);
  });

  // --- external tickets -------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/tickets", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listTickets(c.var.db, ns.id);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        external_id: r.externalId,
        title: r.title,
        url: r.url,
        status: r.status,
        repo_id: r.repositoryId,
        created: r.createdAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/tickets", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      external_id?: string;
      title?: string;
      url?: string;
      repo?: string;
      status?: string;
    } | null;
    if (!body?.external_id?.trim() || !body?.title?.trim()) {
      return gErr(c, 400, "external_id + title required");
    }
    let repositoryId: string | null = null;
    if (body.repo) {
      const route = await findRepositoryByDoName(c.var.db, `${ns.slug}/${body.repo}`);
      repositoryId = route?.id ?? null;
    }
    const now = Date.now();
    const id = newPrefixedId("tkt");
    await insertTicket(c.var.db, {
      id,
      namespaceId: ns.id,
      repositoryId,
      externalId: body.external_id.trim(),
      title: body.title.trim(),
      url: body.url ?? null,
      status: body.status ?? "open",
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ id }, 201);
  });

  router.patch("/api/v1/spaces/:space_ref{.+}/tickets/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      title?: string;
      status?: string;
      url?: string;
    } | null;
    await updateTicket(c.var.db, c.req.param("id"), {
      ...(body?.title ? { title: body.title } : {}),
      ...(body?.status ? { status: body.status } : {}),
      ...(body?.url !== undefined ? { url: body.url } : {}),
      updatedAt: Date.now(),
    });
    return c.json({});
  });

  // --- gitops targets -----------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/gitops", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listGitopsTargets(c.var.db, ns.id);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        identifier: r.identifier,
        repository_id: r.repositoryId,
        branch: r.branch,
        target_environment: r.targetEnvironment,
        enabled: r.enabled === 1,
        last_sync: r.lastSyncAt,
        created: r.createdAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/gitops", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      repo?: string;
      branch?: string;
      target_environment?: string;
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !body?.repo || !body?.target_environment) {
      return gErr(c, 400, "identifier + repo + target_environment required");
    }
    const route = await findRepositoryByDoName(c.var.db, `${ns.slug}/${body.repo}`);
    if (!route) return gNotFound(c, "repository");
    await insertGitopsTarget(c.var.db, {
      id: newPrefixedId("gop"),
      namespaceId: ns.id,
      identifier,
      repositoryId: route.id,
      branch: body.branch ?? "main",
      targetEnvironment: body.target_environment,
      enabled: 1,
      lastSyncAt: null,
      createdAt: Date.now(),
    });
    return c.json({ identifier }, 201);
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/gitops/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    await deleteGitopsTarget(c.var.db, c.req.param("id"));
    return c.body(null, 204);
  });

  // --- policies -------------------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/policies", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listPolicies(c.var.db, ns.id);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        identifier: r.identifier,
        document: JSON.parse(r.document) as unknown[],
        applies_to: r.appliesTo,
        enforcement: r.enforcement,
        enabled: r.enabled === 1,
        created: r.createdAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/policies", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      document?: unknown[];
      applies_to?: string;
      enforcement?: string;
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !Array.isArray(body?.document)) {
      return gErr(c, 400, "identifier + document required");
    }
    const now = Date.now();
    await insertPolicy(c.var.db, {
      id: newPrefixedId("pol"),
      namespaceId: ns.id,
      identifier,
      document: JSON.stringify(body.document),
      appliesTo: body?.applies_to ?? "all",
      enforcement: body?.enforcement === "enforce" ? "enforce" : "warn",
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ identifier }, 201);
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/policies/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    await deletePolicy(c.var.db, c.req.param("id"));
    return c.body(null, 204);
  });

  // --- space templates ---------------------------------------------------------------------
  // Same `RepoTemplate` shape as repo-level templates, keyed `gtmpl:space:<ns>`
  // in the ROUTES KV — space templates seed new repos/pipelines.

  router.get("/api/v1/spaces/:space_ref{.+}/templates", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    return c.json(await readRepoTemplates(c.env, `space:${ns.id}`));
  });

  router.post("/api/v1/spaces/:space_ref{.+}/templates", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      data?: string;
    } | null;
    if (!body?.identifier?.trim()) return gErr(c, 400, "identifier required");
    const key = `space:${ns.id}`;
    const templates = await readRepoTemplates(c.env, key);
    if (templates.some((t) => t.identifier === body.identifier)) {
      return gErr(c, 409, "template exists");
    }
    const t: RepoTemplate = {
      id: (templates.at(-1)?.id ?? 0) + 1,
      identifier: body.identifier.trim(),
      data: body.data ?? "",
      created: Date.now(),
    };
    await writeRepoTemplates(c.env, key, [...templates, t]);
    return c.json(t);
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/templates/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const key = `space:${ns.id}`;
    const templates = await readRepoTemplates(c.env, key);
    const next = templates.filter((t) => t.id !== parseInt(c.req.param("id"), 10));
    if (next.length === templates.length) return gNotFound(c, "template");
    await writeRepoTemplates(c.env, key, next);
    return c.json({});
  });

  // --- space variables ---------------------------------------------------------------------
  // Sealed variable records — same client-custody model as secrets, stored
  // under a separate `gvars:` KV scope so the Variables surface stays
  // independent of the Secrets vault.

  router.get("/api/v1/spaces/:space_ref{.+}/variables", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const vars = await readSecrets(c.env, `gvars:${ns.id}`);
    return c.json(
      vars.map((v) => ({
        identifier: v.name,
        description: v.description ?? "",
        type: "secret",
        created: v.created,
        updated: v.updated,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/variables", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      description?: string;
      ciphertext?: string;
    } | null;
    const name = body?.identifier?.trim().toUpperCase();
    if (!name || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
      return gErr(c, 400, "invalid variable name");
    }
    const key = `gvars:${ns.id}`;
    const vars = await readSecrets(c.env, key);
    const now = Date.now();
    const existing = vars.find((v) => v.name === name);
    if (existing) {
      existing.description = body?.description ?? existing.description;
      existing.ciphertext = body?.ciphertext ?? existing.ciphertext;
      existing.updated = now;
      await writeSecrets(c.env, key, vars);
      return c.json({ identifier: name });
    }
    const rec: SecretRecord = {
      id: newPrefixedId("var"),
      name,
      description: body?.description,
      allowed_hosts: [],
      ciphertext: body?.ciphertext,
      created_by: ns.userId,
      created: now,
      updated: now,
    };
    await writeSecrets(c.env, key, [...vars, rec]);
    return c.json({ identifier: name }, 201);
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/variables/:name", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const key = `gvars:${ns.id}`;
    const name = decodeURIComponent(c.req.param("name")).toUpperCase();
    const vars = await readSecrets(c.env, key);
    const next = vars.filter((v) => v.name !== name);
    if (next.length === vars.length) return gNotFound(c, "variable");
    await writeSecrets(c.env, key, next);
    return c.body(null, 204);
  });

  // --- IaC state backend (Terraform HTTP locking protocol) --------------------------------
  //
  // terraform init -backend-config="address=https://host/api/v1/spaces/{s}/iac/{name}"
  // → GET reads state, POST writes (with ?ID=<lock-id>), LOCK/UNLOCK manage the lock.
  router.get("/api/v1/spaces/:space_ref{.+}/iac/:name/state", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findIacState(c.var.db, ns.id, c.req.param("name"));
    if (!row?.r2Key) return gNotFound(c, "state");
    const obj = await c.env.REPO_BUCKET.get(row.r2Key);
    if (!obj) return gNotFound(c, "state");
    return new Response(obj.body, {
      headers: { "Content-Type": "application/json", "X-Iac-Version": String(row.version) },
    });
  });

  router.post("/api/v1/spaces/:space_ref{.+}/iac/:name/state", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const name = c.req.param("name");
    const lockId = c.req.query("ID") ?? "";
    let row = await findIacState(c.var.db, ns.id, name);
    if (!row) {
      await insertIacState(c.var.db, {
        id: newPrefixedId("iac"),
        namespaceId: ns.id,
        name,
        r2Key: null,
        version: 0,
        lockId: null,
        lockInfo: null,
        updatedAt: Date.now(),
      });
      row = (await findIacState(c.var.db, ns.id, name))!;
    }
    if (row.lockId && row.lockId !== lockId) {
      return c.json(
        { error: "state locked", lock: row.lockInfo ? JSON.parse(row.lockInfo) : null },
        423
      );
    }
    const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
    const r2Key = `iac/${ns.id}/${name}.tfstate`;
    await c.env.REPO_BUCKET.put(r2Key, bytes, {
      httpMetadata: { contentType: "application/json" },
    });
    await updateIacState(c.var.db, row.id, {
      r2Key,
      version: row.version + 1,
      updatedAt: Date.now(),
    });
    return c.json({ version: row.version + 1 });
  });

  router.post("/api/v1/spaces/:space_ref{.+}/iac/:name/lock", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const name = c.req.param("name");
    const info = (await c.req.json().catch(() => null)) as { ID?: string } | null;
    const lockId = info?.ID ?? newPrefixedId("lock");
    let row = await findIacState(c.var.db, ns.id, name);
    if (!row) {
      await insertIacState(c.var.db, {
        id: newPrefixedId("iac"),
        namespaceId: ns.id,
        name,
        r2Key: null,
        version: 0,
        lockId: null,
        lockInfo: null,
        updatedAt: Date.now(),
      });
      row = (await findIacState(c.var.db, ns.id, name))!;
    }
    if (row.lockId) {
      return c.json({ error: "already locked", lock: JSON.parse(row.lockInfo ?? "{}") }, 423);
    }
    await updateIacState(c.var.db, row.id, {
      lockId,
      lockInfo: JSON.stringify({ ...info, created: Date.now() }),
      updatedAt: Date.now(),
    });
    return c.json({ id: lockId });
  });

  router.post("/api/v1/spaces/:space_ref{.+}/iac/:name/unlock", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const info = (await c.req.json().catch(() => null)) as { ID?: string } | null;
    const row = await findIacState(c.var.db, ns.id, c.req.param("name"));
    if (!row) return gNotFound(c, "state");
    if (row.lockId && row.lockId !== info?.ID) {
      return c.json({ error: "lock mismatch" }, 423);
    }
    await updateIacState(c.var.db, row.id, {
      lockId: null,
      lockInfo: null,
      updatedAt: Date.now(),
    });
    return c.json({});
  });
}

// --- delivery gates (freeze windows + policies) ---------------------------------------
//
// Evaluated at mutation points (receive-pack, merge intents). Freeze windows
// are absolute time gates; policies are JSON rule documents — the in-worker
// evaluator until an OPA-wasm substrate lands.

export interface GateContext {
  op: "push" | "merge" | "deploy";
  /** Ref shortname for push/merge ops (e.g. "main"). */
  branch?: string;
  /** Pusher/merger uid. */
  actor?: string;
}

export interface PolicyRule {
  when: { field: string; op: "eq" | "matches" | "ne"; value: string };
  action: "deny" | "warn";
  message?: string;
}

function globToRe(glob: string): RegExp {
  return new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`
  );
}

function ruleMatches(rule: PolicyRule, ctx: GateContext): boolean {
  const actual =
    rule.when.field === "branch"
      ? (ctx.branch ?? "")
      : rule.when.field === "actor"
        ? (ctx.actor ?? "")
        : "";
  switch (rule.when.op) {
    case "eq":
      return actual === rule.when.value;
    case "ne":
      return actual !== rule.when.value;
    case "matches":
      return globToRe(rule.when.value).test(actual);
  }
}

export interface GateResult {
  ok: boolean;
  deny?: string;
  warnings: string[];
}

/**
 * Returns `{ok:false}` when an enabled freeze window covers `ctx.op` at `now`,
 * or an `enforce`-mode policy denies the operation. `warn`-mode hits are
 * collected for op-logging.
 */
export async function evaluateDeliveryGates(
  db: Db,
  namespaceId: string,
  ctx: GateContext
): Promise<GateResult> {
  const windows = await listFreezeWindows(db, namespaceId);
  const now = new Date();
  for (const w of windows) {
    if (w.enabled !== 1) continue;
    if (w.appliesTo !== "all" && w.appliesTo !== ctx.op) continue;
    if (freezeWindowActive(w.schedule, now)) {
      return {
        ok: false,
        deny: `freeze window "${w.identifier}" is active (${w.schedule} UTC) — ${ctx.op} is gated until it closes`,
        warnings: [],
      };
    }
  }
  const warnings: string[] = [];
  for (const p of await listEnabledPolicies(db, namespaceId, ctx.op)) {
    const rules = JSON.parse(p.document) as PolicyRule[];
    for (const rule of rules) {
      if (!ruleMatches(rule, ctx)) continue;
      const msg = rule.message ?? `policy "${p.identifier}" ${rule.action}s this ${ctx.op}`;
      if (rule.action === "deny" && p.enforcement === "enforce") {
        return { ok: false, deny: msg, warnings };
      }
      warnings.push(msg);
    }
  }
  return { ok: true, warnings };
}
