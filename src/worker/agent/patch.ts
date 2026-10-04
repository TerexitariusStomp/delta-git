import type { CacheContext } from "@/worker/cache";
import type { NewObject } from "@/worker/merge/packWriter";

import { parsePatch, type StructuredPatch } from "diff";
import { computeOid, parseCommitText } from "@/worker/git/core";
import { readObject } from "@/worker/git/object-store/store";
import { isTreeMode, parseTree, serializeTree, type Tree } from "@/worker/merge/tree";

// `POST /patch`: apply a unified diff to a base commit entirely server-side.
//
// The agent never clones — it posts the diff, we read the base tree, apply
// hunks, write new blob/tree/commit objects, and hand the caller a commit
// oid plus the object set that must be packed. The route then lands it via
// the same delta-ref + merge-intent machinery as a divergent push.

const td = new TextDecoder();
const te = new TextEncoder();

const MAX_PATCH_FILES = 256;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

export type PatchApplyResult =
  | { kind: "ok"; commitOid: string; objects: NewObject[] }
  | { kind: "failed"; reason: string };

export async function readPayload(
  env: Env,
  repoId: string,
  oid: string,
  cacheCtx: CacheContext | undefined
): Promise<{ type: string; payload: Uint8Array } | undefined> {
  const obj = await readObject(env, repoId, oid, cacheCtx);
  return obj ? { type: obj.type, payload: obj.payload } : undefined;
}

/** Apply one file's hunks to its current text; returns new text or null. */
function applyHunks(oldText: string | undefined, diff: StructuredPatch): string | null {
  const oldLines = oldText === undefined ? [] : oldText.split("\n");
  // Git text files conventionally end with a trailing newline; drop the
  // phantom final element so hunk offsets line up with real lines.
  const trailingEmpty = oldLines.length > 0 && oldLines[oldLines.length - 1] === "";
  const lines = trailingEmpty ? oldLines.slice(0, -1) : oldLines;

  const out: string[] = [];
  let cursor = 0;
  for (const hunk of diff.hunks) {
    const start = hunk.oldStart - 1;
    if (start < cursor) return null;
    out.push(...lines.slice(cursor, start));
    for (const line of hunk.lines) {
      const marker = line[0];
      const content = line.slice(1);
      if (marker === " " || marker === "-") {
        if (cursor >= lines.length || lines[cursor] !== content) return null;
        cursor++;
      }
      if (marker === "+" || marker === " ") out.push(content);
    }
  }
  out.push(...lines.slice(cursor));
  const joined = out.join("\n");
  // Preserve the trailing-newline convention when the old file had one or
  // when the result should be a text file at all.
  return oldText === undefined || trailingEmpty ? `${joined}\n` : joined;
}

/** Set/replace the blob at a slash path inside a tree, producing new trees. */
async function setTreePath(args: {
  env: Env;
  repoId: string;
  treeOid: string;
  path: string;
  entry: { mode: string; oid: string } | null;
  cacheCtx: CacheContext | undefined;
  objects: NewObject[];
}): Promise<string | undefined> {
  const { env, repoId, cacheCtx, objects } = args;
  const segments = args.path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;

  const treeObj = await readPayload(env, repoId, args.treeOid, cacheCtx);
  const tree: Tree = treeObj ? parseTree(treeObj.payload) : new Map();
  const head = segments[0];

  if (segments.length === 1) {
    if (args.entry === null) tree.delete(head);
    else tree.set(head, { mode: args.entry.mode, name: head, oid: args.entry.oid });
  } else {
    const child = tree.get(head);
    const childTreeOid =
      child && isTreeMode(child.mode)
        ? child.oid
        : await (async () => {
            const empty = serializeTree(new Map());
            const oid = await computeOid("tree", empty);
            objects.push({ type: "tree", payload: empty, oid });
            return oid;
          })();
    const newChild = await setTreePath({
      env,
      repoId,
      treeOid: childTreeOid,
      path: segments.slice(1).join("/"),
      entry: args.entry,
      cacheCtx,
      objects,
    });
    if (newChild === undefined) tree.delete(head);
    else tree.set(head, { mode: "40000", name: head, oid: newChild });
  }

  const payload = serializeTree(tree);
  const oid = await computeOid("tree", payload);
  objects.push({ type: "tree", payload, oid });
  return oid;
}

/**
 * Apply a unified diff against `baseCommitOid`. Returns the new commit oid
 * and every object that must be packed for the commit to be fetchable.
 */
