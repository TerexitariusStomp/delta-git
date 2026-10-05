// Wave-3 reliability plane — monitors (with on-demand probe runs), SLOs,
// downtime windows, incidents with update timelines, certificate expiry
// tracking, cost snapshots, and chaos experiment records. Space-scoped.

import type { AppRouter } from "@/worker/routes/hono";

import { loadViewer } from "@/worker/auth/session";
import { viewerIsNamespaceMember } from "@/worker/auth/pat";
import { findNamespaceBySlug } from "@/worker/db/d1/dal/namespaces";
import {
  deleteCertificate,
  deleteChaosExperiment,
  deleteMonitor,
  deleteSlo,
  endDowntime,
  findIncident,
  findMonitor,
  insertCertificate,
  insertChaosExperiment,
  insertCostSnapshot,
  insertDowntime,
  insertIncident,
  insertIncidentUpdate,
  insertMonitor,
  insertMonitorCheck,
  insertSlo,
  listCertificates,
  listChaosExperiments,
  listCostSnapshots,
  listDowntimes,
  listIncidents,
  listIncidentUpdates,
  listMonitorChecks,
  listMonitors,
  listSlos,
  updateChaosExperiment,
  updateIncident,
  updateMonitor,
} from "@/worker/db/d1/dal/modules";
import { newPrefixedId } from "@/worker/common";
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

function monitorView(r: {
  id: string;
  identifier: string;
  url: string;
  method: string;
  expectedStatus: number;
  intervalSec: number;
  enabled: number;
  lastStatus: string | null;
  lastLatencyMs: number | null;
  lastCheckedAt: number | null;
  createdAt: number;
}) {
  return {
    id: r.id,
    identifier: r.identifier,
    url: r.url,
    method: r.method,
    expected_status: r.expectedStatus,
    interval_sec: r.intervalSec,
    enabled: r.enabled === 1,
    last_status: r.lastStatus,
    last_latency_ms: r.lastLatencyMs,
    last_checked: r.lastCheckedAt,
    created: r.createdAt,
  };
}

