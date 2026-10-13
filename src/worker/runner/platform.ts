// Built-in Cloudflare delegate runner — claims pending pipeline executions
// and runs their workflow yaml inside a ForgeSandbox container.
//
// External client-side delegates keep first pick: dispatch messages carry a
// delay so a repo's own runners can claim first; the platform runner only
// ever transitions an exec that is *still* `pending` at claim time. The
// claim → report → log → heartbeat → complete ledger writes mirror the
// `/dg/runner/*` HTTP protocol exactly — this file is that protocol's
// server-side twin, not a second implementation.
//
// Custody: platform runs see only repo contents — sealed secrets are
// client-side by contract and are never injected into the sandbox.

import { createLogger } from "@/worker/common/logger";
import { getRepoStub } from "@/worker/common/stub";
import { readPath } from "@/worker/git/operations/read/tree";
import { jobSandbox, JOB_TIMEOUT_MS } from "@/worker/compute/sandbox";
import { openRepoTar } from "@/worker/routes/archive";
import {
  appendRepoExecutionLogs,
  readRepoExecutionLogs,
  readRepoExecutions,
  readRepoPipelines,
  updateRepoExecution,
  type RepoExecution,
  type RepoExecutionLogLine,
} from "@/worker/api/gitness/stores";
import { parseWorkflowSpec } from "./spec";
import { applyEgressPolicy, JOB_EGRESS_ALLOWLISTS } from "@/worker/compute/egress";

const log = createLogger(undefined, { service: "PlatformRunner" });

/** Runner name recorded on claimed executions (and `exec.runner`). */
export const PLATFORM_RUNNER = "cf-platform";

/**
 * Platform-side wall-clock cap per execution — intentionally below the
 * shared JOB_TIMEOUT_MS and below the queue consumer's own budget so a
 * runaway workflow fails honestly instead of being orphaned mid-run.
 */
export const PLATFORM_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Cap on a single step's runtime. */
const STEP_TIMEOUT_MS = 5 * 60 * 1000;

export interface StepExecOutcome {
  exitCode: number;
  /** Combined stdout+stderr, in order. */
  output: string;
}

/**
 * Worktree lifecycle for one execution — production stages a tar of the
 * commit tree into a ForgeSandbox; tests inject a deterministic executor
 * (containers cannot run under workerd).
 */
export interface StepExecutor {
  /** Materialize the commit's worktree. */
  stage(commitOid: string): Promise<{ ok: boolean; detail?: string }>;
  /** Run one shell command inside the staged worktree. */
  run(
    command: string,
    timeoutMs: number,
    env?: Record<string, string>
  ): Promise<StepExecOutcome>;
}

/** ForgeSandbox-backed executor: stage a tar of the commit, extract, exec. */
export function sandboxStepExecutor(env: Env, doName: string, jobId: string): StepExecutor {
  const sandbox = jobSandbox(env, doName, "ci", jobId, {
    containerTimeouts: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 120_000 },
  });
  // Egress policy lands before any workflow-controlled command runs —
  // CI steps are arbitrary user code, so the sandbox locks to the
  // registry/VCS allowlist first. Failure to enforce is logged, not
  // hidden (see docs/security.md for the threat model).
  const egressApplied = applyEgressPolicy(sandbox, JOB_EGRESS_ALLOWLISTS.ci).then((r) => {
    if (!r.enforced) log.warn("runner:egress-not-enforced", { jobId, detail: r.detail });
    return r;
  });
  return {
    async stage(commitOid) {
      await egressApplied;
      const tar = await openRepoTar({
        env,
        doName,
        commitOid,
        cacheCtx: undefined,
        log,
      });
      if (!tar) return { ok: false, detail: "worktree too large or unreadable" };
      const write = await sandbox.writeFile("/workspace/repo.tar", tar.readable);
      if (!write.success) {
        return { ok: false, detail: "tar upload failed" };
      }
      const unpack = await sandbox.exec(
        "mkdir -p /workspace/repo && tar -xf /workspace/repo.tar -C /workspace/repo && rm -f /workspace/repo.tar",
        { timeout: 120_000 }
      );
      if (!unpack.success) {
        return {
          ok: false,
          detail: `worktree extract failed (exit ${unpack.exitCode}): ${unpack.stderr || unpack.stdout}`,
        };
      }
      await tar.done.catch(() => undefined);
      return { ok: true };
    },
    async run(command, timeoutMs, env) {
      const result = await sandbox.exec(`cd /workspace/repo && ${command}`, {
        timeout: timeoutMs,
        env,
      });
      return {
        exitCode: result.exitCode,
        output: `${result.stdout}${result.stderr}`,
      };
    },
  };
}