export async function applyUnifiedPatch(args: {
  env: Env;
  repoId: string;
  baseCommitOid: string;
  patchText: string;
  message: string;
  author: string;
  cacheCtx?: CacheContext;
}): Promise<PatchApplyResult> {
  const { env, repoId, cacheCtx } = args;
  if (args.patchText.length > MAX_PATCH_BYTES) {
    return { kind: "failed", reason: "patch-too-large" };
  }

  const commitObj = await readPayload(env, repoId, args.baseCommitOid, cacheCtx);
  if (!commitObj || commitObj.type !== "commit") {
    return { kind: "failed", reason: "base-commit-missing" };
  }
  const baseCommit = parseCommitText(td.decode(commitObj.payload));
  if (!baseCommit.tree) return { kind: "failed", reason: "base-tree-missing" };

  let diffs: StructuredPatch[];
  try {
    diffs = parsePatch(args.patchText);
  } catch {
    return { kind: "failed", reason: "patch-parse-error" };
  }
  if (diffs.length === 0) return { kind: "failed", reason: "patch-empty" };
  if (diffs.length > MAX_PATCH_FILES) return { kind: "failed", reason: "patch-too-many-files" };

  const objects: NewObject[] = [];
  let treeOid = baseCommit.tree;

  for (const diff of diffs) {
    const path = (diff.newFileName ?? diff.oldFileName ?? "")
      .replace(/^[ab]\//, "")
      .replace(/^"|"$/g, "");
    if (!path || path === "/dev/null") continue;
    const isDelete = diff.isDelete === true || diff.newFileName === "/dev/null";
    const isNew = diff.isCreate === true || diff.oldFileName === "/dev/null";
    // Renames delete the old path; the new path is handled by the hunks.
    if (diff.isRename && diff.oldFileName) {
      const oldPath = diff.oldFileName.replace(/^[ab]\//, "");
      if (oldPath && oldPath !== path) {
        treeOid = (await setTreePath({
          env,
          repoId,
          treeOid,
          path: oldPath,
          entry: null,
          cacheCtx,
          objects,
        }))!;
      }
    }

    let oldText: string | undefined;
    if (!isNew) {
      const entry = await resolvePathEntry(env, repoId, treeOid, path, cacheCtx);
      if (!entry && !isDelete) return { kind: "failed", reason: `missing-file:${path}` };
      if (entry) {
        const blob = await readPayload(env, repoId, entry.oid, cacheCtx);
        if (!blob || blob.type !== "blob") return { kind: "failed", reason: `bad-blob:${path}` };
        oldText = td.decode(blob.payload);
      }
    }

    if (isDelete) {
      treeOid = (await setTreePath({
        env,
        repoId,
        treeOid,
        path,
        entry: null,
        cacheCtx,
        objects,
      }))!;
      continue;
    }

    const newText = applyHunks(oldText, diff);
    if (newText === null) return { kind: "failed", reason: `hunk-mismatch:${path}` };
    const blobPayload = te.encode(newText);
    const blobOid = await computeOid("blob", blobPayload);
    objects.push({ type: "blob", payload: blobPayload, oid: blobOid });
    treeOid = (await setTreePath({
      env,
      repoId,
      treeOid,
      path,
      entry: { mode: "100644", oid: blobOid },
      cacheCtx,
      objects,
    }))!;
  }

  const ts = Math.floor(Date.now() / 1000);
  const sig = `${args.author} ${ts} +0000`;
  const commitPayload = te.encode(
    `tree ${treeOid}\nparent ${args.baseCommitOid}\nauthor ${sig}\ncommitter ${sig}\n\n${args.message}\n`
  );
  const commitOid = await computeOid("commit", commitPayload);
  objects.push({ type: "commit", payload: commitPayload, oid: commitOid });
  return { kind: "ok", commitOid, objects };
}

export async function resolvePathEntry(
  env: Env,
  repoId: string,
  treeOid: string,
  path: string,
  cacheCtx: CacheContext | undefined
): Promise<{ mode: string; oid: string } | undefined> {
  let current = treeOid;
  const segments = path.split("/");
  for (let i = 0; i < segments.length; i++) {
    const treeObj = await readPayload(env, repoId, current, cacheCtx);
    if (!treeObj || treeObj.type !== "tree") return undefined;
    const entry = parseTree(treeObj.payload).get(segments[i]);
    if (!entry) return undefined;
    if (i === segments.length - 1) return entry;
    if (!isTreeMode(entry.mode)) return undefined;
    current = entry.oid;
  }
  return undefined;
}
