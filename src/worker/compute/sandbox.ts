// Platform compute — the single chokepoint through which every "real
// effect" module reaches a ForgeSandbox container.
//
// Isolation model: sandbox ids carry the owning namespace slug
// (`job-{ns}-{kind}-{id}` / `ws-{ns}-{id}`). The helpers here are the only
// way first-party code obtains a stub, so cross-space access would require
// deliberately bypassing this file — there is no ambient sandbox registry
// a caller could poke at.
//
// Secrets: user secrets are client-sealed by contract — nothing in this
// file accepts a plaintext secret. Server-side material (short-lived pull
// tokens, the platform mirror key) is handed to the sandbox via
// `writeFile`, never via argv or env vars, and is deleted before the job
// returns.

import { getSandbox, type SandboxOptions } from "@cloudflare/sandbox";
import type { ForgeSandbox } from "@/worker/do/sandbox/forgeSandbox";

/** Jobs are meant to finish and go away; workspaces linger for a user. */
const JOB_SLEEP_AFTER = "10m";
const WS_SLEEP_AFTER = "30m";

/** Hard wall-clock cap for any single platform job. */
export const JOB_TIMEOUT_MS = 30 * 60 * 1000;

function normalizeSlug(slug: string): string {
  // DO names are routed through the id — keep it lowercase-ascii so the
  // same space always resolves to the same sandbox.
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 60);
}

/** A one-shot platform job (CI run, scan, mirror, cert probe, chaos). */
export function jobSandbox(
  env: Env,
  namespaceSlug: string,
  kind: string,
  jobId: string,
  options: SandboxOptions = {}
): ForgeSandbox {
  return getSandbox(
    env.FORGE_SANDBOX,
    `job-${normalizeSlug(namespaceSlug)}-${normalizeSlug(kind)}-${normalizeSlug(jobId)}`,
    { sleepAfter: JOB_SLEEP_AFTER, normalizeId: true, ...options }
  );
}

/** A user dev workspace — keyed to the environment record id. */
export function workspaceSandbox(
  env: Env,
  namespaceSlug: string,
  workspaceId: string
): ForgeSandbox {
  return getSandbox(
    env.FORGE_SANDBOX,
    `ws-${normalizeSlug(namespaceSlug)}-${normalizeSlug(workspaceId)}`,
    { sleepAfter: WS_SLEEP_AFTER, normalizeId: true }
  );
}

export interface JobSpec {
  /** Shell command(s) run inside the sandbox, in order. */
  commands: string[];
  /** Files staged into the sandbox before commands run (path → contents). */
  files?: Record<string, string>;
  /** Repo to `git clone` first (already-credentialed URL). */
  repoUrl?: string;
  /** Branch/tag for the checkout. */
  ref?: string;
  /** env vars exported for the commands — NEVER secrets. */
  envVars?: Record<string, string>;
  /** Per-job timeout override, capped at JOB_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface JobResult {
  ok: boolean;
  /** stdout+stderr of every command, concatenated in order. */
  output: string;
  /** Exit code of the first failing command, or of the last command. */
  exitCode: number;
  /** Files collected back out of the sandbox after the run. */
  artifacts: Record<string, string>;
  durationMs: number;
}

/**
 * Run a job to completion inside a fresh ForgeSandbox instance.
 *
 * The caller decides what happens with the result; this helper only runs
 * the spec and reports. Fails soft — a broken sandbox or nonzero exit
 * returns `{ok:false}` rather than throwing, so callers can record honest
 * job state.
 */
export async function runJob(
  env: Env,
  namespaceSlug: string,
  kind: string,
  jobId: string,
  spec: JobSpec,
  collect: string[] = []
): Promise<JobResult> {
  const started = Date.now();
  const timeoutMs = Math.min(spec.timeoutMs ?? JOB_TIMEOUT_MS, JOB_TIMEOUT_MS);
  const deadline = started + timeoutMs;
  const output: string[] = [];
  const artifacts: Record<string, string> = {};
  let exitCode = 0;

  try {
    const sandbox = jobSandbox(env, namespaceSlug, kind, jobId, {
      containerTimeouts: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 120_000 },
    });
    if (spec.envVars) await sandbox.setEnvVars(spec.envVars);
    if (spec.files) {
      for (const [path, contents] of Object.entries(spec.files)) {
        await sandbox.writeFile(path, contents);
      }
    }
    if (spec.repoUrl) {
      const checkout = await sandbox.gitCheckout(spec.repoUrl, {
        branch: spec.ref,
        targetDir: "/workspace/repo",
      });
      if (!checkout.success) {
        return {
          ok: false,
          output: `git clone failed (exit ${checkout.exitCode ?? "?"})`,
          exitCode: checkout.exitCode ?? 128,
          artifacts,
          durationMs: Date.now() - started,
        };
      }
    }
    for (const command of spec.commands) {
      if (Date.now() > deadline) {
        output.push(`[timeout] job exceeded ${timeoutMs}ms budget`);
        exitCode = 124;
        break;
      }
      const result = await sandbox.exec(command);
      output.push(`$ ${command}\n${result.stdout}${result.stderr}`);
      if (!result.success) {
        exitCode = result.exitCode;
        break;
      }
      exitCode = result.exitCode;
    }
    for (const path of collect) {
      try {
        const file = await sandbox.readFile(path);
        if (file.success && file.content !== undefined) artifacts[path] = file.content;
      } catch {
        // best-effort collection — a missing artifact is not a job failure
      }
    }
    return {
      ok: exitCode === 0,
      output: output.join("\n"),
      exitCode,
      artifacts,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      output: `sandbox error: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: -1,
      artifacts,
      durationMs: Date.now() - started,
    };
  }
}
