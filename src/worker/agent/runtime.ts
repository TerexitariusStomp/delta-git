import { DurableObject } from "cloudflare:workers";

// Agent runtime: the Agents-SDK / Think-class layer for delta-git.
//
// Each agent is a Durable Object = stable identity + durable memory +
// queue/alarm heartbeat. RepoDurableObject stays the authority for repo
// state (refs, intents, op-log); runtime agents are the *actors* that
// consume work and mutate through RepoDO RPCs, so all invariants still
// hold in one place.
//
//   AdjudicatorAgent — consumes `adjudicate` queue messages; the Workers-AI
//     quorum seat as a stateful agent (keeps a task ledger of every
//     adjudication it participated in).
//   RepoAgent        — per-repo actor keyed by doId; runs `federate` and
//     `overnight` tasks against the repo it owns.
//   FirehoseAgent    — consumes `webhook` queue messages; owns delivery
//     bookkeeping (per-subscriber ledgers, dead-letter state) so delivery
//     history is observable instead of buried in queue retries.
//
// All three share AgentRuntime: a small Think-style base providing
//   - `memory`    — JSON blob persisted in DO storage
//   - task ledger — every processed message appends a durable record
//   - `/status`   — introspection fetch surface

export interface TaskRecord {
  id: string;
  kind: string;
  status: "running" | "ok" | "failed";
  startedAt: number;
  finishedAt?: number;
  detail?: string;
}

export interface QueueTaskResult {
  /** "ack" finishes the queue message; "retry" defers to queue backoff. */
  action: "ack" | "retry";
  detail?: string;
}

const TASK_LEDGER_LIMIT = 64;
const MEM_KEY = "agent/memory";
const TASK_PREFIX = "task/";

export abstract class AgentRuntime extends DurableObject<Env> {
  abstract readonly role: string;

  /** Dispatch a queue body to the agent's handler. */
  abstract process(kind: string, body: unknown): Promise<QueueTaskResult>;

  /** RPC entrypoint for queue consumers. Returns the disposition. */
  async runQueueTask(body: unknown): Promise<QueueTaskResult> {
    const kind =
      typeof body === "object" && body !== null && "kind" in body
        ? String((body as { kind: unknown }).kind)
        : "task";
    const task = await this.beginTask(kind);
    try {
      const result = await this.process(kind, body);
      await this.finishTask(task, result.action === "ack" ? "ok" : "failed", result.detail);
      return result;
    } catch (error) {
      await this.finishTask(task, "failed", String(error));
      return { action: "retry", detail: String(error) };
    }
  }

  /** Read memory blob (JSON) persisted for this agent. */
  protected async memory<T>(): Promise<T | undefined> {
    return (await this.ctx.storage.get<T>(MEM_KEY)) ?? undefined;
  }

  /** Merge-update memory. */
  protected async remember(patch: Record<string, unknown>): Promise<void> {
    const cur = (await this.memory<Record<string, unknown>>()) ?? {};
    await this.ctx.storage.put(MEM_KEY, { ...cur, ...patch });
  }

  protected async setMemory(value: unknown): Promise<void> {
    await this.ctx.storage.put(MEM_KEY, value);
  }

  private async beginTask(kind: string): Promise<TaskRecord> {
    const task: TaskRecord = {
      id: crypto.randomUUID(),
      kind,
      status: "running",
      startedAt: Date.now(),
    };
    await this.ctx.storage.put(`${TASK_PREFIX}${task.startedAt}:${task.id}`, task);
    return task;
  }

  private async finishTask(task: TaskRecord, status: "ok" | "failed", detail?: string) {
    task.status = status;
    task.finishedAt = Date.now();
    if (detail) task.detail = detail.slice(0, 500);
    await this.ctx.storage.put(`${TASK_PREFIX}${task.startedAt}:${task.id}`, task);
    // Cap the ledger — drop oldest records past the limit.
    const all = await this.ctx.storage.list<TaskRecord>({ prefix: TASK_PREFIX });
    if (all.size > TASK_LEDGER_LIMIT) {
      const keys = [...all.keys()].sort().slice(0, all.size - TASK_LEDGER_LIMIT);
      await this.ctx.storage.delete(keys);
    }
  }

