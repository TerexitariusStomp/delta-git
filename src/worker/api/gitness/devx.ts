// Wave-4 developer-experience plane — portal catalog, dev environments,
// database records + migration ledger, security-test job records,
// supply-chain documents, dashboards, and the dev-insights roll-up.

import type { AppRouter } from "@/worker/routes/hono";

import { loadViewer } from "@/worker/auth/session";
import { viewerIsNamespaceMember } from "@/worker/auth/pat";
import { findNamespaceBySlug, listMembershipsForNamespace } from "@/worker/db/d1/dal/namespaces";
import {
  findRepositoryByDoName,
  listRepositoriesForNamespace,
} from "@/worker/db/d1/dal/repositories";
import {
  deleteCatalogEntity,
  deleteDatabaseRecord,
  findDatabaseRecord,
  findSecurityTest,
  findSupplyChainDoc,
  insertCatalogEntity,
  insertDashboard,
  insertDatabaseRecord,
  insertDevEnvironment,
  insertSecurityTest,
  insertSupplyChainDoc,
  listCatalogEntities,
  listDashboards,
  listDatabaseRecords,
  listDevEnvironments,
  listSecurityTests,
  listSupplyChainDocs,
  updateDashboard,
  updateDatabaseRecord,
  updateDevEnvironment,
  updateSecurityTest,
  listArtifactsForNamespace,
  listIncidents,
  listMonitors,
} from "@/worker/db/d1/dal/modules";
import { getRepoStub, newPrefixedId } from "@/worker/common";
import { isValidOwnerRepo } from "@/shared/web";
import { gErr, gNotFound } from "./shared";
import type { GitnessContext } from "./shared";

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

