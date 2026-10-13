// Cron-driven background work — monitor probes, delegate staleness reaper,
// and certificate-expiry notifications. Crons are configured in
// wrangler.jsonc `triggers.crons`.

import { createDb } from "@/worker/db/d1";
import type { Db } from "@/worker/db/d1";
import { createLogger } from "@/worker/common/logger";
import {
  insertCostSnapshot,
  listAllCertificates,
  listAllEnabledMonitors,
  listCostSnapshots,
  listOnlineDelegates,
  updateCertificate,
  updateDelegate,
} from "@/worker/db/d1/dal/modules";
import { deliverNotification } from "@/worker/notify/notify";
import { listAllNamespaces, listMembershipsForNamespace } from "@/worker/db/d1/dal/namespaces";
import { probeCertificateExpiry } from "@/worker/api/gitness/certProbe";
import { getStorageUsed } from "@/worker/agent/abuse";
import { newPrefixedId } from "@/worker/common";
import { runMonitorProbe } from "@/worker/api/gitness/reliability";
import {
  readCronPipelineRepos,
  readRepoPipelines,
  writeRepoPipelines,
} from "@/worker/api/gitness/stores";
import { createExecution } from "@/worker/api/gitness/executions";
import { nextCronFire } from "@/worker/tasks/cronmatch";
import { enqueueRunnerDispatch } from "@/worker/tasks/runner";

const log = createLogger(undefined, { service: "scheduled" });

// Delegates that haven't heartbeated in this window get marked offline.
const DELEGATE_STALE_MS = 15 * 60 * 1000;
// Certificates inside this horizon are surfaced to every space member.
const CERT_NOTIFY_MS = 30 * 24 * 3600 * 1000;
// Expiry notifications dedupe to at most one round per day per certificate.
const CERT_NOTIFY_COOLDOWN_MS = 24 * 3600 * 1000;
// R2 storage is billed $0.015 per GiB-month — the projected monthly cost
// of the metered usage, in cents.
const R2_CENTS_PER_GIB_MONTH = 1.5;
const GIB = 1024 * 1024 * 1024;

export async function handleScheduled(cron: string, env: Env): Promise<void> {
  const db = createDb(env.DB);
  const now = Date.now();
  // `0 * * * *` (hourly) carries the heavier scans; the 5-minute cron runs
  // probes + reaper only. Match on cron string so a schedule tweak can't
  // silently move work between tiers.
  if (cron === "0 * * * *") {
    await scanCertificates(env, db, now);
    await snapshotMeteredCosts(env, db, now);
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
        await enqueueRunnerDispatch(env, doName).catch(() => undefined);
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

async function scanCertificates(env: Env, db: Db<D1Database>, now: number): Promise<void> {
  const certs = await listAllCertificates(db);
  for (const cert of certs) {
    // Refresh the asserted expiry from the CT log — notifications track
    // reality even when the tracked record was entered by hand.
    const probe = await probeCertificateExpiry(cert.domain);
    let expiresAt = cert.expiresAt;
    if (probe.ok && probe.expiresAt !== undefined) {
      expiresAt = probe.expiresAt;
      await updateCertificate(db, cert.id, {
        expiresAt,
        issuer: probe.issuer ?? cert.issuer,
        lastProbedAt: now,
      });
    }
    const daysLeft = Math.floor((expiresAt - now) / 86_400_000);
    if (expiresAt - now > CERT_NOTIFY_MS) continue;
    // Dedupe: one notification round per certificate per day.
    if (cert.lastNotifiedAt !== null && now - cert.lastNotifiedAt < CERT_NOTIFY_COOLDOWN_MS) {
      continue;
    }
    const members = await listMembershipsForNamespace(db, cert.namespaceId);
    for (const member of members) {
      await deliverNotification(env, db, {
        id: newPrefixedId("ntf"),
        userId: member.userId,
        kind: "incident",
        title: `Certificate ${cert.domain} ${daysLeft < 0 ? "expired" : `expires in ${daysLeft}d`}`,
        body: `issuer ${probe.issuer ?? cert.issuer ?? "unknown"} · expires ${new Date(expiresAt).toISOString().slice(0, 10)}${probe.ok ? "" : " · probe failed"}`,
        link: null,
        createdAt: now,
        readAt: null,
      }).catch(() => {});
    }
    await updateCertificate(db, cert.id, { lastNotifiedAt: now });
  }
}

/**
 * Hourly metered cost snapshot: reads the real per-namespace R2 storage
 * counter from the quota meter and records a projected monthly cost. One
 * row per namespace per hour — the aggregator de-dupes by hour bucket so
 * a delayed cron doesn't double-count.
 */
async function snapshotMeteredCosts(env: Env, db: Db<D1Database>, now: number): Promise<void> {
  const hourBucket = Math.floor(now / 3_600_000) * 3_600_000;
  const namespaces = await listAllNamespaces(db);
  for (const ns of namespaces) {
    const latest = await listCostSnapshots(db, ns.id);
    const alreadyMetered = latest.some(
      (s) => s.provider === "cloudflare" && s.service === "r2-storage" && s.periodStart === hourBucket
    );
    if (alreadyMetered) continue;
    const bytes = await getStorageUsed(env.ROUTES, ns.id).catch(() => 0);
    const amountCents = Math.round((bytes / GIB) * R2_CENTS_PER_GIB_MONTH);
    await insertCostSnapshot(db, {
      id: newPrefixedId("cst"),
      namespaceId: ns.id,
      provider: "cloudflare",
      service: "r2-storage",
      amountCents,
      currency: "USD",
      periodStart: hourBucket,
      periodEnd: hourBucket + 3_600_000,
      createdAt: now,
    });
  }
}