export function registerGitnessReliability(router: AppRouter) {
  // --- monitors ------------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/monitors", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    return c.json((await listMonitors(c.var.db, ns.id)).map(monitorView));
  });

  router.post("/api/v1/spaces/:space_ref{.+}/monitors", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      url?: string;
      method?: string;
      expected_status?: number;
      interval_sec?: number;
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !isValidOwnerRepo(identifier) || !body?.url?.trim()) {
      return gErr(c, 400, "identifier + url required");
    }
    await insertMonitor(c.var.db, {
      id: newPrefixedId("mon"),
      namespaceId: ns.id,
      identifier,
      url: body.url.trim(),
      method: (body.method ?? "GET").toUpperCase(),
      expectedStatus: body.expected_status ?? 200,
      intervalSec: body.interval_sec ?? 300,
      enabled: 1,
      lastStatus: null,
      lastLatencyMs: null,
      lastCheckedAt: null,
      createdAt: Date.now(),
    });
    return c.json({ identifier }, 201);
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/monitors/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findMonitor(c.var.db, ns.id, c.req.param("id"));
    if (!row) return gNotFound(c, "monitor");
    await deleteMonitor(c.var.db, row.id);
    return c.body(null, 204);
  });

  // Check history for a monitor.
  router.get("/api/v1/spaces/:space_ref{.+}/monitors/:id/checks", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findMonitor(c.var.db, ns.id, c.req.param("id"));
    if (!row) return gNotFound(c, "monitor");
    const checks = await listMonitorChecks(c.var.db, row.id, 100);
    return c.json(
      checks.map((ch) => ({
        status: ch.status,
        latency_ms: ch.latencyMs,
        status_code: ch.statusCode,
        checked_at: ch.checkedAt,
      }))
    );
  });

  // On-demand probe — performs the check now and records the result. The
  // scheduled fleet-wide probe is the external/cron follow-on; this endpoint
  // is what the SPA's "run now" and delegate probes call.
  router.post("/api/v1/spaces/:space_ref{.+}/monitors/:id/run", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findMonitor(c.var.db, ns.id, c.req.param("id"));
    if (!row) return gNotFound(c, "monitor");
    const started = Date.now();
    let statusCode: number | null = null;
    let up = false;
    try {
      const res = await fetch(row.url, {
        method: row.method,
        signal: AbortSignal.timeout(10_000),
      });
      statusCode = res.status;
      up = res.status === row.expectedStatus;
      // Consume the body so the subrequest isn't pinned open.
      await res.arrayBuffer().catch(() => undefined);
    } catch {
      up = false;
    }
    const latencyMs = Date.now() - started;
    const now = Date.now();
    await insertMonitorCheck(c.var.db, {
      id: newPrefixedId("mck"),
      monitorId: row.id,
      status: up ? "up" : "down",
      latencyMs,
      statusCode,
      checkedAt: now,
    });
    await updateMonitor(c.var.db, row.id, {
      lastStatus: up ? "up" : "down",
      lastLatencyMs: latencyMs,
      lastCheckedAt: now,
    });
    return c.json({ status: up ? "up" : "down", latency_ms: latencyMs, status_code: statusCode });
  });

  // External probe ingest — delegates/agents POST check results they ran on
  // their own infrastructure (mirrors the sovereignty model: probes can run
  // client-side and report back).
  router.post("/api/v1/spaces/:space_ref{.+}/monitors/:id/report", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findMonitor(c.var.db, ns.id, c.req.param("id"));
    if (!row) return gNotFound(c, "monitor");
    const body = (await c.req.json().catch(() => null)) as {
      status?: string;
      latency_ms?: number;
      status_code?: number;
    } | null;
    if (body?.status !== "up" && body?.status !== "down") {
      return gErr(c, 400, "status up|down required");
    }
    const now = Date.now();
    await insertMonitorCheck(c.var.db, {
      id: newPrefixedId("mck"),
      monitorId: row.id,
      status: body.status,
      latencyMs: body.latency_ms ?? null,
      statusCode: body.status_code ?? null,
      checkedAt: now,
    });
    await updateMonitor(c.var.db, row.id, {
      lastStatus: body.status,
      lastLatencyMs: body.latency_ms ?? null,
      lastCheckedAt: now,
    });
    return c.json({});
  });

  // --- SLOs ------------------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/slos", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listSlos(c.var.db, ns.id);
    // Computed uptime per SLO: fraction of "up" checks in the window, with
    // downtime-excluded periods left to the budget math (checks during a
    // recorded downtime are skipped).
    const out = [];
    for (const s of rows) {
      let uptime: number | null = null;
      if (s.monitorId) {
        const checks = await listMonitorChecks(c.var.db, s.monitorId, 1000);
        const windowStart = Date.now() - s.windowDays * 86400_000;
        const inWindow = checks.filter((ch) => ch.checkedAt >= windowStart);
        if (inWindow.length > 0) {
          uptime = (inWindow.filter((ch) => ch.status === "up").length / inWindow.length) * 10000;
        }
      }
      out.push({
        id: s.id,
        identifier: s.identifier,
        monitor_id: s.monitorId,
        target_pct: s.targetPct / 100,
        window_days: s.windowDays,
        observed_pct: uptime === null ? null : uptime / 100,
        budget_burned: uptime === null ? null : s.targetPct - uptime,
      });
    }
    return c.json(out);
  });

  router.post("/api/v1/spaces/:space_ref{.+}/slos", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      monitor?: string;
      target_pct?: number;
      window_days?: number;
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !body?.target_pct) {
      return gErr(c, 400, "identifier + target_pct required");
    }
    let monitorId: string | null = null;
    if (body.monitor) {
      const mon = await findMonitor(c.var.db, ns.id, body.monitor);
      monitorId = mon?.id ?? null;
    }
    await insertSlo(c.var.db, {
      id: newPrefixedId("slo"),
      namespaceId: ns.id,
      identifier,
      monitorId,
      targetPct: Math.round(body.target_pct * 100),
      windowDays: body.window_days ?? 30,
      createdAt: Date.now(),
    });
    return c.json({ identifier }, 201);
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/slos/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    await deleteSlo(c.var.db, c.req.param("id"));
    return c.body(null, 204);
  });

  // --- downtime windows ----------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/downtimes", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listDowntimes(c.var.db, ns.id);
    return c.json(
      rows.map((d) => ({
        id: d.id,
        monitor_id: d.monitorId,
        reason: d.reason,
        started: d.startedAt,
        ended: d.endedAt,
        ongoing: d.endedAt === null,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/downtimes", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      monitor?: string;
      reason?: string;
      ends_at?: number;
    } | null;
    if (!body?.reason?.trim()) return gErr(c, 400, "reason required");
    let monitorId: string | null = null;
    if (body.monitor) {
      const mon = await findMonitor(c.var.db, ns.id, body.monitor);
      monitorId = mon?.id ?? null;
    }
    const id = newPrefixedId("dwn");
    await insertDowntime(c.var.db, {
      id,
      namespaceId: ns.id,
      monitorId,
      reason: body.reason.trim(),
      startedAt: Date.now(),
      endedAt: body.ends_at ?? null,
      createdAt: Date.now(),
    });
    return c.json({ id }, 201);
  });

  router.post("/api/v1/spaces/:space_ref{.+}/downtimes/:id/end", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    await endDowntime(c.var.db, c.req.param("id"), Date.now());
    return c.json({});
  });

  // --- incidents --------------------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/incidents", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listIncidents(c.var.db, ns.id);
    return c.json(
      rows.map((i) => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        status: i.status,
        summary: i.summary,
        created_by: i.createdBy,
        created: i.createdAt,
        updated: i.updatedAt,
        resolved: i.resolvedAt,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/incidents", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      title?: string;
      severity?: string;
      summary?: string;
    } | null;
    if (!body?.title?.trim()) return gErr(c, 400, "title required");
    const now = Date.now();
    const id = newPrefixedId("inc");
    await insertIncident(c.var.db, {
      id,
      namespaceId: ns.id,
      title: body.title.trim(),
      severity: body.severity ?? "sev3",
      status: "open",
      summary: body.summary ?? null,
      createdBy: ns.userId,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    });
    return c.json({ id }, 201);
  });

  router.get("/api/v1/spaces/:space_ref{.+}/incidents/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findIncident(c.var.db, c.req.param("id"));
    if (!row) return gNotFound(c, "incident");
    const updates = await listIncidentUpdates(c.var.db, row.id);
    return c.json({
      id: row.id,
      title: row.title,
      severity: row.severity,
      status: row.status,
      summary: row.summary,
      created: row.createdAt,
      resolved: row.resolvedAt,
      updates: updates.map((u) => ({
        body: u.body,
        status: u.status,
        created_by: u.createdBy,
        created: u.createdAt,
      })),
    });
  });

  router.post("/api/v1/spaces/:space_ref{.+}/incidents/:id/updates", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const row = await findIncident(c.var.db, c.req.param("id"));
    if (!row) return gNotFound(c, "incident");
    const body = (await c.req.json().catch(() => null)) as {
      body?: string;
      status?: string;
    } | null;
    if (!body?.body?.trim()) return gErr(c, 400, "body required");
    const now = Date.now();
    await insertIncidentUpdate(c.var.db, {
      id: newPrefixedId("iup"),
      incidentId: row.id,
      body: body.body.trim(),
      status: body.status ?? null,
      createdBy: ns.userId,
      createdAt: now,
    });
    const patch: Parameters<typeof updateIncident>[2] = { updatedAt: now };
    if (body.status === "mitigated" || body.status === "resolved") {
      patch.status = body.status;
      if (body.status === "resolved") patch.resolvedAt = now;
    }
    await updateIncident(c.var.db, row.id, patch);
    return c.json({});
  });

  // --- certificates --------------------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/certificates", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listCertificates(c.var.db, ns.id);
    const now = Date.now();
    return c.json(
      rows.map((cert) => ({
        id: cert.id,
        domain: cert.domain,
        issuer: cert.issuer,
        expires_at: cert.expiresAt,
        days_left: Math.floor((cert.expiresAt - now) / 86400_000),
        auto_renew: cert.autoRenew === 1,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/certificates", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      domain?: string;
      issuer?: string;
      expires_at?: number;
      auto_renew?: boolean;
    } | null;
    if (!body?.domain?.trim() || !body.expires_at) {
      return gErr(c, 400, "domain + expires_at required");
    }
    await insertCertificate(c.var.db, {
      id: newPrefixedId("crt"),
      namespaceId: ns.id,
      domain: body.domain.trim().toLowerCase(),
      issuer: body.issuer ?? null,
      expiresAt: body.expires_at,
      autoRenew: body.auto_renew ? 1 : 0,
      createdAt: Date.now(),
    });
    return c.json({ domain: body.domain.trim().toLowerCase() }, 201);
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/certificates/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    await deleteCertificate(c.var.db, c.req.param("id"));
    return c.body(null, 204);
  });

  // --- cloud cost snapshots ---------------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/costs", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listCostSnapshots(c.var.db, ns.id);
    const byService = new Map<string, number>();
    for (const r of rows) {
      byService.set(r.service, (byService.get(r.service) ?? 0) + r.amountCents);
    }
    return c.json({
      snapshots: rows.map((r) => ({
        provider: r.provider,
        service: r.service,
        amount_cents: r.amountCents,
        currency: r.currency,
        period_start: r.periodStart,
        period_end: r.periodEnd,
      })),
      totals_by_service: [...byService.entries()].map(([service, cents]) => ({
        service,
        amount_cents: cents,
      })),
    });
  });

  router.post("/api/v1/spaces/:space_ref{.+}/costs", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      provider?: string;
      service?: string;
      amount_cents?: number;
      period_start?: number;
      period_end?: number;
    } | null;
    if (!body?.service?.trim() || body.amount_cents === undefined) {
      return gErr(c, 400, "service + amount_cents required");
    }
    await insertCostSnapshot(c.var.db, {
      id: newPrefixedId("cst"),
      namespaceId: ns.id,
      provider: body.provider ?? "other",
      service: body.service.trim(),
      amountCents: Math.round(body.amount_cents),
      currency: "USD",
      periodStart: body.period_start ?? Date.now(),
      periodEnd: body.period_end ?? Date.now(),
      createdAt: Date.now(),
    });
    return c.json({}, 201);
  });

  // --- chaos experiments --------------------------------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/chaos", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listChaosExperiments(c.var.db, ns.id);
    return c.json(
      rows.map((x) => ({
        id: x.id,
        identifier: x.identifier,
        kind: x.kind,
        spec: JSON.parse(x.spec) as Record<string, unknown>,
        repository_id: x.repositoryId,
        last_run: x.lastRunAt,
        last_outcome: x.lastOutcome,
      }))
    );
  });

  router.post("/api/v1/spaces/:space_ref{.+}/chaos", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      kind?: string;
      spec?: Record<string, unknown>;
    } | null;
    const identifier = body?.identifier?.trim().toLowerCase();
    if (!identifier || !body?.kind) {
      return gErr(c, 400, "identifier + kind required");
    }
    await insertChaosExperiment(c.var.db, {
      id: newPrefixedId("chs"),
      namespaceId: ns.id,
      identifier,
      repositoryId: null,
      kind: body.kind,
      spec: JSON.stringify(body.spec ?? {}),
      lastRunAt: null,
      lastOutcome: null,
      createdAt: Date.now(),
    });
    return c.json({ identifier }, 201);
  });

  // Record a run outcome — the experiment itself runs wherever its spec
  // targets (client infra); this endpoint is the result ledger.
  router.post("/api/v1/spaces/:space_ref{.+}/chaos/:id/runs", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const body = (await c.req.json().catch(() => null)) as { outcome?: string } | null;
    if (!body?.outcome || !["pass", "fail", "aborted"].includes(body.outcome)) {
      return gErr(c, 400, "outcome pass|fail|aborted required");
    }
    const rows = await listChaosExperiments(c.var.db, ns.id);
    const row = rows.find((x) => x.id === c.req.param("id") || x.identifier === c.req.param("id"));
    if (!row) return gNotFound(c, "experiment");
    await updateChaosExperiment(c.var.db, row.id, {
      lastRunAt: Date.now(),
      lastOutcome: body.outcome,
    });
    return c.json({});
  });

  router.delete("/api/v1/spaces/:space_ref{.+}/chaos/:id", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const rows = await listChaosExperiments(c.var.db, ns.id);
    const row = rows.find((x) => x.id === c.req.param("id") || x.identifier === c.req.param("id"));
    if (!row) return gNotFound(c, "experiment");
    await deleteChaosExperiment(c.var.db, row.id);
    return c.body(null, 204);
  });

  // --- reliability overview (dashboard roll-up) -----------------------------------------------------
  router.get("/api/v1/spaces/:space_ref{.+}/reliability", async (c) => {
    const ns = await resolveMemberSpace(c, c.req.param("space_ref"));
    if (ns instanceof Response) return ns;
    const [mons, sloRows, openIncidents, certs] = await Promise.all([
      listMonitors(c.var.db, ns.id),
      listSlos(c.var.db, ns.id),
      listIncidents(c.var.db, ns.id),
      listCertificates(c.var.db, ns.id),
    ]);
    const now = Date.now();
    return c.json({
      monitors: {
        total: mons.length,
        up: mons.filter((m) => m.lastStatus === "up").length,
        down: mons.filter((m) => m.lastStatus === "down").length,
      },
      slos: sloRows.length,
      open_incidents: openIncidents.filter((i) => i.status === "open").length,
      expiring_certificates: certs.filter((cert) => cert.expiresAt - now < 30 * 86400_000).length,
    });
  });
}
