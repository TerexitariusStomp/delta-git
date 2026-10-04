import type { FederateQueueMessage } from "./types";

import { createLogger } from "@/worker/common";
import { bytesToHex } from "@/worker/common/hex";
import { readObject } from "@/worker/git/object-store/store";
import { parseCommitText } from "@/worker/git/core";
import { buildPackV2 } from "@/worker/git/pack/build";
import { parseTree, isTreeMode } from "@/worker/merge/tree";
import { readCommit } from "@/worker/merge/engine";
import { repoDidFor } from "@/worker/agent/dids";
import { createDb } from "@/worker/db/d1/client";
import { findRepositoryById } from "@/worker/db/d1/dal";
import { eq } from "drizzle-orm";
import { namespaces, repositories } from "@/worker/db/d1/schema";

// Mirror-out federation.
//
// When a public ref advances, the queue hands the RepoAgent a `federate`
// message; this module pushes the delta to configured mirror targets so
// public repos don't ride our infra:
//   - `https://` git remotes get a real smart-HTTP receive-pack push
//   - `ssh://`, `rad://`, `tangled://` targets can't be reached from a
//     Worker, so they get a signed relay webhook — an off-box contrib agent
//     (see docs/agent-integration.md) performs the actual push.
//
// Mirror targets come from the queue message, falling back to the
// `FEDERATE_TARGETS` env var (JSON array of {name,url}) and the repo's
// `mirrorTargets` metadata column.

const td = new TextDecoder();
const te = new TextEncoder();

const WALK_CAP_COMMITS = 256;
const WALK_CAP_OBJECTS = 5000;

export interface FederateTarget {
  name: string;
  url: string;
}

export interface FederateOutcome {
  retry: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Advertisement parsing (v0-style receive-pack info/refs)
// ---------------------------------------------------------------------------

function parseAdvertisedRefs(buf: Uint8Array): Map<string, string> {
  const refs = new Map<string, string>();
  // Pkt-line stream: first line carries capabilities after a NUL.
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(td.decode(buf.subarray(i, i + 4)), 16);
    if (len === 0 || !Number.isFinite(len)) break;
    const line = td.decode(buf.subarray(i + 4, i + len));
    const nul = line.indexOf("\0");
    const payload = (nul >= 0 ? line.slice(0, nul) : line).trimEnd();
    const m = /^([0-9a-f]{40}) (.+)$/.exec(payload);
    if (m) refs.set(m[2], m[1]);
    i += len;
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Object collection — commits/trees/blobs the remote is missing
// ---------------------------------------------------------------------------

async function ancestorSet(env: Env, doId: string, seed: string | undefined): Promise<Set<string>> {
  const seen = new Set<string>();
  if (!seed) return seen;
  const queue = [seed];
  while (queue.length > 0 && seen.size < 2048) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const commit = await readCommit(env, doId, cur, undefined);
    if (!commit) break;
    for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
  }
  return seen;
}

async function collectTreeObjects(
  env: Env,
  doId: string,
  treeOid: string,
  out: { type: "tree" | "blob"; payload: Uint8Array }[],
  cap: number
): Promise<boolean> {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    const obj = await readObject(env, doId, oid, undefined);
    if (!obj) return false;
    if (obj.type === "tree") {
      out.push({ type: "tree", payload: obj.payload });
      for (const entry of parseTree(obj.payload).values()) {
        if (isTreeMode(entry.mode)) stack.push(entry.oid);
        else {
          const blob = await readObject(env, doId, entry.oid, undefined);
          if (!blob || blob.type !== "blob") return false;
          out.push({ type: "blob", payload: blob.payload });
        }
      }
    } else if (obj.type === "blob") {
      out.push({ type: "blob", payload: obj.payload });
    }
    if (out.length >= cap) return false;
  }
  return true;
}

/**
 * Collect the objects reachable from `sha` that are not reachable from any
 * of the remote's known tips. Bounded; returns undefined when the walk
 * exceeds caps (mirror then falls back to a full clone on the remote side).
 */
