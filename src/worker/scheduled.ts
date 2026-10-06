// Cron-driven background work — monitor probes, delegate staleness reaper,
// and certificate-expiry notifications. Crons are configured in
// wrangler.jsonc `triggers.crons`.

import { createDb } from "@/worker/db/d1";
import type { Db } from "@/worker/db/d1";
import { createLogger } from "@/worker/common/logger";
import {
  insertNotification,
  listAllCertificates,
  listAllEnabledMonitors,
  listOnlineDelegates,
  updateDelegate,
} from "@/worker/db/d1/dal/modules";
import { listMembershipsForNamespace } from "@/worker/db/d1/dal/namespaces";
import { newPrefixedId } from "@/worker/common";
import { runMonitorProbe } from "@/worker/api/gitness/reliability";
import {
  readCronPipelineRepos,
  readRepoPipelines,
  writeRepoPipelines,
} from "@/worker/api/gitness/stores";
import { createExecution } from "@/worker/api/gitness/executions";
import { nextCronFire } from "@/worker/tasks/cronmatch";

const log = createLogger(undefined, { service: "scheduled" });

// Delegates that haven't heartbeated in this window get marked offline.
const DELEGATE_STALE_MS = 15 * 60 * 1000;
// Certificates inside this horizon are surfaced to every space member.
const CERT_NOTIFY_MS = 30 * 24 * 3600 * 1000;

export async function handleScheduled(cron: string, env: Env): Promise<void> {
  const db = createDb(env.DB);
  const now = Date.now();
  // `0 * * * *` (hourly) carries the heavier scans; the 5-minute cron runs
  // probes + reaper only. Match on cron string so a schedule tweak can't
  // silently move work between tiers.
  if (cron === "0 * * * *") {
    await scanCertificates(db, now);
    return;
  }
  await probeDueMonitors(db, now);
  await reapStaleDelegates(db, now);
  await fireDueCronPipelines(env, now);
}

/**
 * Pipeline `schedule` triggers — walks only the repos indexed as holding an
 * enabled cron trigger (`gpipes-crons`, maintained by writeRepoPipelines).
 * Per-trigger `lastFired` is the high-water mark: the sweep fires once per
 * due occurrence window, then persists.
 */
async function fireDueCronPipelines(env: Env, now: number): Promise<void> {
  const doNames = await readCronPipelineRepos(env);
  let fired = 0;
  for (const doName of doNames) {
    const pipes = await readRepoPipelines(env, doName).catch(() => null);
    if (!pipes) continue;
    let changed = false;
    for (const pipe of pipes) {
      for (const trigger of pipe.triggers ?? []) {
        if (!trigger.enabled || trigger.event !== "cron" || !trigger.cron) continue;
        const due = nextCronFire(trigger.cron, trigger.lastFired ?? trigger.created);
        if (due === null || due > now) continue;
        await createExecution(env, doName, {
          pipeline: pipe,
          event: "cron",
          ref: `refs/heads/${pipe.default_branch ?? "main"}`,
          message: `schedule ${trigger.cron}`,
        });
        trigger.lastFired = now;
        changed = true;
        fired++;
      }
    }
    if (changed) {
      await writeRepoPipelines(env, doName, pipes).catch((err) =>
        log.warn("scheduled:cron-persist-failed", { doName, error: String(err) })
      );
    }
  }
  if (fired > 0) log.info("scheduled:cron-fired", { fired });
}

async function probeDueMonitors(db: Db<D1Database>, now: number): Promise<void> {
  const monitors = await listAllEnabledMonitors(db);
  let probed = 0;
  for (const row of monitors) {
    const due = row.lastCheckedAt === null || now - row.lastCheckedAt >= row.intervalSec * 1000;
    if (!due) continue;
    probed++;
    await runMonitorProbe(db, row).catch((error) => {
      log.warn("scheduled:monitor-probe-failed", { monitorId: row.id, error: String(error) });
    });
  }
  if (probed > 0) log.info("scheduled:monitors-probed", { probed });
}

async function reapStaleDelegates(db: Db<D1Database>, now: number): Promise<void> {
  const online = await listOnlineDelegates(db);
  let reaped = 0;
  for (const row of online) {
    const seen = row.lastSeenAt ?? row.createdAt;
    if (now - seen < DELEGATE_STALE_MS) continue;
    reaped++;
    await updateDelegate(db, row.id, { status: "offline" });
  }
  if (reaped > 0) log.info("scheduled:delegates-reaped", { reaped });
}

async function scanCertificates(db: Db<D1Database>, now: number): Promise<void> {
  const certs = await listAllCertificates(db);
  for (const cert of certs) {
    const daysLeft = Math.floor((cert.expiresAt - now) / 86_400_000);
    if (cert.expiresAt - now > CERT_NOTIFY_MS) continue;
    const members = await listMembershipsForNamespace(db, cert.namespaceId);
    for (const member of members) {
      await insertNotification(db, {
        id: newPrefixedId("ntf"),
        userId: member.userId,
        kind: "incident",
        title: `Certificate ${cert.domain} ${daysLeft < 0 ? "expired" : `expires in ${daysLeft}d`}`,
        body: `issuer ${cert.issuer ?? "unknown"} · expires ${new Date(cert.expiresAt).toISOString().slice(0, 10)}`,
        link: null,
        createdAt: now,
        readAt: null,
      }).catch(() => {});
    }
  }
}
