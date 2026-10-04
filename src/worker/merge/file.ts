import { merge as diff3Merge } from "node-diff3";

// File-level 3-way merge for blobs that changed on both sides.
//
// - `.json` gets a key-wise structured merge (different keys merge cleanly;
//   same-key divergence conflicts).
// - other UTF-8 text gets a line-level diff3.
// - binary and unresolvable cases surface as semantic conflicts for the
//   adjudication layer.

export type FileMergeResult =
  | { kind: "merged"; content: Uint8Array }
  | { kind: "conflict"; reason: string };

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });

function isUtf8(payload: Uint8Array): string | undefined {
  try {
    return td.decode(payload);
  } catch {
    return undefined;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// JSON structured merge
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function jsonEqual(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type JsonMergeResult = { ok: true; value: Json } | { ok: false };

/**
 * Key-wise 3-way merge for plain JSON objects. A key merges cleanly when only
 * one side changed it (or both changed it identically); same-key divergence
 * attempts a recursive object merge, otherwise conflicts.
 */
function mergeJsonValue(base: Json, ours: Json, theirs: Json): JsonMergeResult {
  if (jsonEqual(ours, theirs)) return { ok: true, value: ours };
  if (jsonEqual(base, ours)) return { ok: true, value: theirs };
  if (jsonEqual(base, theirs)) return { ok: true, value: ours };

  const baseObj = base !== null && typeof base === "object" && !Array.isArray(base) ? base : null;
  const oursObj = ours !== null && typeof ours === "object" && !Array.isArray(ours) ? ours : null;
  const theirsObj =
    theirs !== null && typeof theirs === "object" && !Array.isArray(theirs) ? theirs : null;
  if (!baseObj || !oursObj || !theirsObj) return { ok: false };

  const out: { [k: string]: Json } = {};
  const keys = new Set([
    ...Object.keys(baseObj),
    ...Object.keys(oursObj),
    ...Object.keys(theirsObj),
  ]);
  for (const key of keys) {
    const b = key in baseObj ? baseObj[key] : undefined;
    const o = key in oursObj ? oursObj[key] : undefined;
    const t = key in theirsObj ? theirsObj[key] : undefined;

    const keyInOurs = key in oursObj;
    const keyInTheirs = key in theirsObj;
    if (!keyInOurs && !keyInTheirs) continue; // deleted on both sides
    if (!keyInOurs || !keyInTheirs) {
      // Deleted on one side: keep deletion only if the other side is unchanged.
      const kept = keyInOurs ? o : t;
      if (b !== undefined && jsonEqual(b as Json, kept as Json)) continue;
      if (b === undefined) {
        if (keyInOurs) out[key] = o as Json;
        else out[key] = t as Json;
        continue;
      }
      return { ok: false };
    }

    const merged = mergeJsonValue(b as Json, o as Json, t as Json);
    if (!merged.ok) return { ok: false };
    out[key] = merged.value;
  }
  return { ok: true, value: out };
}

function mergeJsonFile(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): FileMergeResult {
  try {
    const merged = mergeJsonValue(
      JSON.parse(td.decode(base)) as Json,
      JSON.parse(td.decode(ours)) as Json,
      JSON.parse(td.decode(theirs)) as Json
    );
    if (!merged.ok) return { kind: "conflict", reason: "json-key-divergence" };
    return { kind: "merged", content: te.encode(JSON.stringify(merged.value, null, 2) + "\n") };
  } catch {
    return { kind: "conflict", reason: "json-parse-failed" };
  }
}

// ---------------------------------------------------------------------------
// Text diff3 merge
// ---------------------------------------------------------------------------

function mergeTextFile(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): FileMergeResult {
  const baseText = isUtf8(base);
  const oursText = isUtf8(ours);
  const theirsText = isUtf8(theirs);
  if (baseText === undefined || oursText === undefined || theirsText === undefined) {
    return { kind: "conflict", reason: "binary" };
  }
  const result = diff3Merge(oursText.split("\n"), baseText.split("\n"), theirsText.split("\n")) as {
    conflict: boolean;
    result: string[];
  };
  if (result.conflict) return { kind: "conflict", reason: "text-hunk-overlap" };
  return { kind: "merged", content: te.encode(result.result.join("\n")) };
}

/**
 * Merge one blob across three versions. Callers only reach this when both
 * sides changed the path to different oids.
 */
export function mergeFileContents(args: {
  path: string;
  base: Uint8Array | undefined;
  ours: Uint8Array | undefined;
  theirs: Uint8Array | undefined;
}): FileMergeResult {
  const { path, base, ours, theirs } = args;
  // Add/add or delete/modify cases reach here too.
  if (ours === undefined || theirs === undefined) {
    return { kind: "conflict", reason: "delete-vs-modify" };
  }
  if (sameBytes(ours, theirs)) return { kind: "merged", content: ours };
  if (base !== undefined) {
    if (sameBytes(base, ours)) return { kind: "merged", content: theirs };
    if (sameBytes(base, theirs)) return { kind: "merged", content: ours };
  }
  if (path.endsWith(".json")) {
    if (base === undefined) return { kind: "conflict", reason: "json-add-add" };
    return mergeJsonFile(base, ours, theirs);
  }
  if (base === undefined) return { kind: "conflict", reason: "add-add" };
  return mergeTextFile(base, ours, theirs);
}
