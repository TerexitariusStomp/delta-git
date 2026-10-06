import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { concatChunks, flushPkt, pktLine } from "@/worker/git/core";
import { encodeGitObject } from "@/worker/git/core/objects";
import { buildPack } from "./util/git-pack";
import { buildTreePayload } from "./util/packed-repo";
import { toRequestBody } from "./util/test-helpers";
import { ensureD1Migrations } from "./util/d1Setup";
import { readCronPipelineRepos, writeRepoPipelines } from "@/worker/api/gitness/stores";
import { handleScheduled } from "@/worker/scheduled";
import { fromBase64Url } from "@atcute/multibase";
import { withEnvOverrides } from "./util/test-helpers";

async function nodeJwk(): Promise<{ jwk: string }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { jwk: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)) };
}
import { lookupPushAuth, setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

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

describe("actions: .github/workflows materialize into pipelines", () => {
  let w: SetupRepoForTestsResult;
  let ref: string;
  const pipeBase = () => `/api/v1/repos/${ref}/pipelines`;

  const WF_YAML = [
    "name: CI",
    "on:",
    "  push:",
    "    branches: [main]",
    "  pull_request:",
    "    branches: [main]",
    "  schedule:",
    '    - cron: "0 2 * * *"',
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");

  beforeAll(async () => {
    await ensureD1Migrations(env);
    w = await setupRepoForTests(env, uniq("wf-ns"), "wfrepo");
    ref = `${w.namespaceSlug}/wfrepo/+`;

    // Push .github/workflows/ci.yml onto main (nested trees) + a `feat`
    // branch at the same commit for the PR-trigger half.
    const wfPayload = new TextEncoder().encode(WF_YAML);
    const wfBlob = await encodeGitObject("blob", wfPayload);
    const wfDirPayload = buildTreePayload([{ mode: "100644", name: "ci.yml", oid: wfBlob.oid }]);
    const wfDir = await encodeGitObject("tree", wfDirPayload);
    const dotGithubPayload = buildTreePayload([
      { mode: "40000", name: "workflows", oid: wfDir.oid },
    ]);
    const dotGithub = await encodeGitObject("tree", dotGithubPayload);
    const rootPayload = buildTreePayload([{ mode: "40000", name: ".github", oid: dotGithub.oid }]);
    const root = await encodeGitObject("tree", rootPayload);
    const author = "You <you@example.com> 0 +0000";
    const commitPayload = new TextEncoder().encode(
      `tree ${root.oid}\nauthor ${author}\ncommitter ${author}\n\nadd workflow\n`
    );
    const commit = await encodeGitObject("commit", commitPayload);
    const pack = await buildPack([
      { type: "blob", payload: wfPayload },
      { type: "tree", payload: wfDirPayload },
      { type: "tree", payload: dotGithubPayload },
      { type: "tree", payload: rootPayload },
      { type: "commit", payload: commitPayload },
    ]);
    const push = await workerExports.default.fetch(
      `https://example.com/${w.namespaceSlug}/wfrepo/git-receive-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-receive-pack-request",
          Authorization: lookupPushAuth(w.namespaceSlug, "wfrepo")!,
        },
        body: toRequestBody(
          concatChunks([
            pktLine(
              `${"0".repeat(40)} ${commit.oid} refs/heads/main\0 report-status ofs-delta agent=test\n`
            ),
            pktLine(`${"0".repeat(40)} ${commit.oid} refs/heads/feat`),
            flushPkt(),
            pack,
          ])
        ),
      } as any
    );
    expect(push.status).toBe(200);
  });

  it("sync upserts pipeline + triggers from the workflow file", async () => {
    const synced = await api("POST", `${pipeBase()}/sync`, w.cookieHeader);
    expect(synced.status).toBe(200);
    const body = synced.body as {
      synced: number;
      pipelines: Array<{
        identifier: string;
        config_path: string;
        on_push?: boolean;
        branches?: string[];
        triggers?: { identifier: string; event: string; cron?: string }[];
      }>;
    };
    expect(body.synced).toBe(1);
    const ci = body.pipelines.find((p) => p.identifier === "ci");
    expect(ci).toBeTruthy();
    expect(ci!.config_path).toBe(".github/workflows/ci.yml");
    expect(ci!.on_push).toBe(true);
    expect(ci!.branches).toEqual(["main"]);
    const events = (ci!.triggers ?? []).map((t) => `${t.identifier}:${t.event}`);
    expect(events).toContain("pull_request:pull_request");
    expect(events).toContain("schedule_1:cron");

    // Idempotent — resync keeps one pipeline for the file.
    const again = await api("POST", `${pipeBase()}/sync`, w.cookieHeader);
    const list = await api("GET", pipeBase(), w.cookieHeader);
    expect((list.body as unknown[]).length).toBe(1);
    expect((again.body as { synced: number }).synced).toBe(1);
  });

  it("PR create spawns a pull_request-event execution", async () => {
    const pr = await api("POST", `/api/v1/repos/${ref}/pullreq`, w.cookieHeader, {
      source_branch: "feat",
      target_branch: "main",
      title: "trigger the workflow",
    });
    expect(pr.status).toBe(200);

    // spawnPullRequestPipelines runs in waitUntil — poll briefly.
    const deadline = Date.now() + 5000;
    let found = false;
    while (Date.now() < deadline && !found) {
      const execs = await api("GET", `${pipeBase()}/ci/executions`, w.cookieHeader);
      found =
        execs.status === 200 &&
        (execs.body as { event: string; status: string }[]).some(
          (e) => e.event === "pull_request" && e.status === "pending"
        );
      if (!found) await new Promise((r) => setTimeout(r, 150));
    }
    expect(found).toBe(true);
  });
});

describe("actions: cron schedules fire via the scheduled sweep", () => {
  let w: SetupRepoForTestsResult;
  let ref: string;
  const pipeBase = () => `/api/v1/repos/${ref}/pipelines`;

  beforeAll(async () => {
    await ensureD1Migrations(env);
    w = await setupRepoForTests(env, uniq("cron-ns"), "cronrepo");
    ref = `${w.namespaceSlug}/cronrepo/+`;
  });

  it("due cron trigger spawns a cron-event execution once", async () => {
    // Seed a pipeline whose cron trigger is already due (created 10m ago,
    // */1-every-minute schedule).
    await writeRepoPipelines(env, w.doName, [
      {
        id: 1,
        identifier: "nightly",
        config_path: ".harness/nightly.yaml",
        triggers: [
          {
            identifier: "every_min",
            event: "cron",
            cron: "* * * * *",
            enabled: true,
            created: Date.now() - 10 * 60 * 1000,
          },
        ],
        created: Date.now() - 10 * 60 * 1000,
        updated: Date.now(),
      },
    ]);
    // The write indexed the repo for the sweep.
    expect(await readCronPipelineRepos(env)).toContain(w.doName);

    await handleScheduled("*/5 * * * *", env);

    const execs = await api("GET", `${pipeBase()}/nightly/executions`, w.cookieHeader);
    expect(execs.status).toBe(200);
    const cronExecs = (execs.body as { event: string; status: string }[]).filter(
      (e) => e.event === "cron"
    );
    expect(cronExecs.length).toBe(1);
    expect(cronExecs[0].status).toBe("pending");

    // Immediately re-running the sweep doesn't double-fire — lastFired
    // moved the high-water mark.
    await handleScheduled("*/5 * * * *", env);
    const again = await api("GET", `${pipeBase()}/nightly/executions`, w.cookieHeader);
    expect((again.body as { event: string }[]).filter((e) => e.event === "cron").length).toBe(1);
  });
});

describe("actions: runner OIDC token", () => {
  let w: SetupRepoForTestsResult;
  let ref: string;

  beforeAll(async () => {
    await ensureD1Migrations(env);
    w = await setupRepoForTests(env, uniq("oidc-ns"), "oidcrepo");
    ref = `${w.namespaceSlug}/oidcrepo/+`;
    // A pipeline with one pending execution.
    await writeRepoPipelines(env, w.doName, [
      { id: 1, identifier: "deploy", config_path: ".harness/deploy.yaml", created: 1, updated: 1 },
    ]);
    await api("POST", `/api/v1/repos/${ref}/pipelines/deploy/executions`, w.cookieHeader);
  });

  it("claimed execution mints a verifiable EdDSA JWT; wrong caller 403s", async () => {
    const { jwk } = await nodeJwk();
    const dg = `/api/${w.namespaceSlug}/oidcrepo/dg`;

    const claimed = await workerExports.default.fetch(`https://example.com${dg}/runner/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: w.pushAuthHeader },
      // No runner name — claim binds to the PAT's actor, matching what the
      // OIDC endpoint derives from the same credential.
      body: JSON.stringify({}),
    });
    expect(claimed.status).toBe(200);
    const claim = (await claimed.json()) as { execution: { pipeline_id: number; number: number } };
    expect(claim.execution).toBeTruthy();

    await withEnvOverrides(env, { DG_NODE_ED25519_JWK: jwk }, async () => {
      const res = await workerExports.default.fetch(`https://example.com${dg}/runner/oidc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: w.pushAuthHeader },
        body: JSON.stringify({
          exec: { pipeline_id: claim.execution.pipeline_id, number: claim.execution.number },
          audience: "https://cloud.example.com",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        token: string;
        expires_in: number;
        node_key: JsonWebKey;
      };
      const [h, p, s] = body.token.split(".");
      const header = JSON.parse(new TextDecoder().decode(fromBase64Url(h)));
      const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(p)));
      expect(header.alg).toBe("EdDSA");
      expect(payload.aud).toBe("https://cloud.example.com");
      expect(payload.exp - payload.iat).toBe(600);
      expect(payload.sub).toContain(`${w.namespaceSlug}/oidcrepo`);

      // Offline verify against the returned node key.
      const key = await crypto.subtle.importKey(
        "jwk",
        { ...body.node_key, key_ops: ["verify"], ext: true },
        { name: "Ed25519" },
        false,
        ["verify"]
      );
      const ok = await crypto.subtle.verify(
        "Ed25519",
        key,
        fromBase64Url(s) as BufferSource,
        new TextEncoder().encode(`${h}.${p}`) as BufferSource
      );
      expect(ok).toBe(true);
    });
  });
});
