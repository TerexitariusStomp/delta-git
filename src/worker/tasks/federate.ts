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
import { findRepositoryByDoName } from "@/worker/db/d1/dal";
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
  // Smart-HTTP v0 advert: `# service=` header pkt, a separator flush, then
  // the ref list terminated by a final flush. The first flush is a
  // separator, not end-of-stream — stopping there yields an empty map and
  // every push degenerates to a full-history send.
  let i = 0;
  let sawSeparator = false;
  while (i + 4 <= buf.length) {
    const len = parseInt(td.decode(buf.subarray(i, i + 4)), 16);
    if (len === 0 || !Number.isFinite(len)) {
      if (len === 0 && !sawSeparator) {
        sawSeparator = true;
        i += 4;
        continue;
      }
      break;
    }
    const line = td.decode(buf.subarray(i + 4, i + len));
    i += len;
    if (line.startsWith("#")) continue;
    const nul = line.indexOf("\0");
    const payload = (nul >= 0 ? line.slice(0, nul) : line).trimEnd();
    const m = /^([0-9a-f]{40}) (.+)$/.exec(payload);
    if (m) refs.set(m[2], m[1]);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Object collection — commits/trees/blobs the remote is missing
// ---------------------------------------------------------------------------

async function ancestorSet(
  env: Env,
  doName: string,
  seed: string | undefined
): Promise<Set<string>> {
  const seen = new Set<string>();
  if (!seed) return seen;
  const queue = [seed];
  while (queue.length > 0 && seen.size < 2048) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const commit = await readCommit(env, doName, cur, undefined);
    if (!commit) break;
    for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
  }
  return seen;
}

async function collectTreeObjects(
  env: Env,
  doName: string,
  treeOid: string,
  out: { type: "tree" | "blob"; payload: Uint8Array }[],
  cap: number
): Promise<boolean> {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    const obj = await readObject(env, doName, oid, undefined);
    if (!obj) return false;
    if (obj.type === "tree") {
      out.push({ type: "tree", payload: obj.payload });
      for (const entry of parseTree(obj.payload).values()) {
        if (isTreeMode(entry.mode)) stack.push(entry.oid);
        else {
          const blob = await readObject(env, doName, entry.oid, undefined);
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
 * exceeds caps or an object on the path is unreadable — a partial set would
 * produce a pack the remote rejects with `missing-objects`, so we fail the
 * task and let the queue retry instead.
 *
 * `doName` must be the repo DO *name* (`owner/repo`), not the hex DO id:
 * `readObject`/`readCommit` resolve the stub via `idFromName`.
 */
async function collectPushObjects(
  env: Env,
  doName: string,
  sha: string,
  remoteTips: Set<string>
): Promise<{ type: "commit" | "tree" | "blob"; payload: Uint8Array }[] | undefined> {
  const excluded = new Set<string>();
  for (const tip of remoteTips) {
    for (const a of await ancestorSet(env, doName, tip)) excluded.add(a);
    if (excluded.size > 4096) break;
  }
  const commits: string[] = [];
  const queue = [sha];
  const seen = new Set<string>();
  while (queue.length > 0 && commits.length < WALK_CAP_COMMITS) {
    const cur = queue.shift()!;
    if (seen.has(cur) || excluded.has(cur)) continue;
    seen.add(cur);
    const commit = await readCommit(env, doName, cur, undefined);
    if (!commit) return undefined;
    commits.push(cur);
    for (const p of commit.parents) if (!seen.has(p) && !excluded.has(p)) queue.push(p);
  }

  const objs: { type: "commit" | "tree" | "blob"; payload: Uint8Array }[] = [];
  const pushedTrees = new Set<string>();
  for (const oid of commits) {
    const obj = await readObject(env, doName, oid, undefined);
    if (!obj || obj.type !== "commit") return undefined;
    objs.push({ type: "commit", payload: obj.payload });
    const tree = parseCommitText(td.decode(obj.payload)).tree;
    if (!tree || pushedTrees.has(tree)) continue;
    pushedTrees.add(tree);
    const treeObjs: { type: "tree" | "blob"; payload: Uint8Array }[] = [];
    const ok = await collectTreeObjects(env, doName, tree, treeObjs, WALK_CAP_OBJECTS);
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

/** Split `https://user:pass@host/path` → clean base + Basic auth header.
 * Mirror credentials live in the target URL, never logged or stored apart. */
function splitRemoteAuth(url: string): { base: string; auth?: string } {
  try {
    const parsed = new URL(url);
    if (!parsed.username) return { base: url.replace(/\/$/, "") };
    const creds = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
    parsed.username = "";
    parsed.password = "";
    return {
      base: parsed.toString().replace(/\/$/, ""),
      auth: `Basic ${btoa(creds)}`,
    };
  } catch {
    return { base: url.replace(/\/$/, "") };
  }
}

async function pushRefToRemote(
  env: Env,
  doName: string,
  url: string,
  ref: string,
  sha: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; detail: string }> {
  const { base, auth } = splitRemoteAuth(url);
  const headers: Record<string, string> = auth ? { Authorization: auth } : {};
  const advRes = await fetchImpl(`${base}/info/refs?service=git-receive-pack`, { headers });
  if (!advRes.ok) return { ok: false, detail: `info/refs http ${advRes.status}` };
  const adv = parseAdvertisedRefs(new Uint8Array(await advRes.arrayBuffer()));
  const remoteTip = adv.get(ref);
  if (remoteTip === sha) return { ok: true, detail: "up-to-date" };

  const remoteTips = new Set(adv.values());
  const objs = await collectPushObjects(env, doName, sha, remoteTips);
  if (!objs) {
    return { ok: false, detail: "object-collection-failed" };
  }

  const commands = pkt(`${remoteTip ?? ZERO_OID} ${sha} ${ref}\0 report-status`);
  const flush = te.encode("0000");
  const pack = await buildPackV2(objs.map((o) => ({ type: o.type, payload: o.payload })));
  const body = concatBytes(commands, flush, pack);

  const res = await fetchImpl(`${base}/git-receive-pack`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-git-receive-pack-request" },
    body: body as unknown as BodyInit,
  });
  if (!res.ok) return { ok: false, detail: `receive-pack http ${res.status}` };
  // report-status is pkt-line framed binary — decode bytes, don't .text() it.
  const text = td.decode(new Uint8Array(await res.arrayBuffer()));
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
