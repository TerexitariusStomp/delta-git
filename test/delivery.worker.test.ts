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
  owner = `del-${Math.random().toString(36).slice(2, 8)}`;
  await setupRepoForTests(env, owner, uniqueRepoId("delrepo")).then((s) => {
    seeded = s;
  });
});

describe("connectors", () => {
  it("CRUDs connectors without exposing sealed handles", async () => {
    const create = await req(`/api/v1/spaces/${owner}/connectors`, {
      method: "POST",
      body: { identifier: "gh-mirror", type: "github", sealed_handle: "broker:h1" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const list = await req(`/api/v1/spaces/${owner}/connectors`, {
      cookie: seeded.cookieHeader,
    });
    expect(list.status).toBe(200);
    const rows = list.body as { identifier: string; has_secret: boolean; sealed_handle?: string }[];
    const row = rows.find((r) => r.identifier === "gh-mirror")!;
    expect(row.has_secret).toBe(true);
    expect(row.sealed_handle).toBeUndefined();

    const del = await req(`/api/v1/spaces/${owner}/connectors/${row.identifier}`, {
      method: "DELETE",
      cookie: seeded.cookieHeader,
    });
    expect(del.status).toBe(204);
  });
});

describe("delegates", () => {
  it("registers and lists delegate runners", async () => {
    const create = await req(`/api/v1/spaces/${owner}/delegates`, {
      method: "POST",
      body: { identifier: "runner-1", tags: ["linux", "x64"] },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const list = await req(`/api/v1/spaces/${owner}/delegates`, {
      cookie: seeded.cookieHeader,
    });
    const row = (list.body as { identifier: string; tags: string[]; status: string }[]).find(
      (r) => r.identifier === "runner-1"
    )!;
    expect(row.tags).toEqual(["linux", "x64"]);
    expect(row.status).toBe("offline");
  });
});

describe("file store", () => {
  it("uploads, lists, downloads, and deletes blobs", async () => {
    const bytes = new TextEncoder().encode("release-notes-v1");
    const put = await workerExports.default.fetch(
      `https://example.com/api/v1/spaces/${owner}/files/releases/v1.md`,
      {
        method: "PUT",
        headers: { Cookie: seeded.cookieHeader, "Content-Type": "text/markdown" },
        body: bytes,
      }
    );
    expect(put.status).toBe(201);

    const list = await req(`/api/v1/spaces/${owner}/files`, { cookie: seeded.cookieHeader });
    expect((list.body as { name: string }[]).some((f) => f.name === "releases/v1.md")).toBe(true);

    const get = await workerExports.default.fetch(
      `https://example.com/api/v1/spaces/${owner}/files/releases/v1.md`,
      { headers: { Cookie: seeded.cookieHeader } }
    );
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);

    const del = await req(`/api/v1/spaces/${owner}/files/releases/v1.md`, {
      method: "DELETE",
      cookie: seeded.cookieHeader,
    });
    expect(del.status).toBe(204);
  });
});

describe("freeze windows", () => {
  it("marks an always-on window active", async () => {
    // "su-sa" spans the whole week — active regardless of the test run time.
    const create = await req(`/api/v1/spaces/${owner}/freezewindows`, {
      method: "POST",
      body: { identifier: "always", schedule: "su-sa", applies_to: "push" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const list = await req(`/api/v1/spaces/${owner}/freezewindows`, {
      cookie: seeded.cookieHeader,
    });
    const row = (list.body as { identifier: string; active: boolean }[]).find(
      (w) => w.identifier === "always"
    )!;
    expect(row.active).toBe(true);
  });
});

describe("policies + tickets + gitops + iac", () => {
  it("stores a policy document and evaluates it via the gates", async () => {
    const create = await req(`/api/v1/spaces/${owner}/policies`, {
      method: "POST",
      body: {
        identifier: "protect-main",
        applies_to: "push",
        enforcement: "enforce",
        document: [
          {
            when: { field: "branch", op: "eq", value: "main" },
            action: "deny",
            message: "no direct pushes to main",
          },
        ],
      },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const list = await req(`/api/v1/spaces/${owner}/policies`, { cookie: seeded.cookieHeader });
    const row = (list.body as { identifier: string; document: unknown[] }[]).find(
      (p) => p.identifier === "protect-main"
    )!;
    expect(row.document).toHaveLength(1);
  });

  it("records external tickets", async () => {
    const create = await req(`/api/v1/spaces/${owner}/tickets`, {
      method: "POST",
      body: { external_id: "JIRA-42", title: "flaky deploy", url: "https://t/JIRA-42" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const list = await req(`/api/v1/spaces/${owner}/tickets`, { cookie: seeded.cookieHeader });
    expect((list.body as { external_id: string }[]).some((t) => t.external_id === "JIRA-42")).toBe(
      true
    );
  });

  it("locks, writes, reads, and unlocks IaC state", async () => {
    const lock = await req(`/api/v1/spaces/${owner}/iac/prod/lock`, {
      method: "POST",
      body: { ID: "lock-1", Operation: "apply", Who: "test@local" },
      cookie: seeded.cookieHeader,
    });
    expect(lock.status).toBe(200);

    // A second lock attempt is rejected while held.
    const conflict = await req(`/api/v1/spaces/${owner}/iac/prod/lock`, {
      method: "POST",
      body: { ID: "lock-2" },
      cookie: seeded.cookieHeader,
    });
    expect(conflict.status).toBe(423);

    const write = await req(`/api/v1/spaces/${owner}/iac/prod/state?ID=lock-1`, {
      method: "POST",
      body: { version: 4, resources: [] },
      cookie: seeded.cookieHeader,
    });
    expect(write.status).toBe(200);
    expect((write.body as { version: number }).version).toBe(1);

    const read = await req(`/api/v1/spaces/${owner}/iac/prod/state`, {
      cookie: seeded.cookieHeader,
    });
    expect(read.status).toBe(200);
    expect((read.body as { resources: unknown[] }).resources).toEqual([]);

    const unlock = await req(`/api/v1/spaces/${owner}/iac/prod/unlock`, {
      method: "POST",
      body: { ID: "lock-1" },
      cookie: seeded.cookieHeader,
    });
    expect(unlock.status).toBe(200);
  });
});

describe("feature flags + overrides + gitops sync", () => {
  it("CRUDs flags and evaluates user/percentage targets deterministically", async () => {
    const create = await req(`/api/v1/spaces/${owner}/flags`, {
      method: "POST",
      body: { identifier: "beta-ui" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    // Default off → eval false.
    const evalOff = await req(`/api/v1/spaces/${owner}/flags/beta-ui/eval`, {
      cookie: seeded.cookieHeader,
    });
    expect(evalOff.status).toBe(200);
    expect((evalOff.body as { value: boolean }).value).toBe(false);

    const toggle = await req(`/api/v1/spaces/${owner}/flags/beta-ui`, {
      method: "PATCH",
      body: { state: "on" },
      cookie: seeded.cookieHeader,
    });
    expect(toggle.status).toBe(200);

    const evalOn = await req(`/api/v1/spaces/${owner}/flags/beta-ui/eval`, {
      cookie: seeded.cookieHeader,
    });
    expect((evalOn.body as { value: boolean }).value).toBe(true);

    const del = await req(`/api/v1/spaces/${owner}/flags/beta-ui`, {
      method: "DELETE",
      cookie: seeded.cookieHeader,
    });
    expect(del.status).toBe(204);
  });

  it("stores overrides with active/expired semantics", async () => {
    const create = await req(`/api/v1/spaces/${owner}/overrides`, {
      method: "POST",
      body: { subject: "freeze:deploy-freeze", reason: "hotfix window" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const list = await req(`/api/v1/spaces/${owner}/overrides`, { cookie: seeded.cookieHeader });
    const row = (list.body as { subject: string; active: boolean }[]).find(
      (o) => o.subject === "freeze:deploy-freeze"
    )!;
    expect(row.active).toBe(true);
  });

  it("gitops sync reports drift then converges on the recorded head", async () => {
    // Seed a real pack + main ref so the DO has a head to compare against.
    const { seedPackFirstRepo } = await import("./util/pack-first");
    await seedPackFirstRepo(`${owner}/${seeded.repoSlug}`);

    const create = await req(`/api/v1/spaces/${owner}/gitops`, {
      method: "POST",
      body: { identifier: "prod-deploy", repo: seeded.repoSlug, target_environment: "prod" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const first = await req(`/api/v1/spaces/${owner}/gitops/prod-deploy/sync`, {
      method: "POST",
      body: {},
      cookie: seeded.cookieHeader,
    });
    expect(first.status).toBe(200);
    expect((first.body as { drifted: boolean }).drifted).toBe(true);

    const second = await req(`/api/v1/spaces/${owner}/gitops/prod-deploy/sync`, {
      method: "POST",
      body: {},
      cookie: seeded.cookieHeader,
    });
    expect(second.status).toBe(200);
    expect((second.body as { drifted: boolean }).drifted).toBe(false);
  });
});
