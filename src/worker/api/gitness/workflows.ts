// Actions-parity workflow discovery: `.github/workflows/*.{yml,yaml}` (and
// the delta/harness aliases) materialize into `RepoPipeline` records so a
// pushed workflow just runs — the runner resolves `config_path` from git
// itself, the store only carries the trigger semantics.

import { parse as parseYaml } from "yaml";

import type { AppRouter } from "@/worker/routes/hono";
import { createLogger } from "@/worker/common/logger";
import { readPath } from "@/worker/git/operations/read/tree";
import { createExecution } from "./executions";
import { branchMatches } from "./stores";
import { gErr, requireWriter, type GitnessContext } from "./shared";
import {
  readRepoPipelines,
  writeRepoPipelines,
  type RepoPipeline,
  type RepoPipelineTrigger,
} from "./stores";

const log = createLogger(undefined, { service: "WorkflowSync" });
const td = new TextDecoder();

/** Directories scanned for workflow files, in precedence order. */
export const WORKFLOW_DIRS = [".github/workflows", ".delta/workflows", ".harness"];

export interface ParsedWorkflow {
  name: string;
  onPush: boolean;
  pushBranches: string[];
  onPullRequest: boolean;
  prBranches: string[];
  /** Cron expressions from `on.schedule`. */
  schedules: string[];
}

function branchList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter(Boolean);
}

/**
 * Parse a GitHub-shaped workflow file into trigger semantics. `on:` accepts
 * all three YAML shapes: `on: push`, `on: [push, pull_request]`, and the
 * map form with branch filters + schedule entries. Unknown `on:` events
 * (release, workflow_dispatch handled as manual anyway, ...) are ignored —
 * a workflow we can't trigger still materializes so manual runs work.
 */
export function parseWorkflowTriggers(fileName: string, text: string): ParsedWorkflow {
  const doc = parseYaml(text) as Record<string, unknown>;
  const on = doc?.on;
  const parsed: ParsedWorkflow = {
    name: typeof doc?.name === "string" ? doc.name : fileName,
    onPush: false,
    pushBranches: [],
    onPullRequest: false,
    prBranches: [],
    schedules: [],
  };
  if (typeof on === "string") {
    parsed.onPush = on === "push";
    parsed.onPullRequest = on === "pull_request";
    return parsed;
  }
  if (Array.isArray(on)) {
    parsed.onPush = on.includes("push");
    parsed.onPullRequest = on.includes("pull_request");
    return parsed;
  }
  if (on && typeof on === "object") {
    const map = on as Record<string, unknown>;
    if ("push" in map) {
      parsed.onPush = true;
      const pushCfg = map.push as { branches?: unknown } | null;
      parsed.pushBranches =
        pushCfg && typeof pushCfg === "object" ? branchList(pushCfg.branches) : [];
    }
    if ("pull_request" in map) {
      parsed.onPullRequest = true;
      const prCfg = map.pull_request as { branches?: unknown } | null;
      parsed.prBranches = prCfg && typeof prCfg === "object" ? branchList(prCfg.branches) : [];
    }
    if (Array.isArray(map.schedule)) {
      for (const entry of map.schedule) {
        const cron = (entry as { cron?: unknown })?.cron;
        if (typeof cron === "string" && cron.trim()) parsed.schedules.push(cron.trim());
      }
    }
  }
  return parsed;
}

/**
 * Scan workflow dirs at `ref` and upsert pipeline records. Existing
 * pipelines whose `config_path` matches a discovered file are updated in
 * place (identifier stays stable → executions keep pointing at it);
 * pipelines pointing at a vanished file are dropped — push-time sync
 * mirrors GitHub's "deleted workflows stop running" semantic.
 * Returns the upserted pipelines.
 */
