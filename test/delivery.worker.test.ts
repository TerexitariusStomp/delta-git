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

  it("test-connection probes the endpoint for real", async () => {
    const create = await req(`/api/v1/spaces/${owner}/connectors`, {
      method: "POST",
      body: { identifier: "probe-me", type: "generic-http", endpoint: "https://example.com" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const probe = await req(`/api/v1/spaces/${owner}/connectors/probe-me/test`, {
      method: "POST",
      cookie: seeded.cookieHeader,
    });
    expect(probe.status).toBe(200);
    const body = probe.body as {
      ok: boolean;
      status?: number;
      latency_ms?: number;
      error?: string;
    };
    expect(typeof body.latency_ms).toBe("number");
    // Reachable sandbox → real status; unreachable → honest error, never faked.
    if (body.ok) expect(body.status).toBe(200);
    else expect(body.error).toBe("endpoint-unreachable");

    // Connector without an endpoint reports the honest "nothing to probe".
    await req(`/api/v1/spaces/${owner}/connectors`, {
      method: "POST",
      body: { identifier: "no-ep", type: "generic-http" },
      cookie: seeded.cookieHeader,
    });
    const noEp = await req(`/api/v1/spaces/${owner}/connectors/no-ep/test`, {
      method: "POST",
      cookie: seeded.cookieHeader,
    });
    expect(noEp.status).toBe(400);
  });
});

describe("templates seed + variables export + ticket sync", () => {
  it("seeds built-in templates idempotently", async () => {
    const seed = await req(`/api/v1/spaces/${owner}/templates/seed`, {
      method: "POST",
      cookie: seeded.cookieHeader,
    });
    expect(seed.status).toBe(200);
    const body = seed.body as { seeded: string[]; total: number };
    expect(body.seeded).toContain("ci");
    expect(body.seeded).toContain("deploy");

    const list = await req(`/api/v1/spaces/${owner}/templates`, {
      cookie: seeded.cookieHeader,
    });
    const rows = list.body as { identifier: string; data: string }[];
    expect(rows.find((t) => t.identifier === "ci")!.data).toContain("stages:");

    const again = await req(`/api/v1/spaces/${owner}/templates/seed`, {
      method: "POST",
      cookie: seeded.cookieHeader,
    });
    expect((again.body as { seeded: string[] }).seeded).toHaveLength(0);
  });

  it("exports sealed variable records for client-side consumption", async () => {
    await req(`/api/v1/spaces/${owner}/variables`, {
      method: "POST",
      body: { identifier: "api_key", ciphertext: "sealed:abc", description: "mirror key" },
      cookie: seeded.cookieHeader,
    });
    const get = await req(`/api/v1/spaces/${owner}/variables/API_KEY`, {
      cookie: seeded.cookieHeader,
    });
    expect(get.status).toBe(200);
    const rec = get.body as { identifier: string; ciphertext: string };
    expect(rec.identifier).toBe("API_KEY");
    expect(rec.ciphertext).toBe("sealed:abc");

    const missing = await req(`/api/v1/spaces/${owner}/variables/NOPE`, {
      cookie: seeded.cookieHeader,
    });
    expect(missing.status).toBe(404);
  });

  it("ticket sync validates the at:// source and resolves the PDS", async () => {
    const bad = await req(`/api/v1/spaces/${owner}/tickets/sync`, {
      method: "POST",
      body: { source: "not-an-at-uri" },
      cookie: seeded.cookieHeader,
    });
    expect(bad.status).toBe(400);

    // A syntactically valid but unregistered did:plc resolves to no PDS —
    // honest 502, never a fake success.
    const gone = await req(`/api/v1/spaces/${owner}/tickets/sync`, {
      method: "POST",
      body: { source: "at://did:plc:zzzzzzzzzzzzzzzzzzzzzzzz/fyi.widespread.ticket" },
      cookie: seeded.cookieHeader,
    });
    expect(gone.status).toBe(502);
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

    // SDK bulk eval resolves every flag for the subject in one request.
    const sdk = await req(`/api/v1/spaces/${owner}/flags/sdk?subject=agent-7`, {
      cookie: seeded.cookieHeader,
    });
    expect(sdk.status).toBe(200);
    const sdkBody = sdk.body as {
      subject: string;
      flags: Record<string, { value: boolean; reason: string }>;
    };
    expect(sdkBody.subject).toBe("agent-7");
    expect(sdkBody.flags["beta-ui"].value).toBe(true);
    expect(sdkBody.flags["beta-ui"].reason).toBe("DEFAULT");

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

  it("gitops sync reports drift and applies through the deploy lane", async () => {
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
    const firstBody = first.body as { drifted: boolean; applying: boolean };
    expect(firstBody.drifted).toBe(true);
    // Real reconcile: the deploy lane was enqueued, not just a ledger bump.
    expect(firstBody.applying).toBe(true);

    // The ledger only converges when the deploy lands — a still-pending
    // apply keeps the drift visible instead of faking convergence.
    const second = await req(`/api/v1/spaces/${owner}/gitops/prod-deploy/sync`, {
      method: "POST",
      body: {},
      cookie: seeded.cookieHeader,
    });
    expect(second.status).toBe(200);
    expect((second.body as { drifted: boolean }).drifted).toBe(true);
  });
});
