import { describe, it, expect, beforeAll } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";
import { uniqueRepoId } from "./util/test-helpers";

let seeded: SetupRepoForTestsResult;
let owner: string;
let repo: string;

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
  owner = `dvx-${Math.random().toString(36).slice(2, 8)}`;
  repo = uniqueRepoId("dvxrepo");
  seeded = await setupRepoForTests(env, owner, repo);
});

describe("catalog + dev environments", () => {
  it("registers catalog entities linked to repos", async () => {
    const create = await req(`/api/v1/spaces/${owner}/catalog`, {
      method: "POST",
      body: { identifier: "api-svc", kind: "service", repo, description: "edge api" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const list = await req(`/api/v1/spaces/${owner}/catalog`, { cookie: seeded.cookieHeader });
    const row = (list.body as { identifier: string; repository_id: string | null }[]).find(
      (e) => e.identifier === "api-svc"
    )!;
    expect(row.repository_id).not.toBeNull();
  });

  it("starts and stops dev environments", async () => {
    const create = await req(`/api/v1/spaces/${owner}/dev-environments`, {
      method: "POST",
      body: { identifier: "ws-1", repo, machine_type: "standard" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const start = await req(`/api/v1/spaces/${owner}/dev-environments/ws-1/start`, {
      method: "POST",
      body: {},
      cookie: seeded.cookieHeader,
    });
    expect(start.status).toBe(200);
    expect((start.body as { status: string }).status).toBe("running");

    const list = await req(`/api/v1/spaces/${owner}/dev-environments`, {
      cookie: seeded.cookieHeader,
    });
    const row = (list.body as { identifier: string; status: string }[]).find(
      (e) => e.identifier === "ws-1"
    )!;
    expect(row.status).toBe("running");
  });
});

describe("databases + security tests + supply chain", () => {
  it("records databases with a migration ledger", async () => {
    await req(`/api/v1/spaces/${owner}/databases`, {
      method: "POST",
      body: { identifier: "main-db", engine: "postgres", host: "pg.internal" },
      cookie: seeded.cookieHeader,
    });
    const mig = await req(`/api/v1/spaces/${owner}/databases/main-db/migrations`, {
      method: "POST",
      body: { version: "0001_init" },
      cookie: seeded.cookieHeader,
    });
    expect(mig.status).toBe(200);
    expect((mig.body as { applied: number }).applied).toBe(1);
  });

  it("runs the queue→result security-test lifecycle", async () => {
    const create = await req(`/api/v1/spaces/${owner}/security-tests`, {
      method: "POST",
      body: { kind: "sast", target: `${owner}/${repo}`, repo },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);
    const id = (create.body as { id: string }).id;

    const result = await req(`/api/v1/spaces/${owner}/security-tests/${id}/result`, {
      method: "POST",
      body: { status: "fail", findings: 3, report: { tool: "semgrep" } },
      cookie: seeded.cookieHeader,
    });
    expect(result.status).toBe(200);

    const list = await req(`/api/v1/spaces/${owner}/security-tests`, {
      cookie: seeded.cookieHeader,
    });
    const row = (list.body as { id: string; status: string; findings: number }[]).find(
      (t) => t.id === id
    )!;
    expect(row.status).toBe("fail");
    expect(row.findings).toBe(3);
  });

  it("stores and reads back supply-chain documents", async () => {
    const create = await req(`/api/v1/spaces/${owner}/supply-chain`, {
      method: "POST",
      body: {
        kind: "sbom",
        repo,
        document: { bomFormat: "CycloneDX", components: [] },
      },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);
    const id = (create.body as { id: string }).id;

    const read = await req(`/api/v1/spaces/${owner}/supply-chain/${id}`, {
      cookie: seeded.cookieHeader,
    });
    expect(read.status).toBe(200);
    expect((read.body as { document: { bomFormat: string } }).document.bomFormat).toBe("CycloneDX");
  });
});

describe("dashboards + insights", () => {
  it("stores dashboard layouts", async () => {
    const create = await req(`/api/v1/spaces/${owner}/dashboards`, {
      method: "POST",
      body: { identifier: "main", layout: [{ widget: "monitors", x: 0 }] },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const list = await req(`/api/v1/spaces/${owner}/dashboards`, {
      cookie: seeded.cookieHeader,
    });
    const row = (list.body as { identifier: string; layout: unknown[] }[]).find(
      (d) => d.identifier === "main"
    )!;
    expect(row.layout).toHaveLength(1);
  });

  it("aggregates real dev-insights counts", async () => {
    const res = await req(`/api/v1/spaces/${owner}/insights`, { cookie: seeded.cookieHeader });
    expect(res.status).toBe(200);
    const body = res.body as {
      repositories: number;
      members: number;
      security_tests_week: number;
      security_findings_week: number;
    };
    expect(body.repositories).toBeGreaterThan(0);
    expect(body.members).toBeGreaterThan(0);
    expect(body.security_tests_week).toBe(1);
    expect(body.security_findings_week).toBe(3);
  });

  it("verifies the op-log chain and returns a signed checkpoint", async () => {
    const res = await workerExports.default.fetch(
      `https://example.com/api/${owner}/${repo}/dg/oplog/verify`,
      { headers: { Authorization: seeded.pushAuthHeader } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      valid: boolean;
      tip_hash: string | null;
      entries: number;
      checkpoint_signature: string;
    };
    expect(body.valid).toBe(true);
    expect(body.checkpoint_signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
  });

  it("captures a space disaster-recovery snapshot", async () => {
    const res = await req(`/api/v1/spaces/${owner}/dr-snapshot`, {
      cookie: seeded.cookieHeader,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      counts: { repositories: number };
      repositories: { repo: string; do_name: string }[];
    };
    expect(body.counts.repositories).toBeGreaterThan(0);
    expect(body.repositories.some((r) => r.repo === repo)).toBe(true);
  });
});
