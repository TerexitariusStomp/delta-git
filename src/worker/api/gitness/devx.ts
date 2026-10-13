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
import { workspaceSandbox } from "@/worker/compute/sandbox";
import { openRepoTar } from "@/worker/routes/archive";
import { findRepositoryById } from "@/worker/db/d1/dal/repositories";
import { createLogger } from "@/worker/common/logger";
import { cfApi } from "@/worker/common/cloudflareApi";
import type { DevEnvironmentRow } from "@/worker/db/d1/schema/devx";

const log = createLogger(undefined, { service: "DevxWorkspaces" });

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

  // --- workspace surface (running environments only) ---------------------------------
  //
  // exec / files / preview all require the owning space's membership —
  // workspace previews are authenticated by default (see docs/security.md).

  /** Resolve the sandbox for a *running* env owned by this space. */
  async function runningEnv(
    c: GitnessContext
  ): Promise<{ ns: { id: string; slug: string }; row: DevEnvironmentRow } | Response> {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref") ?? "");
    if (ns instanceof Response) return ns;
    const rows = await listDevEnvironments(c.var.db, ns.id);
    const row = rows.find((r) => r.id === c.req.param("id") || r.identifier === c.req.param("id"));
    if (!row) return gNotFound(c, "environment");
    if (row.status !== "running") return gErr(c, 409, "environment is not running");
    await updateDevEnvironment(c.var.db, row.id, { lastUsedAt: Date.now() }).catch(() => undefined);
    return { ns, row };
  }

  // Command exec — one-shot shell commands in the staged worktree. The SPA
  // terminal panel drives this; it is intentionally request/response
  // rather than a pty so the audit trail stays simple.
  router.post("/api/v1/spaces/:space_ref{.+}/dev-environments/:id/exec", async (c) => {
    const resolved = await runningEnv(c);
    if (resolved instanceof Response) return resolved;
    const body = (await c.req.json().catch(() => null)) as { command?: string } | null;
    const command = body?.command?.trim();
    if (!command) return gErr(c, 400, "command required");
    const sandbox = workspaceSandbox(c.env, resolved.ns.slug, resolved.row.id);
    const result = await sandbox
      .exec(`cd /workspace/repo 2>/dev/null || cd /workspace; ${command}`, { timeout: 60_000 })
      .catch(() => null);
    if (!result) return gErr(c, 502, "workspace unreachable");
    return c.json({
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  });

  // File read/list for the browser workspace panel.
  router.get("/api/v1/spaces/:space_ref{.+}/dev-environments/:id/workspace", async (c) => {
    const resolved = await runningEnv(c);
    if (resolved instanceof Response) return resolved;
    const path = c.req.query("path") ?? "/workspace/repo";
    const sandbox = workspaceSandbox(c.env, resolved.ns.slug, resolved.row.id);
    const listing = await sandbox.listFiles(path).catch(() => null);
    if (listing?.success) {
      return c.json({ path, entries: listing.files ?? [] });
    }
    // Not a directory — try reading it as a file.
    const file = await sandbox.readFile(path, { encoding: "utf-8" }).catch(() => null);
    if (file && file.success && typeof file.content === "string") {
      return c.json({ path, content: file.content });
    }
    return gErr(c, 404, "path not found");
  });

  router.put("/api/v1/spaces/:space_ref{.+}/dev-environments/:id/workspace", async (c) => {
    const resolved = await runningEnv(c);
    if (resolved instanceof Response) return resolved;
    const path = c.req.query("path");
    if (!path) return gErr(c, 400, "path required");
    const content = await c.req.text();
    const sandbox = workspaceSandbox(c.env, resolved.ns.slug, resolved.row.id);
    const write = await sandbox.writeFile(path, content).catch(() => null);
    if (!write?.success) return gErr(c, 502, "write failed");
    return c.json({ path, bytes: content.length });
  });

  // Preview proxy — authenticated forwarding to a port inside the user's
  // own workspace container (`?port=`; path suffix via `?path=`).
  router.get("/api/v1/spaces/:space_ref{.+}/dev-environments/:id/preview", async (c) => {
    const resolved = await runningEnv(c);
    if (resolved instanceof Response) return resolved;
    const port = parseInt(c.req.query("port") ?? "8080", 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return gErr(c, 400, "port must be 1024-65535");
    }
    const path = c.req.query("path") ?? "/";
    if (!path.startsWith("/")) return gErr(c, 400, "path must be absolute");
    const sandbox = workspaceSandbox(c.env, resolved.ns.slug, resolved.row.id);
    const upstream = await sandbox
      .containerFetch(`http://localhost:${port}${path}`, { method: "GET" }, port)
      .catch(() => null);
    if (!upstream) return gErr(c, 502, "preview unreachable");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  });

  router.post("/api/v1/spaces/:space_ref{.+}/dev-environments/:id/:action", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const action = c.req.param("action");
    if (action !== "start" && action !== "stop") return gErr(c, 400, "start|stop");
    const rows = await listDevEnvironments(c.var.db, ns.id);
    const row = rows.find((r) => r.id === c.req.param("id") || r.identifier === c.req.param("id"));
    if (!row) return gNotFound(c, "environment");

    if (action === "stop") {
      // Kill any running processes; the container auto-sleeps on its own
      // inactivity timer, so there's no explicit destroy call to miss.
      const sandbox = workspaceSandbox(c.env, ns.slug, row.id);
      const killed = await sandbox.killAllProcesses().catch((err: unknown) => {
        log.warn("devenv:stop-kill-failed", { envId: row.id, error: String(err) });
        return -1;
      });
      await updateDevEnvironment(c.var.db, row.id, { status: "stopped" });
      return c.json({ status: "stopped", killed_processes: killed });
    }

    // start — provision the workspace container and stage the linked
    // repo's worktree so the environment opens at a usable checkout.
    await updateDevEnvironment(c.var.db, row.id, { status: "provisioning" });
    try {
      const sandbox = workspaceSandbox(c.env, ns.slug, row.id);
      let staged: { repo?: string; files?: number } = {};
      if (row.repositoryId) {
        const repo = await findRepositoryById(c.var.db, row.repositoryId);
        if (repo) {
          const stub = getRepoStub(c.env, repo.doName);
          const { refs, head } = await stub.getHeadAndRefs();
          const commitOid =
            (head.target ? refs.find((r) => r.name === head.target)?.oid : undefined) ??
            refs.find((r) => r.name === "refs/heads/main")?.oid ??
            refs[0]?.oid;
          if (commitOid) {
            const tar = await openRepoTar({
              env: c.env,
              doName: repo.doName,
              commitOid,
              cacheCtx: c.var.cacheCtx,
              log,
            });
            if (tar) {
              const write = await sandbox.writeFile("/workspace/repo.tar", tar.readable);
              if (!write.success) throw new Error("worktree upload failed");
              const unpack = await sandbox.exec(
                "mkdir -p /workspace/repo && tar -xf /workspace/repo.tar -C /workspace/repo && rm -f /workspace/repo.tar",
                { timeout: 120_000 }
              );
              if (!unpack.success) {
                throw new Error(`worktree extract failed (exit ${unpack.exitCode})`);
              }
              await tar.done.catch(() => undefined);
              staged = { repo: repo.doName, files: tar.files };
            }
          }
        }
      }
      await updateDevEnvironment(c.var.db, row.id, {
        status: "running",
        lastUsedAt: Date.now(),
      });
      log.info("devenv:started", { envId: row.id, namespace: ns.slug, ...staged });
      return c.json({ status: "running", staged });
    } catch (error) {
      await updateDevEnvironment(c.var.db, row.id, { status: "error" }).catch(() => undefined);
      log.warn("devenv:start-failed", {
        envId: row.id,
        namespace: ns.slug,
        error: String(error),
      });
      return gErr(
        c,
        500,
        `environment failed to start: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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

  // Provision — `engine: "d1"` (the default) creates a real D1 database on
  // the platform account and stores its uuid in `host` (the connection
  // handle, never credentials). Other engines stay BYO record-tracked —
  // we can't provision someone's external postgres from here, so `status:
  // external` says so honestly.
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
    const engine = body?.engine ?? "d1";

    let host: string | null = body?.host ?? null;
    let status = "external";
    if (engine === "d1") {
      const name = `dg-${ns.slug}-${identifier}`.slice(0, 63);
      const created = await cfApi(c.env, "/d1/database", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      if (!created.configured) {
        return gErr(
          c,
          503,
          "platform database provisioning unavailable (CF_API_TOKEN not configured)"
        );
      }
      if (!created.ok) {
        return gErr(c, 502, `d1 create failed: ${created.errors.join(", ") || "unknown"}`);
      }
      const result = created.result as { uuid?: string; name?: string } | undefined;
      if (!result?.uuid) return gErr(c, 502, "d1 create returned no uuid");
      host = result.uuid;
      status = "provisioned";
    }

    await insertDatabaseRecord(c.var.db, {
      id: newPrefixedId("db"),
      namespaceId: ns.id,
      identifier,
      engine,
      host,
      status,
      migrations: "[]",
      createdAt: Date.now(),
    });
    return c.json({ identifier, engine, status }, 201);
  });

  /** Run one or more SQL statements against a provisioned D1 database. */
  async function queryPlatformD1(
    c: GitnessContext,
    host: string,
    sql: string
  ): Promise<{ ok: boolean; result?: unknown; error?: Response }> {
    const res = await cfApi(c.env, `/d1/database/${host}/query`, {
      method: "POST",
      body: JSON.stringify({ sql }),
    });
    if (!res.configured) {
      return {
        ok: false,
        error: gErr(c, 503, "platform database access unavailable (CF_API_TOKEN not configured)"),
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: gErr(c, 502, `d1 query failed: ${res.errors.join(", ") || `http ${res.status}`}`),
      };
    }
    return { ok: true, result: res.result };
  }

  // Apply a migration — for platform D1 records the `statements` SQL runs
  // for real and the ledger entry is only appended on success. External
  // records keep the ledger-only behavior (the SQL ran on the client's
  // own database).
  router.post("/api/v1/spaces/:space_ref{.+}/databases/:id/migrations", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findDatabaseRecord(c.var.db, ns.id, c.req.param("id"));
    if (!row) return gNotFound(c, "database");
    const body = (await c.req.json().catch(() => null)) as {
      version?: string;
      statements?: string;
    } | null;
    if (!body?.version?.trim()) return gErr(c, 400, "version required");

    if (row.engine === "d1" && row.host) {
      if (!body.statements?.trim()) {
        return gErr(c, 400, "statements required for platform D1 databases");
      }
      const ran = await queryPlatformD1(c, row.host, body.statements);
      if (!ran.ok) return ran.error!;
    }

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

  // SQL console — executes against the provisioned D1 database. Member-
  // gated by the same space check as every other mutating surface.
  router.post("/api/v1/spaces/:space_ref{.+}/databases/:id/console", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findDatabaseRecord(c.var.db, ns.id, c.req.param("id"));
    if (!row) return gNotFound(c, "database");
    if (row.engine !== "d1" || !row.host) {
      return gErr(c, 400, "console is only available for platform D1 databases");
    }
    const body = (await c.req.json().catch(() => null)) as { sql?: string } | null;
    if (!body?.sql?.trim()) return gErr(c, 400, "sql required");
    const ran = await queryPlatformD1(c, row.host, body.sql);
    if (!ran.ok) return ran.error!;
    return c.json({ result: ran.result });
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/databases/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findDatabaseRecord(c.var.db, ns.id, c.req.param("id"));
    if (!row) return gNotFound(c, "database");
    if (row.engine === "d1" && row.host) {
      // Delete the real database first — if that fails the record stays so
      // the remote isn't orphaned silently.
      const dropped = await cfApi(c.env, `/d1/database/${row.host}`, { method: "DELETE" });
      if (dropped.configured && !dropped.ok) {
        return gErr(
          c,
          502,
          `d1 delete failed: ${dropped.errors.join(", ") || `http ${dropped.status}`}`
        );
      }
      // Unconfigured platform → can't reach the remote; still drop the row
      // but flag it so the operator knows a remote may linger.
      if (!dropped.configured) {
        log.warn("db:remote-orphaned", { dbId: row.id, reason: "cf-credentials-missing" });
      }
    }
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
    if (repositoryId) {
      // Repo-backed targets get a REAL platform scan — the sandbox image's
      // pinned gitleaks/trivy/osv-scanner run against a staged worktree.
      // Non-repo targets stay queued for client delegates via /result.
      await c.env.REPO_TASKS_QUEUE.send({ kind: "security-scan", testId: id });
    }
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
    if (!body?.kind || !body?.repo) {
      return gErr(c, 400, "kind + repo required");
    }
    const route = await findRepositoryByDoName(c.var.db, `${ns.slug}/${body.repo}`);
    if (!route) return gNotFound(c, "repository");
    const id = newPrefixedId("sc");
    // No document → the platform builds a real one: syft for `sbom`, a
    // DSSE-signed in-toto statement for `provenance`/`attestation`. A
    // supplied document is stored as-is (client-generated artifact).
    const generating = body.document === undefined;
    await insertSupplyChainDoc(c.var.db, {
      id,
      namespaceId: ns.id,
      repositoryId: route.id,
      kind: body.kind,
      commitOid: body.commit_oid ?? null,
      document: generating
        ? JSON.stringify({ status: "generating", kind: body.kind })
        : JSON.stringify(body.document),
      createdBy: ns.userId,
      createdAt: Date.now(),
    });
    if (generating) {
      await c.env.REPO_TASKS_QUEUE.send({ kind: "supply-chain-build", docId: id });
    }
    return c.json({ id, status: generating ? "generating" : "stored" }, 201);
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
        private: snapshots.filter((s) => s.visibility !== "public").length,
      },
    });
  });
}