export function registerGitnessDevx(router: AppRouter) {
  // --- portal catalog --------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/catalog", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listCatalogEntities(c.var.db, ns.id);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        identifier: r.identifier,
        kind: r.kind,
        repository_id: r.repositoryId,
        owner: r.owner,
        description: r.description,
        metadata: JSON.parse(r.metadata) as Record<string, unknown>,
        created: r.createdAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/catalog", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      kind?: string;
      repo?: string;
      owner?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !isValidOwnerRepo(identifier)) {
      return gErr(c, 400, "valid identifier required");
    }
    let repositoryId: string | null = null;
    if (body?.repo) {
      const route = await findRepositoryByDoName(c.var.db, `${ns.slug}/${body.repo}`);
      repositoryId = route?.id ?? null;
    }
    await insertCatalogEntity(c.var.db, {
      id: newPrefixedId("cat"),
      namespaceId: ns.id,
      identifier,
      kind: body?.kind ?? "service",
      repositoryId,
      owner: body?.owner ?? null,
      description: body?.description ?? null,
      metadata: JSON.stringify(body?.metadata ?? {}),
      createdAt: Date.now(),
    });
    return c.json({ identifier }, 201);
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/catalog/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    await deleteCatalogEntity(c.var.db, c.req.param("id"));
    return c.body(null, 204);
  });

  // --- dev environments ---------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/dev-environments", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listDevEnvironments(c.var.db, ns.id);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        identifier: r.identifier,
        repository_id: r.repositoryId,
        status: r.status,
        machine_type: r.machineType,
        created_by: r.createdBy,
        created: r.createdAt,
        last_used: r.lastUsedAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/dev-environments", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      repo?: string;
      machine_type?: string;
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !isValidOwnerRepo(identifier)) {
      return gErr(c, 400, "valid identifier required");
    }
    let repositoryId: string | null = null;
    if (body?.repo) {
      const route = await findRepositoryByDoName(c.var.db, `${ns.slug}/${body.repo}`);
      repositoryId = route?.id ?? null;
    }
    await insertDevEnvironment(c.var.db, {
      id: newPrefixedId("dev"),
      namespaceId: ns.id,
      identifier,
      repositoryId,
      status: "stopped",
      machineType: body?.machine_type ?? "standard",
      createdBy: ns.userId,
      createdAt: Date.now(),
      lastUsedAt: null,
    });
    return c.json({ identifier }, 201);
  });

  router.post("/api/v1/spaces/:space_ref{.+}/dev-environments/:id/:action", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const action = c.req.param("action");
    if (action !== "start" && action !== "stop") return gErr(c, 400, "start|stop");
    const rows = await listDevEnvironments(c.var.db, ns.id);
    const row = rows.find((r) => r.id === c.req.param("id") || r.identifier === c.req.param("id"));
    if (!row) return gNotFound(c, "environment");
    await updateDevEnvironment(c.var.db, row.id, {
      status: action === "start" ? "running" : "stopped",
      lastUsedAt: action === "start" ? Date.now() : row.lastUsedAt,
    });
    return c.json({ status: action === "start" ? "running" : "stopped" });
  });

  // --- database records + migration ledger -------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/databases", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listDatabaseRecords(c.var.db, ns.id);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        identifier: r.identifier,
        engine: r.engine,
        host: r.host,
        status: r.status,
        migrations: JSON.parse(r.migrations) as { version: string; appliedAt: number }[],
        created: r.createdAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/databases", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      engine?: string;
      host?: string;
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !isValidOwnerRepo(identifier)) {
      return gErr(c, 400, "valid identifier required");
    }
    await insertDatabaseRecord(c.var.db, {
      id: newPrefixedId("db"),
      namespaceId: ns.id,
      identifier,
      engine: body?.engine ?? "postgres",
      host: body?.host ?? null,
      status: "provisioned",
      migrations: "[]",
      createdAt: Date.now(),
    });
    return c.json({ identifier }, 201);
  });

  router.post("/api/v1/spaces/:space_ref{.+}/databases/:id/migrations", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findDatabaseRecord(c.var.db, ns.id, c.req.param("id"));
    if (!row) return gNotFound(c, "database");
    const body = (await c.req.json().catch(() => null)) as { version?: string } | null;
    if (!body?.version?.trim()) return gErr(c, 400, "version required");
    const migrations = JSON.parse(row.migrations) as {
      version: string;
      appliedAt: number;
      actor: string;
    }[];
    migrations.push({
      version: body.version.trim(),
      appliedAt: Date.now(),
      actor: ns.userId,
    });
    await updateDatabaseRecord(c.var.db, row.id, { migrations: JSON.stringify(migrations) });
    return c.json({ applied: migrations.length });
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/databases/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findDatabaseRecord(c.var.db, ns.id, c.req.param("id"));
    if (!row) return gNotFound(c, "database");
    await deleteDatabaseRecord(c.var.db, row.id);
    return c.body(null, 204);
  });

  // --- security tests -------------------------------------------------------------------------
  // Job records: a delegate/CLI creates a queued test, executes it client-side,
  // then POSTs the outcome to /result. Report payloads are summaries only —
  // raw secret values never leave the client.

  router.get("/api/v1/spaces/:space_ref{.+}/security-tests", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listSecurityTests(c.var.db, ns.id);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        target: r.target,
        status: r.status,
        findings: r.findings,
        repository_id: r.repositoryId,
        created: r.createdAt,
        finished: r.finishedAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/security-tests", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      kind?: string;
      target?: string;
      repo?: string;
    } | null;
    if (!body?.kind || !body?.target?.trim()) {
      return gErr(c, 400, "kind + target required");
    }
    let repositoryId: string | null = null;
    if (body?.repo) {
      const route = await findRepositoryByDoName(c.var.db, `${ns.slug}/${body.repo}`);
      repositoryId = route?.id ?? null;
    }
    const id = newPrefixedId("sec");
    await insertSecurityTest(c.var.db, {
      id,
      namespaceId: ns.id,
      repositoryId,
      kind: body.kind,
      target: body.target.trim(),
      status: "queued",
      findings: 0,
      report: null,
      createdBy: ns.userId,
      createdAt: Date.now(),
      finishedAt: null,
    });
    return c.json({ id }, 201);
  });

  router.post("/api/v1/spaces/:space_ref{.+}/security-tests/:id/result", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findSecurityTest(c.var.db, c.req.param("id"));
    if (!row || row.namespaceId !== ns.id) return gNotFound(c, "test");
    const body = (await c.req.json().catch(() => null)) as {
      status?: string;
      findings?: number;
      report?: Record<string, unknown>;
    } | null;
    if (!body?.status || !["pass", "fail", "running"].includes(body.status)) {
      return gErr(c, 400, "status pass|fail|running required");
    }
    await updateSecurityTest(c.var.db, row.id, {
      status: body.status,
      findings: body.findings ?? row.findings,
      report: body.report ? JSON.stringify(body.report) : row.report,
      finishedAt: body.status === "running" ? row.finishedAt : Date.now(),
    });
    return c.json({});
  });

  // --- supply-chain documents ----------------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/supply-chain", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listSupplyChainDocs(c.var.db, ns.id);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        repository_id: r.repositoryId,
        commit_oid: r.commitOid,
        created_by: r.createdBy,
        created: r.createdAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/supply-chain", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      kind?: string;
      repo?: string;
      commit_oid?: string;
      document?: Record<string, unknown>;
    } | null;
    if (!body?.kind || !body?.repo || !body.document) {
      return gErr(c, 400, "kind + repo + document required");
    }
    const route = await findRepositoryByDoName(c.var.db, `${ns.slug}/${body.repo}`);
    if (!route) return gNotFound(c, "repository");
    const id = newPrefixedId("sc");
    await insertSupplyChainDoc(c.var.db, {
      id,
      namespaceId: ns.id,
      repositoryId: route.id,
      kind: body.kind,
      commitOid: body.commit_oid ?? null,
      document: JSON.stringify(body.document),
      createdBy: ns.userId,
      createdAt: Date.now(),
    });
    return c.json({ id }, 201);
  });

  router.get("/api/v1/spaces/:space_ref{.+}/supply-chain/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findSupplyChainDoc(c.var.db, c.req.param("id"));
    if (!row || row.namespaceId !== ns.id) return gNotFound(c, "document");
    return c.json({
      id: row.id,
      kind: row.kind,
      commit_oid: row.commitOid,
      document: JSON.parse(row.document) as Record<string, unknown>,
      created: row.createdAt,
    });
  });

  // --- dashboards ------------------------------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/dashboards", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listDashboards(c.var.db, ns.id);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        identifier: r.identifier,
        layout: JSON.parse(r.layout) as unknown[],
        created: r.createdAt,
        updated: r.updatedAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/dashboards", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      layout?: unknown[];
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !isValidOwnerRepo(identifier)) {
      return gErr(c, 400, "valid identifier required");
    }
    const now = Date.now();
    await insertDashboard(c.var.db, {
      id: newPrefixedId("dsh"),
      namespaceId: ns.id,
      identifier,
      layout: JSON.stringify(body?.layout ?? []),
      createdBy: ns.userId,
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ identifier }, 201);
  });

  router.put("/api/v1/spaces/:space_ref{.+}/dashboards/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as { layout?: unknown[] } | null;
    await updateDashboard(c.var.db, c.req.param("id"), {
      layout: JSON.stringify(body?.layout ?? []),
      updatedAt: Date.now(),
    });
    return c.json({});
  });

  // --- dev insights (real aggregates over platform data) ------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/insights", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const [repos, members, tests, incidents, monitors, artifacts] = await Promise.all([
      listRepositoriesForNamespace(c.var.db, ns.id, ns.userId),
      listMembershipsForNamespace(c.var.db, ns.id),
      listSecurityTests(c.var.db, ns.id),
      listIncidents(c.var.db, ns.id),
      listMonitors(c.var.db, ns.id),
      listArtifactsForNamespace(c.var.db, ns.id),
    ]);
    const now = Date.now();
    const week = 7 * 86400_000;

    // SEI metrics from repo DO state (bounded to the first 100 repos):
    // weekly receive-ops from the op-log, plus merge-intent lead time.
    let pushesWeek = 0;
    let mergesWeek = 0;
    let leadTimeTotalMs = 0;
    let leadTimeCount = 0;
    for (const repo of repos.slice(0, 100)) {
      const stub = getRepoStub(c.env, repo.doName);
      const [ops, intents] = await Promise.all([
        stub.listOpLog(-1),
        stub.listMergeIntents(["merged"]),
      ]);
      pushesWeek += ops.filter((o) => o.kind === "receive" && o.createdAt > now - week).length;
      for (const intent of intents) {
        if (intent.resolvedAt !== null && intent.resolvedAt > now - week) {
          mergesWeek++;
          leadTimeTotalMs += intent.resolvedAt - intent.createdAt;
          leadTimeCount++;
        }
      }
    }

    return c.json({
      repositories: repos.length,
      members: members.length,
      artifacts: artifacts.length,
      monitors_up: monitors.filter((m) => m.lastStatus === "up").length,
      monitors_down: monitors.filter((m) => m.lastStatus === "down").length,
      open_incidents: incidents.filter((i) => i.status === "open").length,
      security_tests_week: tests.filter((t) => t.createdAt > now - week).length,
      security_findings_week: tests
        .filter((t) => t.createdAt > now - week)
        .reduce((n, t) => n + t.findings, 0),
      // Real SEI aggregates — not synthesized.
      pushes_week: pushesWeek,
      merges_week: mergesWeek,
      merge_lead_time_ms: leadTimeCount > 0 ? Math.round(leadTimeTotalMs / leadTimeCount) : null,
    });
  });
}

