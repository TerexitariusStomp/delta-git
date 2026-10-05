import { readObject } from "@/worker/git/object-store/store";
import { parseCommitText } from "@/worker/git/core";
import { buildPackV2 } from "@/worker/git/pack/build";
import { parseTree, isTreeMode } from "@/worker/git/core/tree";
import { readCommit } from "@/worker/merge/engine";

// Smart-HTTP receive-pack push client (protocol v0/v1 framing).
//
// Extracted from tasks/federate.ts so both federation mirror-out and the
// Artifacts merge-out path share one implementation. Artifacts remotes
// speak v1 receive-pack (v2 push is unsupported upstream), which this
// framing already produces.
//
// `doName` arguments are the repo DO *name* (`owner/repo` or `repo:<id>`),
// not the hex DO id: `readObject`/`readCommit` resolve via `idFromName`.

const td = new TextDecoder();
const te = new TextEncoder();

const WALK_CAP_COMMITS = 256;
const WALK_CAP_OBJECTS = 5000;
const ZERO_OID = "0".repeat(40);

// ---------------------------------------------------------------------------
// Advertisement parsing (v0-style receive-pack info/refs)
// ---------------------------------------------------------------------------

export function parseAdvertisedRefs(buf: Uint8Array): Map<string, string> {
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
 */
export async function collectPushObjects(
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

/** Split `https://user:pass@host/path` → clean base + Basic auth header.
 * Mirror credentials live in the target URL, never logged or stored apart. */
export function splitRemoteAuth(url: string): { base: string; auth?: string } {
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

export interface PushRefResult {
  ok: boolean;
  detail: string;
}

/**
 * Push `ref` → `sha` to a smart-HTTP remote using protocol v0/v1
 * receive-pack framing. Fetches the advertised refs first so only missing
 * objects are packed. Artifacts remotes accept this flow over v1
 * receive-pack; credentials (e.g. `art_v1_*` tokens) ride in the URL
 * userinfo via `splitRemoteAuth`.
 */
export async function pushRefToRemote(
  env: Env,
  doName: string,
  url: string,
  ref: string,
  sha: string,
  fetchImpl: typeof fetch = fetch,
  extraHeaders?: Record<string, string>
): Promise<PushRefResult> {
  const { base, auth } = splitRemoteAuth(url);
  // URL userinfo (Basic) covers federation mirrors; Bearer tokens for
  // Artifacts remotes arrive via extraHeaders and take precedence.
  const headers: Record<string, string> = auth ? { Authorization: auth } : {};
  if (extraHeaders) Object.assign(headers, extraHeaders);
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
