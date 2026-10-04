// P2: provisioning pipeline via CF Queues (Workers Paid).
// Bridge enqueues jobs; this consumer executes idempotently.
import type { Env } from "./env";
import { planFor } from "./plans";

interface Job { kind: "provision" | "suspend" | "upgrade" | "backup"; site_id: string; user_did: string; payload?: any }

export async function enqueue(env: Env & { PROVISION?: Queue }, job: Job) {
  await env.PROVISION?.send(job, { contentType: "json" });
}

export async function consumeBatch(batch: MessageBatch<Job>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const j = msg.body;
    try {
      switch (j.kind) {
        case "provision": {
          const user = await env.DB.prepare("SELECT plan FROM users WHERE did=?").bind(j.user_did).first<{ plan: string }>();
          const plan = planFor(user);
          if (plan.lane_max >= 3) {
            // Lane 3: configure + warm the tenant container via its DO
            const ns = (env as any).TENANT as DurableObjectNamespace | undefined;
            const stub = ns?.get(ns.idFromName(j.site_id));
            await doControl(stub, "configure", {
              siteId: j.site_id,
              alwaysOn: plan.always_on,
              cluster: plan.name === "Enterprise",
              webCount: 2,
            });
          }
          await env.DB.prepare("UPDATE sites SET status='active' WHERE id=?").bind(j.site_id).run();
          break;
        }
        case "suspend":
          await env.DB.prepare("UPDATE sites SET status='suspended' WHERE id=?").bind(j.site_id).run();
          break;
        case "backup": {
          const ns = (env as any).TENANT as DurableObjectNamespace | undefined;
          await doControl(ns?.get(ns.idFromName(j.site_id)), "sync-out");
          break;
        }
      }
      msg.ack();
    } catch { msg.retry({ delaySeconds: 30 }); }
  }
}

async function doControl(stub: DurableObjectStub | undefined, action: string, body?: any) {
  if (!stub) return;
  await stub.fetch("https://tenant.internal/control", {
    method: "POST",
    body: JSON.stringify({ action, body }),
  });
}