// --- disaster-recovery snapshot ---------------------------------------------------
//
// GET /spaces/{ref}/dr-snapshot — metadata-level backup of every repo the
// caller can read in the space: refs, op-log tip hash (chain-verifiable via
// /dg/oplog/verify), visibility/encryption flags, and registry counts. Git
// object durability is R2's job; this captures the metadata + audit tips
// needed to detect loss or tampering after a restore.

export function registerGitnessDr(router: AppRouter) {
  router.get("/api/v1/spaces/:space_ref{.+}/dr-snapshot", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const repos = await listRepositoriesForNamespace(c.var.db, ns.id, ns.userId);
    const snapshots = await Promise.all(
      repos.slice(0, 100).map(async (r) => {
        const stub = getRepoStub(c.env, r.doName);
        const [refs, tip] = await Promise.all([stub.getHeadAndRefs(), stub.listOpLog(-1)]);
        const last = tip.length > 0 ? tip[tip.length - 1]! : null;
        return {
          repo: r.slug,
          do_name: r.doName,
          visibility: r.visibility,
          encrypted: r.encrypted === 1,
          head: refs.head,
          refs: refs.refs.map((r) => `${r.name}=${r.oid}`),
          op_log_tip: last ? { seq: last.seq, hash: last.hash } : null,
        };
      })
    );
    return c.json({
      space: ns.slug,
      captured_at: Date.now(),
      repositories: snapshots,
      counts: {
        repositories: snapshots.length,
        encrypted: snapshots.filter((s) => s.encrypted).length,
        private: snapshots.filter((s) => s.visibility === "private").length,
      },
    });
  });
}
