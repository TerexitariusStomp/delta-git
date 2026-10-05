// Pipeline execution endpoints behind the gitness `/api/v1` facade.
//
// The engine: executions are pending records until a delegate runner claims
// them via `/api/{owner}/{repo}/dg/runner/claim` — runners live on client
// infra (secrets never leave client custody); the server owns the execution
// ledger (KV `gexecs:`/`gexeclogs:`), the SSE log stream, and the push
// trigger that spawns records on ref updates.
//
// A pending execution with no claimant stays `pending` — that's honest
// state, not an error. Stale running executions (heartbeat > STALE_MS) are
// marked `error` lazily on read.

import type { AppRouter } from "@/worker/routes/hono";
import { createLogger } from "@/worker/common/logger";
import {
  nextExecutionNumber,
  readRepoExecutionLogs,
  readRepoExecutions,
  readRepoPipelines,
  updateRepoExecution,
  writeRepoExecutions,
  writeRepoPipelines,
  type RepoExecution,
  type RepoPipeline,
  type RepoPipelineTrigger,
} from "./stores";
import { gErr, gNotFound, resolveGitnessRepo, requireWriter } from "./shared";

const log = createLogger(undefined, { service: "GitnessExec" });

/** A running execution silent for this long is presumed dead. */
const STALE_MS = 10 * 60 * 1000;

export function pipelineByIdOrUid(pipes: RepoPipeline[], param: string): RepoPipeline | undefined {
  const n = parseInt(param, 10);
  return pipes.find((p) => p.id === n || p.identifier === param);
}

function execByNumber(execs: RepoExecution[], pipelineId: number, numParam: string) {
  const num = parseInt(numParam, 10);
  return execs.find((e) => e.pipeline_id === pipelineId && e.number === num);
}

/** Lazily fail running executions whose runner heartbeat went stale. */
function markStale(exec: RepoExecution): RepoExecution {
  if (exec.status === "running" && exec.heartbeat && Date.now() - exec.heartbeat > STALE_MS) {
    return {
      ...exec,
      status: "error",
      error: "runner heartbeat lost",
      finished: Date.now(),
    };
  }
  return exec;
}

/** Persist the stale-marking of any mutated executions (best-effort). */
async function staleSweep(
  env: Env,
  doName: string,
  execs: RepoExecution[]
): Promise<RepoExecution[]> {
  const next = execs.map(markStale);
  if (next.some((e, i) => e !== execs[i])) {
    await writeRepoExecutions(env, doName, next).catch((err) =>
      log.warn("exec:stale-sweep-failed", { doName, error: String(err) })
    );
  }
  return next;
}

/** Create a pending execution record (shared by manual trigger + push hook). */
export async function createExecution(
  env: Env,
  doName: string,
  args: {
    pipeline: { id: number; identifier: string };
    event: string;
    ref: string;
    after?: string;
    before?: string;
    message?: string;
    author_name?: string;
    author_email?: string;
  }
): Promise<RepoExecution> {
  const execs = await readRepoExecutions(env, doName);
  const exec: RepoExecution = {
    number: nextExecutionNumber(execs, args.pipeline.id),
    pipeline_id: args.pipeline.id,
    pipeline_uid: args.pipeline.identifier,
    status: "pending",
    event: args.event,
    ref: args.ref,
    after: args.after,
    before: args.before,
    message: args.message,
    author_name: args.author_name,
    author_email: args.author_email,
    created: Date.now(),
    stages: [],
  };
  execs.unshift(exec);
  await writeRepoExecutions(env, doName, execs);
  return exec;
}

