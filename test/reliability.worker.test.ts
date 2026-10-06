import { describe, it, expect, beforeAll } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";
import { uniqueRepoId } from "./util/test-helpers";

let seeded: SetupRepoForTestsResult;
let owner: string;

async function req(path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  await ensureD1Migrations(env);
  owner = `rel-${Math.random().toString(36).slice(2, 8)}`;
  seeded = await setupRepoForTests(env, owner, uniqueRepoId("relrepo"));
});

describe("monitors", () => {
  it("creates a monitor, ingests probe reports, and serves check history", async () => {
    const create = await req(`/api/v1/spaces/${owner}/monitors`, {
      method: "POST",
      body: { identifier: "edge", url: "https://example.com/health", expected_status: 200 },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    // Delegate-style probe report.
    const report = await req(`/api/v1/spaces/${owner}/monitors/edge/report`, {
      method: "POST",
      body: { status: "up", latency_ms: 42, status_code: 200 },
      cookie: seeded.cookieHeader,
    });
    expect(report.status).toBe(200);

    const list = await req(`/api/v1/spaces/${owner}/monitors`, {
      cookie: seeded.cookieHeader,
    });
    const mon = (list.body as { identifier: string; last_status: string }[]).find(
      (m) => m.identifier === "edge"
    )!;
    expect(mon.last_status).toBe("up");

    const checks = await req(`/api/v1/spaces/${owner}/monitors/edge/checks`, {
      cookie: seeded.cookieHeader,
    });
    expect((checks.body as { status: string }[]).length).toBe(1);
  });
});

describe("slos + downtime", () => {
  it("computes observed uptime from check history", async () => {
    const slo = await req(`/api/v1/spaces/${owner}/slos`, {
      method: "POST",
      body: { identifier: "edge-slo", monitor: "edge", target_pct: 99.9 },
      cookie: seeded.cookieHeader,
    });
    expect(slo.status).toBe(201);

    const list = await req(`/api/v1/spaces/${owner}/slos`, { cookie: seeded.cookieHeader });
    const row = (list.body as { identifier: string; observed_pct: number | null }[]).find(
      (s) => s.identifier === "edge-slo"
    )!;
    expect(row.observed_pct).toBe(100);
  });

  it("records and ends a downtime window", async () => {
    const create = await req(`/api/v1/spaces/${owner}/downtimes`, {
      method: "POST",
      body: { monitor: "edge", reason: "deploy" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);
    const id = (create.body as { id: string }).id;

    const end = await req(`/api/v1/spaces/${owner}/downtimes/${id}/end`, {
      method: "POST",
      body: {},
      cookie: seeded.cookieHeader,
    });
    expect(end.status).toBe(200);

    const list = await req(`/api/v1/spaces/${owner}/downtimes`, {
      cookie: seeded.cookieHeader,
    });
    const row = (list.body as { id: string; ongoing: boolean }[]).find((d) => d.id === id)!;
    expect(row.ongoing).toBe(false);
  });
});

describe("incidents", () => {
  it("creates an incident with an update timeline that resolves", async () => {
    const create = await req(`/api/v1/spaces/${owner}/incidents`, {
      method: "POST",
      body: { title: "edge 5xx spike", severity: "sev2" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);
    const id = (create.body as { id: string }).id;

    const update = await req(`/api/v1/spaces/${owner}/incidents/${id}/updates`, {
      method: "POST",
      body: { body: "mitigated by rollback", status: "resolved" },
      cookie: seeded.cookieHeader,
    });
    expect(update.status).toBe(200);

    const detail = await req(`/api/v1/spaces/${owner}/incidents/${id}`, {
      cookie: seeded.cookieHeader,
    });
    const body = detail.body as { status: string; updates: { body: string }[] };
    expect(body.status).toBe("resolved");
    expect(body.updates).toHaveLength(1);
  });
});

describe("certificates + costs + chaos", () => {
  it("tracks certificate expiry", async () => {
    const create = await req(`/api/v1/spaces/${owner}/certificates`, {
      method: "POST",
      body: {
        domain: "example.com",
        issuer: "letsencrypt",
        expires_at: Date.now() + 20 * 86400_000,
      },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const list = await req(`/api/v1/spaces/${owner}/certificates`, {
      cookie: seeded.cookieHeader,
    });
    const cert = (list.body as { domain: string; days_left: number }[]).find(
      (x) => x.domain === "example.com"
    )!;
    expect(cert.days_left).toBeGreaterThan(0);
    expect(cert.days_left).toBeLessThanOrEqual(20);
  });

  it("aggregates cost snapshots by service", async () => {
    for (const svc of ["workers", "r2"]) {
      await req(`/api/v1/spaces/${owner}/costs`, {
        method: "POST",
        body: { provider: "cloudflare", service: svc, amount_cents: 1234 },
        cookie: seeded.cookieHeader,
      });
    }
    const list = await req(`/api/v1/spaces/${owner}/costs`, { cookie: seeded.cookieHeader });
    const totals = (list.body as { totals_by_service: { service: string }[] }).totals_by_service;
    expect(totals.some((t) => t.service === "workers")).toBe(true);
    expect(totals.some((t) => t.service === "r2")).toBe(true);
  });

  it("records chaos experiment outcomes", async () => {
    await req(`/api/v1/spaces/${owner}/chaos`, {
      method: "POST",
      body: { identifier: "latency-poke", kind: "latency", spec: { ms: 250 } },
      cookie: seeded.cookieHeader,
    });
    const run = await req(`/api/v1/spaces/${owner}/chaos/latency-poke/runs`, {
      method: "POST",
      body: { outcome: "pass" },
      cookie: seeded.cookieHeader,
    });
    expect(run.status).toBe(200);

    const list = await req(`/api/v1/spaces/${owner}/chaos`, { cookie: seeded.cookieHeader });
    const row = (list.body as { identifier: string; last_outcome: string }[]).find(
      (x) => x.identifier === "latency-poke"
    )!;
    expect(row.last_outcome).toBe("pass");
  });
});

describe("scheduled handler", () => {
  it("probes due monitors and reaps stale delegates on the 5-min cron", async () => {
    const { handleScheduled } = await import("@/worker/scheduled");
    const { createDb } = await import("@/worker/db/d1");
    const { insertMonitor, insertDelegate, findMonitor, listMonitorChecks, listDelegates } =
      await import("@/worker/db/d1/dal/modules");
    const db = createDb(env.DB);
    const now = Date.now();

    await insertMonitor(db, {
      id: `mon-cron-${now}`,
      namespaceId: seeded.namespaceId,
      identifier: "cronprobe",
      url: "https://127.0.0.1:1/unreachable",
      method: "GET",
      expectedStatus: 200,
      intervalSec: 1,
      enabled: 1,
      lastStatus: null,
      lastLatencyMs: null,
      lastCheckedAt: null,
      createdAt: now,
    });
    await insertDelegate(db, {
      id: `dlg-cron-${now}`,
      namespaceId: seeded.namespaceId,
      identifier: "stale-runner",
      tags: "[]",
      status: "online",
      lastSeenAt: now - 20 * 60 * 1000,
      createdBy: seeded.userId,
      createdAt: now - 3600_000,
    });

    await handleScheduled("*/5 * * * *", env);

    const monitor = await findMonitor(db, seeded.namespaceId, "cronprobe");
    expect(monitor?.lastCheckedAt).not.toBeNull();
    expect(monitor?.lastStatus).toBe("down");
    const checks = await listMonitorChecks(db, monitor!.id, 10);
    expect(checks.length).toBeGreaterThan(0);

    const delegates = await listDelegates(db, seeded.namespaceId);
    expect(delegates.find((d) => d.identifier === "stale-runner")?.status).toBe("offline");
  });
});
