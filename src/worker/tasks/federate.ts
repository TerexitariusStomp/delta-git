import type { FederateQueueMessage } from "./types";

import { createLogger } from "@/worker/common";
import { jobSandbox } from "@/worker/compute/sandbox";
import { bytesToHex } from "@/worker/common/hex";
import { collectPushObjects, parseAdvertisedRefs, pushRefToRemote } from "@/worker/git/remote/push";
import { repoDidFor } from "@/worker/agent/dids";
import { createDb } from "@/worker/db/d1/client";
import { findRepositoryByDoName } from "@/worker/db/d1/dal";
import { eq } from "drizzle-orm";
import { namespaces, repositories } from "@/worker/db/d1/schema";

// Mirror-out federation.
//
// When a public ref advances, the queue hands the RepoAgent a `federate`
// message; this module pushes the delta to configured mirror targets so
// public repos don't ride our infra:
//   - `https://` git remotes get a real smart-HTTP receive-pack push
//   - `ssh://`/`git@` targets push inside a ForgeSandbox under the platform
//     mirror identity (`MIRROR_SSH_PRIVATE_KEY`); without the key they fall
//     back to the signed relay webhook.
//   - `rad://`/`tangled://` targets get a signed relay webhook — an off-box
//     contrib agent (see docs/agent-integration.md) performs the actual
//     protocol-specific push.
//
// Mirror targets come from the queue message, falling back to the
// `FEDERATE_TARGETS` env var (JSON array of {name,url}) and the repo's
// `mirrorTargets` metadata column.

const te = new TextEncoder();

export interface FederateTarget {
  name: string;
  url: string;
}