export async function syncWorkflowPipelines(
  env: Env,
  doName: string,
  ref: string
): Promise<RepoPipeline[]> {
  const discovered: { path: string; parsed: ParsedWorkflow }[] = [];
  for (const dir of WORKFLOW_DIRS) {
    const listing = await readPath(env, doName, ref, dir).catch(() => null);
    if (!listing || listing.type !== "tree") continue;
    const files = listing.entries.filter(
      (e) => !e.mode.startsWith("40000") && /\.(ya?ml)$/i.test(e.name)
    );
    for (const file of files) {
      const blob = await readPath(env, doName, ref, `${dir}/${file.name}`).catch(() => null);
      if (!blob || blob.type !== "blob" || blob.tooLarge) continue;
      try {
        discovered.push({
          path: `${dir}/${file.name}`,
          parsed: parseWorkflowTriggers(file.name, td.decode(blob.content)),
        });
      } catch (err) {
        // Malformed YAML shouldn't block the push — log and skip.
        log.warn("workflow:parse-failed", {
          doName,
          path: `${dir}/${file.name}`,
          error: String(err),
        });
      }
    }
    if (discovered.length > 0) break; // first non-empty dir wins
  }

  const pipes = await readRepoPipelines(env, doName);
  const discoveredPaths = new Set(discovered.map((d) => d.path));
  const now = Date.now();
  const next = pipes.filter(
    (p) => !p.config_path || !isWorkflowPath(p.config_path) || discoveredPaths.has(p.config_path)
  );
  let maxId = next.reduce((m, p) => Math.max(m, p.id), 0);

  for (const { path, parsed } of discovered) {
    const identifier = path.slice(path.lastIndexOf("/") + 1).replace(/\.(ya?ml)$/i, "");
    const triggers: RepoPipelineTrigger[] = [];
    if (parsed.onPullRequest) {
      triggers.push({
        identifier: "pull_request",
        event: "pull_request",
        branch_scope: parsed.prBranches.join(",") || undefined,
        enabled: true,
        created: now,
      });
    }
    parsed.schedules.forEach((cron, i) => {
      triggers.push({
        identifier: `schedule_${i + 1}`,
        event: "cron",
        cron,
        enabled: true,
        created: now,
      });
    });

    const existing = next.find((p) => p.config_path === path);
    if (existing) {
      const idx = next.indexOf(existing);
      next[idx] = {
        ...existing,
        description: parsed.name !== identifier ? parsed.name : existing.description,
        on_push: parsed.onPush,
        branches: parsed.pushBranches,
        triggers,
        updated: now,
      };
    } else {
      next.push({
        id: ++maxId,
        identifier,
        config_path: path,
        description: parsed.name !== identifier ? parsed.name : undefined,
        on_push: parsed.onPush,
        branches: parsed.pushBranches,
        triggers,
        created: now,
        updated: now,
      });
    }
  }
  await writeRepoPipelines(env, doName, next);
  log.info("workflow:synced", { doName, ref, synced: discovered.length, total: next.length });
  return next.filter((p) => discoveredPaths.has(p.config_path));
}

function isWorkflowPath(path: string): boolean {
  return WORKFLOW_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

/**
 * Spawn pending executions for pipelines with an enabled `pull_request`
 * trigger whose branch_scope matches the PR's target branch — the
 * `on: pull_request` half of workflow sync. Best-effort via waitUntil,
 * same failure contract as notifyMembers.
 */
export function spawnPullRequestPipelines(
  c: GitnessContext,
  doName: string,
  args: { targetBranch: string; sourceRef: string; prNumber: number; actor?: string }
): void {
  c.executionCtx.waitUntil(
    (async () => {
      const pipes = await readRepoPipelines(c.env, doName);
      for (const pipe of pipes) {
        const matches = (pipe.triggers ?? []).some(
          (t) =>
            t.enabled &&
            t.event === "pull_request" &&
            branchMatches(t.branch_scope, args.targetBranch)
        );
        if (!matches) continue;
        await createExecution(c.env, doName, {
          pipeline: pipe,
          event: "pull_request",
          ref: args.sourceRef,
          message: `pull_request #${args.prNumber}`,
          author_name: args.actor,
        });
      }
    })().catch((err) => log.warn("workflow:pr-trigger-failed", { doName, error: String(err) }))
  );
}

export function registerGitnessWorkflows(router: AppRouter) {
  // Manual resync — same effect as pushing the workflow files.
  router.post("/api/v1/repos/:repo_ref{.+}/pipelines/sync", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const synced = await syncWorkflowPipelines(c.env, gate.route.doName, "HEAD").catch((err) => {
      log.warn("workflow:sync-failed", { doName: gate.route.doName, error: String(err) });
      return null;
    });
    if (!synced) return gErr(c, 500, "workflow sync failed");
    return c.json({ synced: synced.length, pipelines: synced });
  });
}
