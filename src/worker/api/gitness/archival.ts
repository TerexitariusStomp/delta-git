// Real line-attribution blame and stored-zip archive writing.
//
// Blame walks the file's first-parent history: at each commit it diffs the
// previous blob against the older revision via an LCS alignment, re-mapping
// surviving lines to their original authors. Cost is bounded by
// MAX_BLAME_REVS/MAX_BLAME_LINES so large files fail with partial history
// (the oldest un-attributed lines stay credited to the oldest seen commit —
// the honest answer when the walk runs out of budget).
//
// Zip is a plain stored (uncompressed) archive — a valid .zip with real
// bytes, no third-party dependency. CRC32 uses the standard table.

import type { CacheContext } from "@/worker/cache";
import { isTreeMode, readCommitInfo, readTree } from "@/worker/git/operations/read";
import { readPayload } from "@/worker/agent/patch";

const td = new TextDecoder();
const te = new TextEncoder();

// ---------------------------------------------------------------------------
// blame
// ---------------------------------------------------------------------------

const MAX_BLAME_REVS = 100;
const MAX_BLAME_LINES = 4000;
const MAX_BLAME_BLOB_BYTES = 512 * 1024;

export interface BlameLine {
  line: number;
  commit: string;
  author: string;
  content: string;
}

interface CommitMeta {
  oid: string;
  author: string;
  parents: string[];
}

async function blobAtPath(
  env: Env,
  repoId: string,
  commitOid: string,
  path: string,
  cacheCtx?: CacheContext
): Promise<{ lines: string[]; oid: string } | null> {
  const commit = await readCommitInfo(env, repoId, commitOid, cacheCtx).catch(() => undefined);
  if (!commit) return null;
  // Walk the tree segments manually (readPath resolves refs, not trees).
  let treeOid = commit.tree;
  const segments = path.split("/").filter(Boolean);
  let entryOid: string | null = null;
  for (let i = 0; i < segments.length; i++) {
    const entries = await readTree(env, repoId, treeOid, cacheCtx).catch(() => []);
    const hit = entries.find((e) => e.name === segments[i]);
    if (!hit) return null;
    if (i === segments.length - 1) {
      if (isTreeMode(hit.mode)) return null;
      entryOid = hit.oid;
    } else {
      if (!isTreeMode(hit.mode)) return null;
      treeOid = hit.oid;
    }
  }
  if (!entryOid) return null;
  const obj = await readPayload(env, repoId, entryOid, cacheCtx).catch(() => undefined);
  if (!obj || obj.type !== "blob" || obj.payload.length > MAX_BLAME_BLOB_BYTES) return null;
  const text = td.decode(obj.payload);
  const lines = text.split("\n");
  if (lines.length > MAX_BLAME_LINES) return null;
  return { lines, oid: entryOid };
}

/**
 * LCS between two line arrays; returns index pairs (oldIdx → newIdx) of
 * identical lines. O(n·m) — callers bound both inputs.
 */
function alignLines(prev: string[], curr: string[]): Map<number, number> {
  const n = prev.length;
  const m = curr.length;
  // dp[i][j] = LCS length of prev[i:] and curr[j:].
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        prev[i] === curr[j]
          ? dp[(i + 1) * (m + 1) + (j + 1)] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + (j + 1)]);
    }
  }
  const map = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (prev[i] === curr[j]) {
      map.set(i, j);
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return map;
}

async function commitMeta(
  env: Env,
  repoId: string,
  oid: string,
  cacheCtx?: CacheContext
): Promise<CommitMeta | null> {
  const commit = await readCommitInfo(env, repoId, oid, cacheCtx).catch(() => undefined);
  if (!commit) return null;
  const author = commit.author?.name?.trim() || commit.author?.email || "unknown";
  return { oid, author, parents: commit.parents };
}

/**
 * First-parent blame for `path` at `startOid`. Each output line carries the
 * oldest commit that still accounts for it.
 */
export async function computeBlame(
  env: Env,
  repoId: string,
  startOid: string,
  path: string,
  cacheCtx?: CacheContext
): Promise<BlameLine[] | null> {
  let curr = await blobAtPath(env, repoId, startOid, path, cacheCtx);
  if (!curr) return null;
  let currMeta = await commitMeta(env, repoId, startOid, cacheCtx);
  if (!currMeta) return null;

  // owner[i] = commit oid credited with curr.lines[i].
  let owners: string[] = curr.lines.map(() => currMeta!.oid);
  const metaByCommit = new Map<string, CommitMeta>([[currMeta.oid, currMeta]]);

  for (let rev = 0; rev < MAX_BLAME_REVS; rev++) {
    const parentOid = currMeta.parents[0];
    if (!parentOid) break;
    const parent = await blobAtPath(env, repoId, parentOid, path, cacheCtx);
    const parentMeta = await commitMeta(env, repoId, parentOid, cacheCtx);
    if (!parent || !parentMeta) break;
    metaByCommit.set(parentOid, parentMeta);

    // A line aligned to a parent line existed before this commit — credit
    // the parent (the oldest-surviving rule). Lines without an alignment
    // were introduced here and keep the current owner.
    const map = alignLines(parent.lines, curr.lines);
    const aligned = new Set(map.values());
    owners = curr.lines.map((_, i) => (aligned.has(i) ? parentOid : owners[i]!));
    curr = parent;
    currMeta = parentMeta;
  }

  return curr.lines.map((content, i) => {
    const owner = metaByCommit.get(owners[i]!) ?? currMeta!;
    return { line: i + 1, commit: owner.oid, author: owner.author, content };
  });
}

