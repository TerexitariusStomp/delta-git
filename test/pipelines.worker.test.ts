import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

// Pipeline/execution surface: pipeline CRUD + view, trigger CRUD (the
// repo_push synthetic view of the legacy on_push flag), execution
// create/list/find/cancel, and the LivelogLine log contract. Route ordering
// is covered implicitly — greedy repo_ref tails must not shadow these.

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function api(
  method: string,
  path: string,
  cookie?: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

describe("gitness pipelines + executions", () => {
  let w: SetupRepoForTestsResult;
  let ref: string;
  const pipeBase = () => `/api/v1/repos/${ref}/pipelines`;

  beforeAll(async () => {
    await ensureD1Migrations(env);
    w = await setupRepoForTests(env, uniq("pipe-ns"), "piperepo");
    ref = `${w.namespaceSlug}/piperepo/+`;
    const id = env.REPO_DO.idFromName(w.doName);
    await env.REPO_DO.get(id).seedMinimalRepo();
  });

  it("pipeline create requires auth; create/list/find/patch round-trips", async () => {
    const anon = await api("POST", pipeBase(), undefined, { identifier: "build" });
    expect(anon.status).toBe(401);

    const created = await api("POST", pipeBase(), w.cookieHeader, {
      identifier: "build",
      config_path: ".harness/build.yaml",
      default_branch: "main",
      on_push: true,
      description: "builds the repo",
    });
    expect(created.status).toBe(200);
    const pipe = created.body as { id: number; identifier: string; on_push?: boolean };
    expect(pipe.identifier).toBe("build");
    expect(pipe.on_push).toBe(true);

    const dup = await api("POST", pipeBase(), w.cookieHeader, { identifier: "build" });
    expect(dup.status).toBe(409);

    const list = await api("GET", pipeBase(), w.cookieHeader);
    expect(list.status).toBe(200);
    expect((list.body as unknown[]).length).toBe(1);

    const found = await api("GET", `${pipeBase()}/build`, w.cookieHeader);
    expect(found.status).toBe(200);
    expect((found.body as { identifier: string }).identifier).toBe("build");

    // PATCH updates record fields (not shadowed by the greedy repo route).
    const patched = await api("PATCH", `${pipeBase()}/build`, w.cookieHeader, {
      description: "updated",
      default_branch: "dev",
    });
    expect(patched.status).toBe(200);
    const after = patched.body as { description?: string; default_branch?: string };
    expect(after.description).toBe("updated");
    expect(after.default_branch).toBe("dev");

    // /view resolves the pipeline + yaml read (empty yaml when the config
    // path is absent from the seeded repo).
    const view = await api("GET", `${pipeBase()}/build/view`, w.cookieHeader);
    expect(view.status).toBe(200);
    expect((view.body as { yaml: string }).yaml).toBe("");
  });

  it("trigger CRUD — on_push surfaces as repo_push, records persist", async () => {
    // on_push=true from the create above renders as the implicit trigger.
    const initial = await api("GET", `${pipeBase()}/build/triggers`, w.cookieHeader);
    expect(initial.status).toBe(200);
    const triggers = initial.body as Array<{ identifier: string; event: string }>;
    expect(triggers.some((t) => t.identifier === "repo_push" && t.event === "push")).toBe(true);

    const created = await api("POST", `${pipeBase()}/build/triggers`, w.cookieHeader, {
      identifier: "release-push",
      event: "push",
      branch_scope: "release-*",
    });
    expect(created.status).toBe(200);

    const dup = await api("POST", `${pipeBase()}/build/triggers`, w.cookieHeader, {
      identifier: "release-push",
      event: "push",
    });
    expect(dup.status).toBe(409);

    const patched = await api(
      "PATCH",
      `${pipeBase()}/build/triggers/release-push`,
      w.cookieHeader,
      {
        enabled: false,
      }
    );
    expect(patched.status).toBe(200);
    expect((patched.body as { enabled: boolean }).enabled).toBe(false);

    const del = await api("DELETE", `${pipeBase()}/build/triggers/release-push`, w.cookieHeader);
    expect(del.status).toBe(200);
    const missing = await api(
      "DELETE",
      `${pipeBase()}/build/triggers/release-push`,
      w.cookieHeader
    );
    expect(missing.status).toBe(404);
  });

  it("executions — create/list/find/cancel/logs contract", async () => {
    const anon = await api("POST", `${pipeBase()}/build/executions`, undefined, {});
    expect(anon.status).toBe(401);

    const created = await api("POST", `${pipeBase()}/build/executions?branch=dev`, w.cookieHeader);
    expect(created.status).toBe(200);
    const exec = created.body as { number: number; status: string; ref: string };
    expect(exec.number).toBe(1);
    expect(exec.status).toBe("pending");
    expect(exec.ref).toBe("refs/heads/dev");

    const list = await api("GET", `${pipeBase()}/build/executions`, w.cookieHeader);
    expect(list.status).toBe(200);
    expect((list.body as unknown[]).length).toBe(1);

    const found = await api("GET", `${pipeBase()}/build/executions/1`, w.cookieHeader);
    expect(found.status).toBe(200);

    // Logs honor the LivelogLine contract — empty until a runner reports.
    const logs = await api("GET", `${pipeBase()}/build/executions/1/logs/1/1`, w.cookieHeader);
    expect(logs.status).toBe(200);
    expect(Array.isArray(logs.body)).toBe(true);

    const canceled = await api("POST", `${pipeBase()}/build/executions/1/cancel`, w.cookieHeader);
    expect(canceled.status).toBe(200);
    expect((canceled.body as { status: string }).status).toBe("killed");

    const gone = await api("DELETE", `${pipeBase()}/build/executions/1`, w.cookieHeader);
    expect(gone.status).toBe(200);
    const after = await api("GET", `${pipeBase()}/build/executions/1`, w.cookieHeader);
    expect(after.status).toBe(404);
  });

  it("pipeline delete is not shadowed by the greedy repo route", async () => {
    const del = await api("DELETE", `${pipeBase()}/build`, w.cookieHeader);
    expect(del.status).toBe(200);
    const list = await api("GET", pipeBase(), w.cookieHeader);
    expect((list.body as unknown[]).length).toBe(0);
  });
});