function heartbeat(env: Env, doName: string, exec: RepoExecution): Promise<RepoExecution | null> {
  return updateRepoExecution(env, doName, exec.pipeline_id, exec.number, (e) =>
    e.status === "running" ? { ...e, heartbeat: Date.now() } : e
  );
}

async function appendStepLogs(
  env: Env,
  doName: string,
  exec: RepoExecution,
  stage: number,
  step: number,
  lines: string[]
): Promise<void> {
  if (lines.length === 0) return;
  const base = (
    await readRepoExecutionLogs(env, doName, exec.pipeline_id, exec.number).catch(() => [])
  ).length;
  await appendRepoExecutionLogs(
    env,
    doName,
    exec.pipeline_id,
    exec.number,
    lines.slice(0, 500).map(
      (line, i) =>
        ({
          stage,
          step,
          pos: base + i + 1,
          time: Date.now(),
          line: line.length > 2000 ? `${line.slice(0, 2000)}…` : line,
        }) satisfies RepoExecutionLogLine
    )
  );
}

/**
 * Claim and run the oldest pending execution for `doName`, if any remains
 * pending after the delegate grace delay. Returns true when an execution
 * was claimed (successfully or not) — callers loop while it returns true
 * to drain a backlog.
 */
export async function runPlatformRunnerOnce(
  env: Env,
  doName: string,
  deps: { executor?: StepExecutor; deadlineMs?: number } = {}
): Promise<boolean> {
  const execs = await readRepoExecutions(env, doName);
  const candidate = execs.find((e) => e.status === "pending");
  if (!candidate) return false;

  // Same transition as POST /dg/runner/claim — only a still-pending exec
  // may be claimed, so a client delegate that won the race is untouched.
  const claimed = await updateRepoExecution(
    env,
    doName,
    candidate.pipeline_id,
    candidate.number,
    (e) =>
      e.status === "pending"
        ? {
            ...e,
            status: "running",
            runner: PLATFORM_RUNNER,
            heartbeat: Date.now(),
            started: Date.now(),
          }
        : e
  );
  if (!claimed || claimed.runner !== PLATFORM_RUNNER) return false;

  const deadline =
    Date.now() + Math.min(deps.deadlineMs ?? PLATFORM_RUN_TIMEOUT_MS, JOB_TIMEOUT_MS);
  const execRef = { pipelineId: claimed.pipeline_id, num: claimed.number };

  /** Finalize the exec record — every failure path lands here so nothing
   *  is ever left `running` without a heartbeat. */
  async function finish(status: RepoExecution["status"], error?: string) {
    await updateRepoExecution(env, doName, execRef.pipelineId, execRef.num, (e) =>
      e.status === "running" ? { ...e, status, error, finished: Date.now() } : e
    );
  }

  try {
    const pipes = await readRepoPipelines(env, doName);
    const pipe = pipes.find((p) => p.id === claimed.pipeline_id);
    const configPath = pipe?.config_path;

    // Resolve the commit to build: `after` for push triggers, else the
    // execution's ref head.
    let commitOid = claimed.after;
    if (!commitOid) {
      const stub = getRepoStub(env, doName);
      const { refs } = await stub.getHeadAndRefs();
      commitOid = refs.find((r) => r.name === claimed.ref)?.oid;
    }
    if (!commitOid) {
      await finish("error", `ref ${claimed.ref} has no commit to run`);
      return true;
    }

    const executor =
      deps.executor ?? sandboxStepExecutor(env, doName, `${claimed.pipeline_id}-${claimed.number}`);

    const staged = await executor.stage(commitOid);
    if (!staged.ok) {
      await finish("error", `worktree stage failed: ${staged.detail ?? "unknown"}`);
      return true;
    }

    // The workflow yaml is read from the same commit the worktree staged —
    // the run always matches what the pushed tree declared.
    let yamlText = "";
    if (configPath) {
      const blob = await readPath(env, doName, commitOid, configPath).catch(() => null);
      if (blob?.type === "blob" && !blob.tooLarge && blob.content) {
        yamlText = new TextDecoder().decode(blob.content);
      }
    }
    const spec = parseWorkflowSpec(configPath ?? "inline", yamlText);
    if (spec.stages.length === 0) {
      await finish(
        "error",
        configPath ? `no runnable stages in ${configPath}` : "pipeline has no config_path"
      );
      return true;
    }

    // Report the resolved stage/step graph — mirrors POST /dg/runner/report.
    const reported = await updateRepoExecution(env, doName, execRef.pipelineId, execRef.num, (e) =>
      e.status === "running"
        ? {
            ...e,
            heartbeat: Date.now(),
            stages: spec.stages.map((s, i) => ({
              number: i + 1,
              name: s.name,
              status: "running" as const,
              steps: s.steps.map((st, j) => ({
                number: j + 1,
                name: st.name,
                status: "running" as const,
              })),
            })),
          }
        : e
    );
    if (!reported) {
      await finish("error", "execution record lost mid-run");
      return true;
    }

    // Walk the graph — one executor `run` per step command. Stage/step
    // outcomes are collected for the final `complete` write.
    const stageOutcomes: {
      number: number;
      status: "success" | "failure" | "error" | "skipped";
      exit_code?: number;
      steps: {
        number: number;
        status: "success" | "failure" | "error" | "skipped";
        exit_code?: number;
      }[];
    }[] = [];
    let overall: "success" | "failure" | "error" = "success";
    let overallError: string | undefined;
    let abort = false;

    outer: for (const [sIdx, stage] of spec.stages.entries()) {
      const stageNo = sIdx + 1;
      const stepOutcomes: (typeof stageOutcomes)[number]["steps"] = [];
      let stageStatus: "success" | "failure" | "error" | "skipped" = "success";

      if (abort) {
        stageStatus = "skipped";
        for (const [tIdx] of stage.steps.entries()) {
          stepOutcomes.push({ number: tIdx + 1, status: "skipped" });
        }
        stageOutcomes.push({ number: stageNo, status: stageStatus, steps: stepOutcomes });
        continue;
      }

      for (const [tIdx, step] of stage.steps.entries()) {
        const stepNo = tIdx + 1;
        if (Date.now() > deadline) {
          overall = "error";
          overallError = "platform runner timeout";
          stepOutcomes.push({ number: stepNo, status: "error" });
          stageStatus = "error";
          abort = true;
          continue outer;
        }
        await heartbeat(env, doName, claimed);
        if (step.skipped || step.commands.length === 0) {
          stepOutcomes.push({ number: stepNo, status: "skipped" });
          continue;
        }
        let stepStatus: "success" | "failure" | "error" = "success";
        let stepExit = 0;
        for (const command of step.commands) {
          const outcome = await executor.run(command, STEP_TIMEOUT_MS, step.env).catch(
            (err: unknown) => ({
              exitCode: -1,
              output: `executor error: ${err instanceof Error ? err.message : String(err)}`,
            })
          );
          const lines = [`$ ${command}`, ...outcome.output.split("\n").filter((l) => l.length > 0)];
          await appendStepLogs(env, doName, claimed, stageNo, stepNo, lines).catch(() => undefined);
          stepExit = outcome.exitCode;
          if (outcome.exitCode !== 0) {
            stepStatus = "failure";
            break;
          }
        }
        stepOutcomes.push({ number: stepNo, status: stepStatus, exit_code: stepExit });
        if (stepStatus === "failure") {
          stageStatus = "failure";
          overall = "failure";
          break; // remaining steps in this stage skip
        }
      }
      if (stageStatus === "failure") {
        for (const [tIdx] of stage.steps.entries()) {
          const no = tIdx + 1;
          if (!stepOutcomes.some((s) => s.number === no)) {
            stepOutcomes.push({ number: no, status: "skipped" });
          }
        }
        abort = true;
      }
      stageOutcomes.push({ number: stageNo, status: stageStatus, steps: stepOutcomes });
    }

    // Complete — mirrors POST /dg/runner/complete with the full outcome graph.
    await updateRepoExecution(env, doName, execRef.pipelineId, execRef.num, (e) => {
      if (e.status !== "running") return e;
      return {
        ...e,
        status: overall,
        error: overallError,
        finished: Date.now(),
        stages: e.stages.map((s) => {
          const outcome = stageOutcomes.find((o) => o.number === s.number);
          if (!outcome) return s;
          return {
            ...s,
            status: outcome.status,
            exit_code: outcome.exit_code,
            steps: s.steps.map((st) => {
              const stepOutcome = outcome.steps.find((o) => o.number === st.number);
              return stepOutcome
                ? { ...st, status: stepOutcome.status, exit_code: stepOutcome.exit_code }
                : st;
            }),
          };
        }),
      };
    });
    log.info("runner:completed", {
      doName,
      pipelineId: execRef.pipelineId,
      number: execRef.num,
      status: overall,
    });
    return true;
  } catch (error) {
    log.warn("runner:failed", {
      doName,
      pipelineId: execRef.pipelineId,
      number: execRef.num,
      error: String(error),
    });
    await finish("error", error instanceof Error ? error.message : String(error));
    return true;
  }
}