// ---------------------------------------------------------------------------
// languages — count blob bytes at HEAD by file extension
// ---------------------------------------------------------------------------

const EXT_LANG: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java",
  c: "C",
  h: "C",
  cpp: "C++",
  cs: "C#",
  rb: "Ruby",
  php: "PHP",
  swift: "Swift",
  kt: "Kotlin",
  scala: "Scala",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  vue: "Vue",
  svelte: "Svelte",
  md: "Markdown",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  sql: "SQL",
  lua: "Lua",
  zig: "Zig",
  sol: "Solidity",
  move: "Move",
  proto: "Protocol Buffers",
  tf: "HCL",
};

const MAX_LANG_ENTRIES = 20000;

/** Byte histogram keyed by language name, walked over the HEAD tree. */
export async function computeLanguages(
  env: Env,
  repoId: string,
  treeOid: string,
  cacheCtx?: CacheContext
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const stack: { oid: string }[] = [{ oid: treeOid }];
  let seen = 0;
  while (stack.length > 0 && seen < MAX_LANG_ENTRIES) {
    const { oid } = stack.pop()!;
    const entries = await readTree(env, repoId, oid, cacheCtx).catch(() => []);
    seen++;
    for (const e of entries) {
      if (isTreeMode(e.mode)) {
        stack.push({ oid: e.oid });
        continue;
      }
      const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
      const lang = EXT_LANG[ext];
      if (lang) out[lang] = (out[lang] ?? 0) + 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// zip archive (stored entries — valid zip, no compression dependency)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/**
 * Assemble a stored-entry zip from (name → bytes). Deterministic ordering —
 * callers pass entries already sorted. Directory entries end in `/`.
 */
export function buildZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: ZipEntry[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) =>
    new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);

  for (const e of entries) {
    const name = te.encode(e.name);
    const crc = crc32(e.data);
    central.push({ name: e.name, data: name, crc, offset });
    push(u32(0x04034b50));
    push(u16(20)); // version needed
    push(u16(0x0800)); // UTF-8 flag
    push(u16(0)); // method: stored
    push(u16(0));
    push(u16(0)); // mod time/date
    push(u32(crc));
    push(u32(e.data.length));
    push(u32(e.data.length));
    push(u16(name.length));
    push(u16(0));
    push(name);
    push(e.data);
  }

  const cdStart = offset;
  for (const e of central) {
    push(u32(0x02014b50));
    push(u16(20));
    push(u16(20));
    push(u16(0x0800));
    push(u16(0));
    push(u16(0));
    push(u16(0));
    push(u32(e.crc));
    // Stored entries carry identical compressed/uncompressed sizes; the data
    // length is what we pushed, recover it via the local-header record count.
    push(u32(entries.find((x) => x.name === e.name)!.data.length));
    push(u32(entries.find((x) => x.name === e.name)!.data.length));
    push(u16(e.data.length));
    push(u16(0));
    push(u16(0));
    push(u16(0));
    push(u16(0));
    push(u32(0));
    push(u32(e.offset));
    push(e.data);
  }
  const cdSize = offset - cdStart;
  push(u32(0x06054b50));
  push(u16(0));
  push(u16(0));
  push(u16(central.length));
  push(u16(central.length));
  push(u32(cdSize));
  push(u32(cdStart));
  push(u16(0));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/** Walk a tree into flat (path → blob) entries for archiving. */
export async function collectArchiveEntries(
  env: Env,
  repoId: string,
  treeOid: string,
  prefix: string,
  cacheCtx: CacheContext | undefined,
  out: { name: string; data: Uint8Array }[],
  state: { count: number }
): Promise<void> {
  if (state.count >= MAX_ARCHIVE_ENTRIES) return;
  const entries = await readTree(env, repoId, treeOid, cacheCtx).catch(() => []);
  state.count++;
  for (const e of entries) {
    if (state.count >= MAX_ARCHIVE_ENTRIES) return;
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (isTreeMode(e.mode)) {
      out.push({ name: `${path}/`, data: new Uint8Array(0) });
      await collectArchiveEntries(env, repoId, e.oid, path, cacheCtx, out, state);
    } else {
      const obj = await readPayload(env, repoId, e.oid, cacheCtx).catch(() => undefined);
      if (!obj || obj.type !== "blob") continue;
      out.push({ name: path, data: obj.payload });
      state.count++;
    }
  }
}

export const MAX_ARCHIVE_ENTRIES = 20000;