/** gitness execution JSON — the vendored SPA reads these field names. */
function toGitnessExecution(exec: RepoExecution) {
  return {
    number: exec.number,
    pipeline_id: exec.pipeline_id,
    pipeline_uid: exec.pipeline_uid,
    status: exec.status,
    event: exec.event,
    ref: exec.ref,
    after: exec.after,
    before: exec.before,
    message: exec.message,
    author_name: exec.author_name,
    author_email: exec.author_email,
    error: exec.error,
    created: exec.created,
    started: exec.started,
    finished: exec.finished,
    stages: exec.stages.map((s) => ({
      number: s.number,
      name: s.name,
      status: s.status,
      exit_code: s.exit_code,
      started: s.started,
      stopped: s.stopped,
      steps: s.steps.map((st) => ({
        number: st.number,
        name: st.name,
        status: st.status,
        exit_code: st.exit_code,
        started: st.started,
        stopped: st.stopped,
      })),
    })),
  };
}

export function registerGitnessExecutions(router: AppRouter) {
  router.get("/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/executions", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const pipe = pipelineByIdOrUid(
      await readRepoPipelines(c.env, access.route.doName),
      c.req.param("pipeline_id")
    );
    if (!pipe) return gNotFound(c, "pipeline");
    const execs = await staleSweep(
      c.env,
      access.route.doName,
      await readRepoExecutions(c.env, access.route.doName)
    );
    return c.json(execs.filter((e) => e.pipeline_id === pipe.id).map(toGitnessExecution));
  });

  // Manual trigger — a real execution record; it sits `pending` until a
  // delegate runner claims it.
  router.post("/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/executions", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const pipe = pipelineByIdOrUid(
      await readRepoPipelines(c.env, gate.route.doName),
      c.req.param("pipeline_id")
    );
    if (!pipe) return gNotFound(c, "pipeline");
    const body = (await c.req.json().catch(() => null)) as {
      branch?: string;
      ref?: string;
    } | null;
    // The gitness client passes `branch` as a query param on create.
    const branch = body?.branch ?? c.req.query("branch") ?? pipe.default_branch ?? "main";
    const ref = body?.ref ?? `refs/heads/${branch}`;
    const exec = await createExecution(c.env, gate.route.doName, {
      pipeline: pipe,
      event: "manual",
      ref,
      author_name: gate.viewer?.primaryNamespaceSlug ?? gate.viewer?.userId,
    });
    log.info("exec:triggered", {
      doName: gate.route.doName,
      pipelineId: pipe.id,
      number: exec.number,
    });
    return c.json(toGitnessExecution(exec));
  });

  router.get("/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/executions/:num", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const pipe = pipelineByIdOrUid(
      await readRepoPipelines(c.env, access.route.doName),
      c.req.param("pipeline_id")
    );
    if (!pipe) return gNotFound(c, "pipeline");
    const execs = await staleSweep(
      c.env,
      access.route.doName,
      await readRepoExecutions(c.env, access.route.doName)
    );
    const exec = execByNumber(execs, pipe.id, c.req.param("num"));
    if (!exec) return gNotFound(c, "execution");
    return c.json(toGitnessExecution(exec));
  });

  router.post(
    "/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/executions/:num/cancel",
    async (c) => {
      const gate = await requireWriter(c);
      if (gate instanceof Response) return gate;
      const pipe = pipelineByIdOrUid(
        await readRepoPipelines(c.env, gate.route.doName),
        c.req.param("pipeline_id")
      );
      if (!pipe) return gNotFound(c, "pipeline");
      const updated = await updateRepoExecution(
        c.env,
        gate.route.doName,
        pipe.id,
        parseInt(c.req.param("num"), 10),
        (exec) => {
          if (exec.status !== "pending" && exec.status !== "running") return exec;
          return {
            ...exec,
            status: "killed",
            finished: Date.now(),
          };
        }
      );
      if (!updated) return gNotFound(c, "execution");
      return c.json(toGitnessExecution(updated));
    }
  );

  router.delete("/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/executions/:num", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const pipe = pipelineByIdOrUid(
      await readRepoPipelines(c.env, gate.route.doName),
      c.req.param("pipeline_id")
    );
    if (!pipe) return gNotFound(c, "pipeline");
    const execs = await readRepoExecutions(c.env, gate.route.doName);
    const next = execs.filter(
      (e) => !(e.pipeline_id === pipe.id && e.number === parseInt(c.req.param("num"), 10))
    );
    if (next.length === execs.length) return gNotFound(c, "execution");
    await writeRepoExecutions(c.env, gate.route.doName, next);
    return c.json({});
  });

  // Step log — lines appended by the runner under `gexeclogs:`.
  router.get(
    "/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/executions/:num/logs/:stage/:step",
    async (c) => {
      const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
      if (access.kind !== "ok") return access.response;
      const pipe = pipelineByIdOrUid(
        await readRepoPipelines(c.env, access.route.doName),
        c.req.param("pipeline_id")
      );
      if (!pipe) return gNotFound(c, "pipeline");
      const stage = parseInt(c.req.param("stage"), 10);
      const step = parseInt(c.req.param("step"), 10);
      const lines = await readRepoExecutionLogs(
        c.env,
        access.route.doName,
        pipe.id,
        parseInt(c.req.param("num"), 10)
      );
      // LivelogLine contract: {out, pos, time}.
      return c.json(
        lines
          .filter((l) => l.stage === stage && l.step === step)
          .map((l) => ({ out: l.line, pos: l.pos, time: l.time }))
      );
    }
  );

  // SSE log stream — replays buffered lines then holds the connection ~25s
  // polling for more. The SPA's EventSource reconnects when it closes.
  router.get(
    "/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/executions/:num/logs/:stage/:step/stream",
    async (c) => {
      const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
      if (access.kind !== "ok") return access.response;
      const pipe = pipelineByIdOrUid(
        await readRepoPipelines(c.env, access.route.doName),
        c.req.param("pipeline_id")
      );
      if (!pipe) return gNotFound(c, "pipeline");
      const env = c.env;
      const doName = access.route.doName;
      const pipelineId = pipe.id;
      const num = parseInt(c.req.param("num"), 10);
      const stage = parseInt(c.req.param("stage"), 10);
      const step = parseInt(c.req.param("step"), 10);
      let sent = 0;
      const deadline = Date.now() + 25_000;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const flush = async () => {
            const lines = await readRepoExecutionLogs(env, doName, pipelineId, num).catch(() => []);
            for (const l of lines) {
              if (l.stage !== stage || l.step !== step || l.pos <= sent) continue;
              sent = Math.max(sent, l.pos);
              controller.enqueue(
                encoder.encode(
                  `event: message\ndata: ${JSON.stringify({ out: l.line, pos: l.pos, time: l.time })}\n\n`
                )
              );
            }
          };
          await flush();
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2000));
            await flush();
            // SSE comment keep-alive.
            controller.enqueue(encoder.encode(": ping\n\n"));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
  );

  // --- pipeline update + triggers ------------------------------------------
  //
  // PATCH updates record fields; triggers are real records — `push` events
  // with a matching branch_scope spawn executions via the queue task.

  router.patch("/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const pipes = await readRepoPipelines(c.env, gate.route.doName);
    const idx = pipes.findIndex(
      (p) =>
        p.id === parseInt(c.req.param("pipeline_id"), 10) ||
        p.identifier === c.req.param("pipeline_id")
    );
    if (idx < 0) return gNotFound(c, "pipeline");
    const body = (await c.req.json().catch(() => null)) as {
      description?: string;
      config_path?: string;
      default_branch?: string;
      on_push?: boolean;
      branches?: string[];
      disabled?: boolean;
    } | null;
    const next = { ...pipes[idx], updated: Date.now() };
    if (body?.description !== undefined) next.description = body.description;
    if (body?.config_path !== undefined) next.config_path = body.config_path;
    if (body?.default_branch !== undefined) next.default_branch = body.default_branch;
    if (body?.on_push !== undefined) next.on_push = body.on_push;
    if (body?.branches !== undefined) next.branches = body.branches;
    pipes[idx] = next;
    await writeRepoPipelines(c.env, gate.route.doName, pipes);
    return c.json(next);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/triggers", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const pipe = pipelineByIdOrUid(
      await readRepoPipelines(c.env, access.route.doName),
      c.req.param("pipeline_id")
    );
    if (!pipe) return gNotFound(c, "pipeline");
    const triggers: RepoPipelineTrigger[] = [...(pipe.triggers ?? [])];
    // `on_push` predates the triggers list — surface it as the implicit
    // repo_push trigger so both models render in the UI.
    if (pipe.on_push && !triggers.some((t) => t.event === "push")) {
      triggers.unshift({
        identifier: "repo_push",
        event: "push",
        branch_scope: pipe.branches?.join(","),
        enabled: true,
        created: pipe.created,
      });
    }
    return c.json(triggers);
  });

  router.post("/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/triggers", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const pipes = await readRepoPipelines(c.env, gate.route.doName);
    const idx = pipes.findIndex(
      (p) =>
        p.id === parseInt(c.req.param("pipeline_id"), 10) ||
        p.identifier === c.req.param("pipeline_id")
    );
    if (idx < 0) return gNotFound(c, "pipeline");
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      event?: string;
      branch_scope?: string;
      cron?: string;
    } | null;
    if (!body?.identifier?.trim()) return gErr(c, 400, "identifier required");
    const triggers = pipes[idx].triggers ?? [];
    if (triggers.some((t) => t.identifier === body.identifier)) {
      return gErr(c, 409, "trigger exists");
    }
    const event = body.event === "pull_request" || body.event === "cron" ? body.event : "push";
    const trig: RepoPipelineTrigger = {
      identifier: body.identifier.trim(),
      event,
      branch_scope: body.branch_scope,
      cron: body.cron,
      enabled: true,
      created: Date.now(),
    };
    pipes[idx] = { ...pipes[idx], triggers: [...triggers, trig], updated: Date.now() };
    await writeRepoPipelines(c.env, gate.route.doName, pipes);
    return c.json(trig);
  });

  router.patch(
    "/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/triggers/:trigger_id",
    async (c) => {
      const gate = await requireWriter(c);
      if (gate instanceof Response) return gate;
      const pipes = await readRepoPipelines(c.env, gate.route.doName);
      const idx = pipes.findIndex(
        (p) =>
          p.id === parseInt(c.req.param("pipeline_id"), 10) ||
          p.identifier === c.req.param("pipeline_id")
      );
      if (idx < 0) return gNotFound(c, "pipeline");
      const triggers = pipes[idx].triggers ?? [];
      const tIdx = triggers.findIndex((t) => t.identifier === c.req.param("trigger_id"));
      if (tIdx < 0) return gNotFound(c, "trigger");
      const body = (await c.req.json().catch(() => null)) as {
        branch_scope?: string;
        cron?: string;
        enabled?: boolean;
      } | null;
      const next = { ...triggers[tIdx] };
      if (body?.branch_scope !== undefined) next.branch_scope = body.branch_scope;
      if (body?.cron !== undefined) next.cron = body.cron;
      if (body?.enabled !== undefined) next.enabled = body.enabled;
      triggers[tIdx] = next;
      pipes[idx] = { ...pipes[idx], triggers, updated: Date.now() };
      await writeRepoPipelines(c.env, gate.route.doName, pipes);
      return c.json(next);
    }
  );

  router.delete(
    "/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/triggers/:trigger_id",
    async (c) => {
      const gate = await requireWriter(c);
      if (gate instanceof Response) return gate;
      const pipes = await readRepoPipelines(c.env, gate.route.doName);
      const idx = pipes.findIndex(
        (p) =>
          p.id === parseInt(c.req.param("pipeline_id"), 10) ||
          p.identifier === c.req.param("pipeline_id")
      );
      if (idx < 0) return gNotFound(c, "pipeline");
      const triggers = pipes[idx].triggers ?? [];
      const next = triggers.filter((t) => t.identifier !== c.req.param("trigger_id"));
      if (next.length === triggers.length) return gNotFound(c, "trigger");
      pipes[idx] = { ...pipes[idx], triggers: next, updated: Date.now() };
      await writeRepoPipelines(c.env, gate.route.doName, pipes);
      return c.json({});
    }
  );
}