async function collectPushObjects(
  env: Env,
  doId: string,
  sha: string,
  remoteTips: Set<string>
): Promise<{ type: "commit" | "tree" | "blob"; payload: Uint8Array }[] | undefined> {
  const excluded = new Set<string>();
  for (const tip of remoteTips) {
    for (const a of await ancestorSet(env, doId, tip)) excluded.add(a);
    if (excluded.size > 4096) break;
  }
  const commits: string[] = [];
  const queue = [sha];
  const seen = new Set<string>();
  while (queue.length > 0 && commits.length < WALK_CAP_COMMITS) {
    const cur = queue.shift()!;
    if (seen.has(cur) || excluded.has(cur)) continue;
    seen.add(cur);
    const commit = await readCommit(env, doId, cur, undefined);
    if (!commit) continue;
    commits.push(cur);
    for (const p of commit.parents) if (!seen.has(p) && !excluded.has(p)) queue.push(p);
  }

  const objs: { type: "commit" | "tree" | "blob"; payload: Uint8Array }[] = [];
  const pushedTrees = new Set<string>();
  for (const oid of commits) {
    const obj = await readObject(env, doId, oid, undefined);
    if (!obj || obj.type !== "commit") continue;
    objs.push({ type: "commit", payload: obj.payload });
    const tree = parseCommitText(td.decode(obj.payload)).tree;
    if (!tree || pushedTrees.has(tree)) continue;
    pushedTrees.add(tree);
    const treeObjs: { type: "tree" | "blob"; payload: Uint8Array }[] = [];
    const ok = await collectTreeObjects(env, doId, tree, treeObjs, WALK_CAP_OBJECTS);
    if (!ok) return undefined;
    objs.push(...treeObjs);
    if (objs.length > WALK_CAP_OBJECTS) return undefined;
  }
  return objs;
}

// ---------------------------------------------------------------------------
// Smart-HTTP receive-pack push
// ---------------------------------------------------------------------------

function pkt(s: string): Uint8Array {
  const body = te.encode(s);
  const len = te.encode((body.length + 4).toString(16).padStart(4, "0"));
  return concatBytes(len, body);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const ZERO_OID = "0".repeat(40);

async function pushRefToRemote(
  env: Env,
  doId: string,
  url: string,
  ref: string,
  sha: string
): Promise<{ ok: boolean; detail: string }> {
  const base = url.replace(/\/$/, "");
  const advRes = await fetch(`${base}/info/refs?service=git-receive-pack`);
  if (!advRes.ok) return { ok: false, detail: `info/refs http ${advRes.status}` };
  const adv = parseAdvertisedRefs(new Uint8Array(await advRes.arrayBuffer()));
  const remoteTip = adv.get(ref);
  if (remoteTip === sha) return { ok: true, detail: "up-to-date" };

  const remoteTips = new Set(adv.values());
  const objs = await collectPushObjects(env, doId, sha, remoteTips);
  if (!objs) {
    return { ok: false, detail: "object-walk-exceeded-cap" };
  }

  const commands = pkt(`${remoteTip ?? ZERO_OID} ${sha} ${ref}\0 report-status`);
  const flush = te.encode("0000");
  const pack = await buildPackV2(objs.map((o) => ({ type: o.type, payload: o.payload })));
  const body = concatBytes(commands, flush, pack);

  const res = await fetch(`${base}/git-receive-pack`, {
    method: "POST",
    headers: { "Content-Type": "application/x-git-receive-pack-request" },
    body: body as unknown as BodyInit,
  });
  if (!res.ok) return { ok: false, detail: `receive-pack http ${res.status}` };
  const text = await res.text();
  if (text.includes("unpack ok") && text.includes(`ok ${ref}`)) {
    return { ok: true, detail: `pushed ${objs.length} objects` };
  }
  return { ok: false, detail: `receive-pack result: ${text.slice(0, 200)}` };
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

export async function runFederateTask(
  env: Env,
  msg: FederateQueueMessage
): Promise<FederateOutcome> {
  const log = createLogger(env.LOG_LEVEL, { service: "Federate", repoId: msg.repoId });

  // Resolve repo identity + configured mirrors. Private repos never mirror.
  let targets: FederateTarget[] = msg.targets?.map((url) => ({ name: url, url })) ?? [];
  let repoDid: string | undefined;
  if (msg.repoId) {
    const db = createDb(env.DB);
    const repo = await findRepositoryById(db, msg.repoId);
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
        const r = await pushRefToRemote(env, msg.doId, target.url, msg.ref, msg.sha);
        results.push(`${target.name}:${r.ok ? "ok" : "fail"}(${r.detail})`);
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