  async recentTasks(limit = 20): Promise<TaskRecord[]> {
    const all = await this.ctx.storage.list<TaskRecord>({ prefix: TASK_PREFIX });
    return [...all.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  /** Introspection surface: GET /status → role, memory, recent task ledger. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/status") return new Response("not found", { status: 404 });
    return Response.json({
      role: this.role,
      memory: (await this.memory()) ?? null,
      recentTasks: await this.recentTasks(),
    });
  }
}

// ---------------------------------------------------------------------------
// AdjudicatorAgent — the Workers-AI quorum seat as a stateful agent.
// ---------------------------------------------------------------------------

import { runWorkersAiAdjudication } from "@/worker/tasks/adjudicate";
import { runFederateTask } from "@/worker/tasks/federate";
import { runOvernightPass } from "@/worker/agent/overnight";
import { runSiteSmithPass } from "@/worker/agent/siteSmith";
import { deliverWebhook } from "@/worker/agent/webhooks";
import type {
  AdjudicateQueueMessage,
  FederateQueueMessage,
  OvernightQueueMessage,
  SiteBuildQueueMessage,
  WebhookQueueMessage,
} from "@/worker/tasks/types";

export class AdjudicatorAgent extends AgentRuntime {
  readonly role = "adjudicator";

  async process(kind: string, body: unknown): Promise<QueueTaskResult> {
    if (kind !== "adjudicate") return { action: "ack", detail: `ignored:${kind}` };
    const msg = body as AdjudicateQueueMessage;
    const outcome = await runWorkersAiAdjudication(this.env, msg.doId, msg.intentId);
    await this.remember({
      lastIntentId: msg.intentId,
      lastOutcome: outcome.status,
      votesCast:
        Number(((await this.memory()) as { votesCast?: number } | undefined)?.votesCast ?? 0) +
        (outcome.voted ? 1 : 0),
    });
    return {
      action: "ack",
      detail: `intent=${msg.intentId} voted=${outcome.voted} resolved=${outcome.resolved}`,
    };
  }
}

// ---------------------------------------------------------------------------
// RepoAgent — per-repo actor (federation mirror-out, overnight self-improve).
// ---------------------------------------------------------------------------

export class RepoAgent extends AgentRuntime {
  readonly role = "repo-agent";

  async process(kind: string, body: unknown): Promise<QueueTaskResult> {
    if (kind === "federate") {
      const msg = body as FederateQueueMessage;
      const outcome = await runFederateTask(this.env, msg);
      return {
        action: outcome.retry ? "retry" : "ack",
        detail: outcome.detail,
      };
    }
    if (kind === "overnight") {
      const msg = body as OvernightQueueMessage;
      const outcome = await runOvernightPass(this.env, msg);
      return { action: "ack", detail: outcome.detail };
    }
    if (kind === "site-build") {
      const msg = body as SiteBuildQueueMessage;
      const outcome = await runSiteSmithPass(this.env, msg);
      return { action: "ack", detail: outcome.detail };
    }
    return { action: "ack", detail: `ignored:${kind}` };
  }
}

// ---------------------------------------------------------------------------
// FirehoseAgent — webhook delivery with a durable per-subscriber ledger.
// ---------------------------------------------------------------------------

interface FirehoseLedger {
  delivered: number;
  failed: number;
  lastError?: string;
  lastDeliveredAt?: number;
}

/** Durable per-delivery record — what the gitness webhook-executions UI reads. */
export interface FirehoseDelivery {
  id: string;
  url: string;
  kind: string;
  status: number;
  ok: boolean;
  error?: string;
  startedAt: number;
  finishedAt: number;
  /** Original event payload as JSON (capped) — retrigger replays it verbatim. */
  payloadJson?: string;
}

const DELIVERY_PREFIX = "whdel:";
const DELIVERY_LIMIT = 500;

export class FirehoseAgent extends AgentRuntime {
  readonly role = "firehose";

  /** Delivery history for a single subscriber URL, newest first. */
  async webhookDeliveries(url: string, limit = 50): Promise<FirehoseDelivery[]> {
    const all = await this.ctx.storage.list<FirehoseDelivery>({
      prefix: `${DELIVERY_PREFIX}${url}:`,
    });
    return [...all.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  async process(kind: string, body: unknown): Promise<QueueTaskResult> {
    if (kind !== "webhook") return { action: "ack", detail: `ignored:${kind}` };
    const msg = body as WebhookQueueMessage;
    const startedAt = Date.now();
    const result = await deliverWebhook({
      url: msg.url,
      kind: msg.event.kind,
      payload: msg.event.payload,
      secret: msg.secret ?? null,
    });

    const ledgers = ((await this.memory()) as Record<string, FirehoseLedger> | undefined) ?? {};
    const ledger = ledgers[msg.url] ?? { delivered: 0, failed: 0 };
    if (result.ok) {
      ledger.delivered += 1;
      ledger.lastDeliveredAt = Date.now();
    } else {
      ledger.failed += 1;
      ledger.lastError = `status=${result.status}`;
    }
    ledgers[msg.url] = ledger;
    await this.setMemory(ledgers);

    // Durable per-attempt record — executions UI + failure forensics.
    const payloadText = JSON.stringify(msg.event.payload ?? {});
    const delivery: FirehoseDelivery = {
      id: `${startedAt}:${crypto.randomUUID().slice(0, 8)}`,
      url: msg.url,
      kind: msg.event.kind,
      status: result.status,
      ok: result.ok,
      error: result.ok ? undefined : `status=${result.status}`,
      startedAt,
      finishedAt: Date.now(),
      payloadJson: payloadText.length <= 8192 ? payloadText : undefined,
    };
    await this.ctx.storage.put(`${DELIVERY_PREFIX}${msg.url}:${delivery.id}`, delivery);
    // Cap the per-URL log — drop the oldest beyond the limit.
    const stored = await this.ctx.storage.list<FirehoseDelivery>({
      prefix: `${DELIVERY_PREFIX}${msg.url}:`,
    });
    if (stored.size > DELIVERY_LIMIT) {
      const keys = [...stored.keys()].sort().slice(0, stored.size - DELIVERY_LIMIT);
      await this.ctx.storage.delete(keys);
    }

    if (!result.ok) {
      // Let the queue retry; the ledger keeps the failure visible.
      return { action: "retry", detail: `delivery-failed status=${result.status}` };
    }
    return { action: "ack", detail: `delivered ${msg.event.kind}` };
  }
}
