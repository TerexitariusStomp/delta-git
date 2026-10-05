// Gitness `POST /repos/{ref}/commits` ("commit files") → delta objects.
//
// The gitness commit-files request is a bag of file actions applied on top
// of a branch head. We rebuild the tree exactly the way `applyManifest`
// does (setTreePath per action, fresh blobs) — the output feeds the same
// staged-pack + acceptPatchCommit + attemptMerge pipeline as `/dg/patch`,
// so an API commit is a merge intent that lands immediately when clean.
//
// Action mapping (`GitFileAction`):
//   CREATE/UPDATE → write payload as a new blob at `path`
//   DELETE        → remove `path`
//   MOVE          → delete `path`, write payload/blob at `payload`?? — see
//                   note on movePayload below
//   PATCH_TEXT    → jsdiff `applyPatch` of the payload onto the existing
//                   blob text (strict, fuzzFactor 0)
//
// Gitness MOVE semantics: `path` is the *destination*, `payload` carries the
// *source* path (the Harness backend treats the pair as old→new). We honor
// that: the source entry's blob oid is reused so no blob copy is needed.

import { applyPatch } from "diff";
import type { CacheContext } from "@/worker/cache";
import type { NewObject } from "@/worker/merge/packWriter";
import type { PatchApplyResult } from "@/worker/agent/patch";
import { computeOid, parseCommitText } from "@/worker/git/core";
import { serializeTree } from "@/worker/git/core/tree";
import { readPayload, resolvePathEntry, setTreePath } from "@/worker/agent/patch";

const td = new TextDecoder();
const te = new TextEncoder();

const MAX_ACTIONS = 256;
const MAX_ACTION_BYTES = 2 * 1024 * 1024;

export interface CommitFileAction {
  action?: string;
  encoding?: string;
  path?: string;
  payload?: string;
  sha?: string;
}

export interface CommitFilesRequest {
  actions?: CommitFileAction[] | null;
  author?: { name?: string; email?: string } | null;
  branch?: string;
  new_branch?: string;
  message?: string;
  title?: string;
}

function decodePayload(action: CommitFileAction): Uint8Array | null {
  if (action.payload === undefined) return new Uint8Array(0);
  if (action.encoding === "base64") {
    try {
      const bin = atob(action.payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch {
      return null;
    }
  }
  // gitness "text" encoding is the default for editor payloads.
  return te.encode(action.payload);
}

/**
 * Apply commit-file actions against `baseCommitOid` and return the new
 * commit oid plus every object a pack must carry. Mirrors applyManifest's
 * commit construction (single parent, author=committer sig).
 */
export async function commitFileActions(args: {
  env: Env;
  repoId: string;
  baseCommitOid: string | undefined;
  req: CommitFilesRequest;
  author: string;
  cacheCtx?: CacheContext;
}): Promise<PatchApplyResult> {
  const { env, repoId, cacheCtx, req } = args;
  const actions = req.actions ?? [];
  if (actions.length === 0) return { kind: "failed", reason: "no-actions" };
  if (actions.length > MAX_ACTIONS) return { kind: "failed", reason: "too-many-actions" };

  const objects: NewObject[] = [];
  let treeOid: string;
  let parentLine = "";
  if (args.baseCommitOid) {
    const commitObj = await readPayload(env, repoId, args.baseCommitOid, cacheCtx);
    if (!commitObj || commitObj.type !== "commit") {
      return { kind: "failed", reason: "base-commit-missing" };
    }
    const baseCommit = parseCommitText(td.decode(commitObj.payload));
    if (!baseCommit.tree) return { kind: "failed", reason: "base-tree-missing" };
    treeOid = baseCommit.tree;
    parentLine = `parent ${args.baseCommitOid}\n`;
  } else {
    const empty = serializeTree(new Map());
    treeOid = await computeOid("tree", empty);
    objects.push({ type: "tree", payload: empty, oid: treeOid });
  }

  const setPath = async (path: string, entry: { mode: string; oid: string } | null) => {
    const next = await setTreePath({ env, repoId, treeOid, path, entry, cacheCtx, objects });
    if (next === undefined) throw new Error(`bad-path:${path}`);
    treeOid = next;
  };

  try {
    for (const action of actions) {
      const path = action.path?.replace(/^\/+|\/+$/g, "");
      if (!path) return { kind: "failed", reason: "missing-path" };
      const kind = (action.action ?? "UPDATE").toUpperCase();

      if (kind === "DELETE") {
        await setPath(path, null);
        continue;
      }
      if (kind === "MOVE") {
        // `payload` is the source path; reuse its blob oid under `path`.
        const source = action.payload?.replace(/^\/+|\/+$/g, "");
        if (!source) return { kind: "failed", reason: "move-missing-source" };
        const entry = await resolvePathEntry(env, repoId, treeOid, source, cacheCtx, objects);
        if (!entry) return { kind: "failed", reason: `missing-file:${source}` };
        await setPath(source, null);
        await setPath(path, entry);
        continue;
      }
      if (kind === "PATCH_TEXT") {
        const entry = await resolvePathEntry(env, repoId, treeOid, path, cacheCtx, objects);
        const blob = entry ? await readPayload(env, repoId, entry.oid, cacheCtx) : undefined;
        const oldText = blob?.type === "blob" ? td.decode(blob.payload) : "";
        const patched = applyPatch(oldText, action.payload ?? "", { fuzzFactor: 0 });
        if (patched === false) return { kind: "failed", reason: `patch-mismatch:${path}` };
        const bytes = te.encode(patched);
        const oid = await computeOid("blob", bytes);
        objects.push({ type: "blob", payload: bytes, oid });
        await setPath(path, { mode: "100644", oid });
        continue;
      }
      // CREATE / UPDATE — write the payload as a fresh blob.
      if (action.payload !== undefined && action.payload.length > MAX_ACTION_BYTES) {
        return { kind: "failed", reason: "payload-too-large" };
      }
      const bytes = decodePayload(action);
      if (bytes === null) return { kind: "failed", reason: "bad-base64" };
      const oid = await computeOid("blob", bytes);
      objects.push({ type: "blob", payload: bytes, oid });
      await setPath(path, { mode: "100644", oid });
    }
  } catch (e) {
    return { kind: "failed", reason: String(e).replace(/^Error: /, "") };
  }

  const message = req.message || req.title || "update files";
  const ts = Math.floor(Date.now() / 1000);
  const sig = `${args.author} ${ts} +0000`;
  const commitPayload = te.encode(
    `tree ${treeOid}\n${parentLine}author ${sig}\ncommitter ${sig}\n\n${message}\n`
  );
  const commitOid = await computeOid("commit", commitPayload);
  objects.push({ type: "commit", payload: commitPayload, oid: commitOid });
  return { kind: "ok", commitOid, objects };
}
