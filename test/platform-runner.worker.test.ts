// Platform runner orchestration — the built-in Cloudflare delegate claims a
// pending execution, stages the worktree, runs the workflow graph, and
// completes the ledger exactly like an external /dg/runner/* delegate
// would. Containers can't run under workerd, so the StepExecutor seam is
// injected; everything around it (claim transition, stage report, log
// append, outcome graph) is the real code path.

import { describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { concatChunks, flushPkt, pktLine } from "@/worker/git/core";
import { encodeGitObject } from "@/worker/git/core/objects";
import { runPlatformRunnerOnce, type StepExecutor } from "@/worker/runner/platform";
import { createExecution } from "@/worker/api/gitness/executions";
import {
  readRepoExecutionLogs,
  readRepoExecutions,
  writeRepoPipelines,
} from "@/worker/api/gitness/stores";
import { buildPack } from "./util/git-pack";
import { buildTreePayload } from "./util/packed-repo";
import { toRequestBody, uniqueRepoId } from "./util/test-helpers";
import { lookupPushAuth, setupRepoForTests } from "./util/repoSeed";
import { seedPackFirstRepo } from "./util/pack-first";
import { promoteToStreaming } from "./util/streaming-helpers";

const PUSH_URL_BASE = "https://example.com";

const WORKFLOW_YAML = `name: ci
on: push
jobs:
  verify:
    steps:
      - name: install
        run: npm ci
      - name: typecheck
        run: npm run typecheck
`;

/** Push a commit that adds `.delta/workflows/ci.yml` on top of `parentOid`. */
async function pushWorkflow(args: {
  owner: string;
  repo: string;
  ref: string;
  parentOid: string;
}): Promise<{ response: Response; commitOid: string }> {
  const enc = new TextEncoder();
  const author = "You <you@example.com> 0 +0000";

  const ciBlob = await encodeGitObject("blob", enc.encode(WORKFLOW_YAML));
  const readmeBlob = await encodeGitObject("blob", enc.encode("readme\n"));
  const workflowsTreePayload = buildTreePayload([
    { mode: "100644", name: "ci.yml", oid: ciBlob.oid },
  ]);
  const workflowsTree = await encodeGitObject("tree", workflowsTreePayload);
  const deltaTreePayload = buildTreePayload([
    { mode: "40000", name: "workflows", oid: workflowsTree.oid },
  ]);
  const deltaTree = await encodeGitObject("tree", deltaTreePayload);
  const rootTreePayload = buildTreePayload([
    { mode: "40000", name: ".delta", oid: deltaTree.oid },
    { mode: "100644", name: "README.md", oid: readmeBlob.oid },
  ]);
  const rootTree = await encodeGitObject("tree", rootTreePayload);

  const commitPayload = enc.encode(
    `tree ${rootTree.oid}\n` +
      `parent ${args.parentOid}\n` +
      `author ${author}\n` +
      `committer ${author}\n\n` +
      `add workflow\n`
  );
  const commit = await encodeGitObject("commit", commitPayload);

  const pack = await buildPack([
    { type: "blob", payload: enc.encode(WORKFLOW_YAML) },
    { type: "blob", payload: enc.encode("readme\n") },
    { type: "tree", payload: workflowsTreePayload },
    { type: "tree", payload: deltaTreePayload },
    { type: "tree", payload: rootTreePayload },
    { type: "commit", payload: commitPayload },
  ]);
  const response = await workerExports.default.fetch(
    `${PUSH_URL_BASE}/${args.owner}/${args.repo}/git-receive-pack`,
    {
      method: "POST",
      headers: {
        Authorization: lookupPushAuth(args.owner, args.repo) ?? "",
        "Content-Type": "application/x-git-receive-pack-request",
      },
      body: toRequestBody(
        concatChunks([
          pktLine(
            `${args.parentOid} ${commit.oid} ${args.ref}\0 report-status ofs-delta agent=test\n`
          ),
          flushPkt(),
          pack,
        ])
      ),
    }
  );
  return { response, commitOid: commit.oid };
}

/** Scripted executor — deterministic outputs keyed on the command. */
function fakeExecutor(
  behavior: {
    stageOk?: boolean;
    failOn?: string;
  } = {}
): StepExecutor {
  return {
    async stage() {
      return behavior.stageOk === false ? { ok: false, detail: "no sandbox" } : { ok: true };
    },
    async run(command) {
      if (behavior.failOn && command.includes(behavior.failOn)) {
        return { exitCode: 1, output: `${command} failed` };
      }
      return { exitCode: 0, output: `${command} ok` };
    },
  };
}

async function seedRepoWithWorkflow() {
  const owner = "o";
  const repo = uniqueRepoId("runner");
  await setupRepoForTests(env, owner, repo);
  const repoId = `${owner}/${repo}`;
  const seeded = await seedPackFirstRepo(repoId);
  await promoteToStreaming(owner, repo);
  const pushed = await pushWorkflow({
    owner,
    repo,
    ref: "refs/heads/main",
    parentOid: seeded.nextCommit.oid,
  });
  expect(pushed.response.status).toBe(200);
  return { repoId, commitOid: pushed.commitOid };
}

async function seedPendingExec(repoId: string, commitOid: string) {
  const doName = repoId;
  await writeRepoPipelines(env, doName, [
    {
      id: 1,
      identifier: "ci",
      config_path: ".delta/workflows/ci.yml",
      default_branch: "main",
      on_push: true,
      created: Date.now(),
      updated: Date.now(),
    },
  ]);
  const exec = await createExecution(env, doName, {
    pipeline: { id: 1, identifier: "ci" },
    event: "manual",
    ref: "refs/heads/main",
    after: commitOid,
  });
  return { doName, exec };
}

describe("platform runner", () => {
  it("claims, reports, runs, and completes a pending execution", async () => {
    const { repoId, commitOid } = await seedRepoWithWorkflow();
    const { doName, exec } = await seedPendingExec(repoId, commitOid);

    const claimed = await runPlatformRunnerOnce(env, doName, { executor: fakeExecutor() });
    expect(claimed).toBe(true);

    const execs = await readRepoExecutions(env, doName);
    const done = execs.find((e) => e.number === exec.number);
    expect(done?.status).toBe("success");
    expect(done?.runner).toBe("cf-platform");
    expect(done?.stages).toHaveLength(1);
    expect(done?.stages[0].status).toBe("success");
    expect(done?.stages[0].steps.map((s) => s.status)).toEqual(["success", "success"]);

    const logs = await readRepoExecutionLogs(env, doName, exec.pipeline_id, exec.number);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.stage === 1)).toBe(true);
    expect(logs.some((l) => l.line.includes("npm ci"))).toBe(true);
  });

  it("marks the exec failure and skips remaining steps when a command fails", async () => {
    const { repoId, commitOid } = await seedRepoWithWorkflow();
    const { doName, exec } = await seedPendingExec(repoId, commitOid);

    const claimed = await runPlatformRunnerOnce(env, doName, {
      executor: fakeExecutor({ failOn: "npm ci" }),
    });
    expect(claimed).toBe(true);

    const done = (await readRepoExecutions(env, doName)).find((e) => e.number === exec.number);
    expect(done?.status).toBe("failure");
    const steps = done?.stages[0].steps ?? [];
    expect(steps[0]?.status).toBe("failure");
    expect(steps[1]?.status).toBe("skipped");
  });

  it("records an honest error when worktree staging fails", async () => {
    const { repoId, commitOid } = await seedRepoWithWorkflow();
    const { doName, exec } = await seedPendingExec(repoId, commitOid);

    const claimed = await runPlatformRunnerOnce(env, doName, {
      executor: fakeExecutor({ stageOk: false }),
    });
    expect(claimed).toBe(true);

    const done = (await readRepoExecutions(env, doName)).find((e) => e.number === exec.number);
    expect(done?.status).toBe("error");
    expect(done?.error).toContain("worktree stage failed");
  });

  it("returns false and leaves claimed execs alone when nothing is pending", async () => {
    const { repoId } = await seedRepoWithWorkflow();
    const doName = repoId;
    const claimed = await runPlatformRunnerOnce(env, doName, { executor: fakeExecutor() });
    expect(claimed).toBe(false);
  });
});
