// Workflow yaml → execution graph. Pure parsing — no I/O — so the same
// parser the platform runner drives is unit-testable outside workerd.
//
// Two shapes are honored:
//   - GitHub Actions: `jobs.<id>.steps[]` where each step carries `run:`.
//     Each job becomes a stage; `uses:`-only steps are kept as named steps
//     with no commands so the ledger records them honestly as skipped.
//   - Harness/Gitness: `stages[].steps[]` (and the `pipeline.stages`
//     wrapper) with `run:`/`script:`/`commands:` step bodies.
// A bare top-level `steps:` list degrades to a single "build" stage.

import { parse as parseYaml } from "yaml";

export interface WorkflowStepSpec {
  name: string;
  /** Shell commands run in order inside the staged worktree. */
  commands: string[];
  /**
   * Resolved env for the step — workflow `env:` merged under job/stage
   * `env:` merged under step `env:`. Values are plain strings; sealed
   * variables are injected client-side at dispatch (the platform cannot
   * decrypt client-sealed records by design).
   */
  env?: Record<string, string>;
  /** Step has no runnable commands (e.g. `uses:`) — recorded, not run. */
  skipped?: boolean;
}

export interface WorkflowStageSpec {
  name: string;
  steps: WorkflowStepSpec[];
}

export interface WorkflowSpec {
  name: string;
  stages: WorkflowStageSpec[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `env:` yaml maps → flat string records. Non-scalar values are dropped. */
function toEnvMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(raw) ?? {})) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

/** One raw step entry → spec. `run`/`script`/`commands` bodies all map to commands. */
function toStepSpec(raw: unknown, index: number): WorkflowStepSpec | null {
  const step = asRecord(raw);
  if (!step) return null;
  const name = typeof step.name === "string" && step.name.trim() ? step.name : `step ${index + 1}`;

  // Harness wraps the body: `step.run` may be a string or {spec:{command}}.
  let body: unknown = step.run ?? step.script ?? step.commands;
  const runObj = asRecord(step.run);
  if (runObj?.spec) {
    const spec = asRecord(runObj.spec);
    body = spec?.command ?? spec?.commands ?? body;
  }

  const commands: string[] = [];
  if (typeof body === "string" && body.trim()) {
    commands.push(body);
  } else if (Array.isArray(body)) {
    for (const cmd of body) {
      if (typeof cmd === "string" && cmd.trim()) commands.push(cmd);
    }
  }

  const env = toEnvMap(step.env ?? step.envs ?? step.envVariables);
  const stepSpec: WorkflowStepSpec = { name, commands };
  if (Object.keys(env).length > 0) stepSpec.env = env;

  if (commands.length === 0) {
    // `uses:` (actions marketplace) or empty step — kept for ledger honesty.
    stepSpec.skipped = true;
  }
  return stepSpec;
}

function stepsFromList(raw: unknown): WorkflowStepSpec[] {
  const out: WorkflowStepSpec[] = [];
  for (const [i, entry] of asList(raw).entries()) {
    const step = toStepSpec(entry, i);
    if (step) out.push(step);
  }
  return out;
}

export function parseWorkflowSpec(fileName: string, text: string): WorkflowSpec {
  const doc = asRecord(parseYaml(text)) ?? {};
  const name = typeof doc.name === "string" && doc.name.trim() ? doc.name : fileName;
  const topEnv = toEnvMap(doc.env ?? doc.environment);

  // `env` merges top → job/stage → step (step wins).
  const mergeEnv = (parent: Record<string, string>, steps: WorkflowStepSpec[]) =>
    steps.map((s) => {
      const merged = { ...topEnv, ...parent, ...(s.env ?? {}) };
      return Object.keys(merged).length > 0 ? { ...s, env: merged } : s;
    });

  // GitHub Actions shape — jobs run sequentially in file order. `needs:` is
  // accepted but only orders stages (document order already matches intent
  // in the overwhelmingly common case).
  const jobs = asRecord(doc.jobs);
  if (jobs) {
    const stages: WorkflowStageSpec[] = [];
    for (const [jobId, rawJob] of Object.entries(jobs)) {
      const job = asRecord(rawJob);
      if (!job) continue;
      const stageName = typeof job.name === "string" && job.name.trim() ? job.name : jobId;
      stages.push({ name: stageName, steps: mergeEnv(toEnvMap(job.env), stepsFromList(job.steps)) });
    }
    if (stages.length > 0) return { name, stages };
  }

  // Harness/Gitness shape — `pipeline` wrapper optional.
  const harnessRoot = asRecord(doc.pipeline) ?? doc;
  const stageList = asList(harnessRoot.stages);
  if (stageList.length > 0) {
    const stages: WorkflowStageSpec[] = [];
    for (const [i, rawStage] of stageList.entries()) {
      const stage = asRecord(rawStage);
      if (!stage) continue;
      const stageName =
        typeof stage.name === "string" && stage.name.trim() ? stage.name : `stage ${i + 1}`;
      const stageEnv = toEnvMap(stage.env ?? stage.envVariables);
      stages.push({ name: stageName, steps: mergeEnv(stageEnv, stepsFromList(stage.steps)) });
    }
    if (stages.length > 0) return { name, stages };
  }

  // Bare `steps:` fallback.
  const steps = mergeEnv({}, stepsFromList(harnessRoot.steps));
  if (steps.length > 0) return { name, stages: [{ name: "build", steps }] };

  return { name, stages: [] };
}