export interface FederateOutcome {
  retry: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Relay fallback for non-HTTP targets (ssh://, rad://, tangled://)
// ---------------------------------------------------------------------------

async function relayPushRequest(
  env: Env,
  target: FederateTarget,
  payload: { repoDid: string; doId: string; ref: string; sha: string }
): Promise<{ ok: boolean; detail: string }> {
  const relay = (env as { FEDERATION_RELAY_URL?: string }).FEDERATION_RELAY_URL;
  if (!relay) return { ok: false, detail: "no-relay-configured" };
  const body = te.encode(JSON.stringify({ target, ...payload }));
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = (env as { FEDERATION_RELAY_SECRET?: string }).FEDERATION_RELAY_SECRET;
  if (secret) {
    const key = await crypto.subtle.importKey(
      "raw",
      te.encode(secret) as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, body as BufferSource);
    headers["x-dg-federate-sig"] = bytesToHex(new Uint8Array(sig));
  }
  const res = await fetch(relay, { method: "POST", headers, body });
  return res.ok
    ? { ok: true, detail: "relayed" }
    : { ok: false, detail: `relay http ${res.status}` };
}

// ---------------------------------------------------------------------------
// In-container ssh:// mirror pushes
// ---------------------------------------------------------------------------
//
// Workers can't open TCP/22, so ssh targets historically deferred to a
// relay. The ForgeSandbox image carries openssh-client + git: clone the
// repo's public smart-HTTP remote inside the container and `git push
// --mirror` to the ssh target under the platform mirror identity
// (`MIRROR_SSH_PRIVATE_KEY` secret — an ed25519 deploy key enrolled at the
// target). Only public repos ever reach this path.
async function sshMirrorPush(
  env: Env,
  target: FederateTarget,
  cloneSource: string,
  jobKey: string
): Promise<{ ok: boolean; detail: string }> {
  const key = (env as { MIRROR_SSH_PRIVATE_KEY?: string }).MIRROR_SSH_PRIVATE_KEY;
  if (!key?.trim()) return { ok: false, detail: "no-mirror-key" };

  const sandbox = jobSandbox(env, jobKey, "federate", target.name, {
    containerTimeouts: { instanceGetTimeoutMS: 60_000 },
  });
  try {
    const write = await sandbox.writeFile("/root/.ssh/mirror_key", `${key.trim()}\n`);
    if (!write.success) return { ok: false, detail: "key-write-failed" };
    const sshCommand =
      "ssh -i /root/.ssh/mirror_key -o StrictHostKeyChecking=accept-new " +
      "-o UserKnownHostsFile=/root/.ssh/known_hosts -o IdentitiesOnly=yes";
    const clone = await sandbox.exec(
      `mkdir -p /root/.ssh && chmod 700 /root/.ssh && chmod 600 /root/.ssh/mirror_key && ` +
        `rm -rf /tmp/mirror && git clone --mirror '${cloneSource}' /tmp/mirror`,
      { timeout: 300_000 }
    );
    if (!clone.success) {
      return { ok: false, detail: `clone failed: ${(clone.stderr || clone.stdout).slice(0, 200)}` };
    }
    const push = await sandbox.exec(`git -C /tmp/mirror push --mirror '${target.url}'`, {
      timeout: 300_000,
      env: { GIT_SSH_COMMAND: sshCommand },
    });
    if (!push.success) {
      return { ok: false, detail: `push failed: ${(push.stderr || push.stdout).slice(0, 200)}` };
    }
    return { ok: true, detail: "ssh-pushed" };
  } catch (e) {
    return { ok: false, detail: `sandbox: ${String(e).slice(0, 120)}` };
  } finally {
    // The private key lives only for the duration of the push.
    await sandbox.exec("rm -f /root/.ssh/mirror_key /root/.ssh/known_hosts").catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Task entrypoint
// ---------------------------------------------------------------------------

/** Enqueue a mirror-out pass for an advanced heads ref. Fire-and-forget —
 * the task itself decides whether any targets exist. */
export async function enqueueFederatePush(
  env: Env,
  doId: string,
  repoId: string | undefined,
  ref: string,
  sha: string
): Promise<void> {
  await env.REPO_TASKS_QUEUE.send({
    kind: "federate",
    doId,
    repoId,
    ref,
    sha,
  });
}

/** Injectable seam for worker tests — the queue path always uses global fetch. */
export interface FederateDeps {
  fetch?: typeof fetch;
}

export async function runFederateTask(
  env: Env,
  msg: FederateQueueMessage,
  deps: FederateDeps = {}
): Promise<FederateOutcome> {
  const log = createLogger(env.LOG_LEVEL, { service: "Federate", repoId: msg.repoId });

  // Resolve repo identity + configured mirrors. Private repos never mirror.
  // `msg.repoId` is the repo DO name (all enqueue sites pass it), so resolve
  // by `do_name`, not primary key.
  let targets: FederateTarget[] = msg.targets?.map((url) => ({ name: url, url })) ?? [];
  let repoDid: string | undefined;
  let nsSlug: string | undefined;
  let repoSlug: string | undefined;
  if (msg.repoId) {
    const db = createDb(env.DB);
    const repo = await findRepositoryByDoName(db, msg.repoId);
    if (repo && repo.visibility !== "public") {
      return { retry: false, detail: "private-repo" };
    }
    if (repo) {
      const ns = await db
        .select()
        .from(namespaces)
        .where(eq(namespaces.id, repo.namespaceId))
        .limit(1);
      const slug = ns[0]?.slug ?? msg.repoId;
      nsSlug = ns[0]?.slug;
      repoSlug = repo.slug;
      repoDid = repo.did ?? (await repoDidFor(slug, repo.slug));
      if (!repo.did) {
        await db.update(repositories).set({ did: repoDid }).where(eq(repositories.id, repo.id));
      }
      if (repo.mirrorTargets) {
        try {
          targets = targets.concat(JSON.parse(repo.mirrorTargets) as FederateTarget[]);
        } catch {
          /* malformed mirror_targets metadata — ignore */
        }
      }
    }
  }
  if (targets.length === 0) {
    const envTargets = (env as { FEDERATE_TARGETS?: string }).FEDERATE_TARGETS;
    if (envTargets) {
      try {
        targets = (JSON.parse(envTargets) as FederateTarget[]).map((t) =>
          typeof t === "string" ? { name: t, url: t } : t
        );
      } catch {
        /* ignore */
      }
    }
  }
  if (targets.length === 0) return { retry: false, detail: "no-targets" };

  const results: string[] = [];
  let retry = false;
  for (const target of targets.slice(0, 8)) {
    try {
      if (target.url.startsWith("https://") || target.url.startsWith("http://")) {
        // Object reads go through the repo DO by *name* — `msg.repoId` is the
        // doName; `msg.doId` is the DO's hex id and idFromName() would route
        // object reads to a different, empty DO.
        const r = await pushRefToRemote(
          env,
          msg.repoId ?? msg.doId,
          target.url,
          msg.ref,
          msg.sha,
          deps.fetch
        );
        results.push(`${target.name}:${r.ok ? "ok" : "fail"}(${r.detail})`);
        if (!r.ok) retry = true;
      } else if (target.url.startsWith("ssh://") || target.url.startsWith("git@")) {
        // In-container mirror push under the platform SSH identity. The
        // clone source is our own public smart-HTTP remote — only public
        // repos ever reach federation.
        const origin = (env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN;
        const cloneSource =
          origin && repoSlug && nsSlug
            ? `${origin}/${nsSlug}/${repoSlug}.git`
            : null;
        let r: { ok: boolean; detail: string };
        if (cloneSource) {
          r = await sshMirrorPush(env, target, cloneSource, msg.repoId ?? msg.doId);
        } else {
          r = { ok: false, detail: "no-clone-source" };
        }
        if (!r.ok && r.detail === "no-mirror-key") {
          // No platform key enrolled → the relay path remains the escape
          // hatch for off-box push agents.
          r = await relayPushRequest(env, target, {
            repoDid: repoDid ?? msg.doId,
            doId: msg.doId,
            ref: msg.ref,
            sha: msg.sha,
          });
          results.push(`${target.name}:${r.ok ? "relayed" : "fail"}(${r.detail})`);
        } else {
          results.push(`${target.name}:${r.ok ? "ok" : "fail"}(${r.detail})`);
        }
        if (!r.ok) retry = true;
      } else {
        const r = await relayPushRequest(env, target, {
          repoDid: repoDid ?? msg.doId,
          doId: msg.doId,
          ref: msg.ref,
          sha: msg.sha,
        });
        results.push(`${target.name}:${r.ok ? "relayed" : "fail"}(${r.detail})`);
        if (!r.ok) retry = true;
      }
    } catch (error) {
      log.warn("federate:target-error", { target: target.name, error: String(error) });
      results.push(`${target.name}:error(${String(error).slice(0, 80)})`);
      retry = true;
    }
  }
  log.info("federate:done", { ref: msg.ref, sha: msg.sha, results });
  return { retry, detail: results.join(", ").slice(0, 480) };
}

// Test seam — exercised by test/federate.worker.test.ts.
export const __test = { collectPushObjects, parseAdvertisedRefs };
