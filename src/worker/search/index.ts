// Repo code search — Orama (Apache-2.0) keyword index + optional
// Vectorize/Workers-AI semantic lane + /ask RAG.
//
// Index lifecycle: the Orama index for a repo's HEAD tree is built lazily on
// first search and serialized into ROUTES KV under
// `gsearchidx:{doName}:{headOid}` — a stale HEAD yields stale-but-valid
// results; the next search after a push rebuilds. Build is budgeted
// (MAX_FILES × MAX_BLOB) so mega-repos index their first-N files rather than
// blowing the request's subrequest budget.
//
// Semantic lane: when a VECTORIZE binding exists, file chunks are embedded
// via @cf/baai/bge-base-en-v1.5 and upserted under the same head key.
// Results merge keyword + vector hits by path.

import { create, insert, search, save, load, type Orama } from "@orama/orama";
import { resolveRef } from "@/worker/git/operations/read/refs";
import { readCommit } from "@/worker/git/operations/read/commits";
import { readTree, isTreeMode } from "@/worker/git/operations/read/tree";
import { readBlob } from "@/worker/git/operations/read/objects";
import type { CacheContext } from "@/worker/cache";
import { createLogger } from "@/worker/common/logger";

const log = createLogger(undefined, { service: "Search" });

const MAX_FILES = 400;
const MAX_BLOB = 128 * 1024;
const CHUNK = 4000;
const EMBED_BATCH = 50;
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const LLM_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** Extensions indexed — code + docs, everything else is skipped. */
const TEXT_EXT = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "php",
  "swift",
  "scala",
  "lua",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "html",
  "css",
  "scss",
  "less",
  "vue",
  "svelte",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "xml",
  "md",
  "mdx",
  "txt",
  "rst",
  "proto",
  "graphql",
  "tf",
  "hcl",
  "nix",
  "dockerfile",
  "makefile",
  "cmake",
]);

function isIndexable(name: string): boolean {
  const base = name.toLowerCase();
  const ext = base.includes(".") ? (base.split(".").pop() ?? "") : base;
  return TEXT_EXT.has(ext) || ["dockerfile", "makefile", "cmakelists.txt"].includes(base);
}

export interface FileDoc {
  path: string;
  ext: string;
  /** First CHUNK bytes of content — enough for keyword hits + RAG context. */
  content: string;
}

const schema = {
  path: "string",
  ext: "string",
  content: "string",
} as const;

type RepoIndex = Orama<typeof schema>;

/**
 * Walk the HEAD tree collecting indexable file paths (breadth-first,
 * budget-capped). Returns entries to fetch.
 */
async function walkIndexablePaths(
  env: Env,
  repoId: string,
  cacheCtx: CacheContext | undefined
): Promise<{ paths: { path: string; oid: string }[]; headOid: string | null }> {
  const headOid = await resolveRef(env, repoId, "HEAD", cacheCtx).catch(() => null);
  if (!headOid) return { paths: [], headOid: null };
  const commit = await readCommit(env, repoId, headOid, cacheCtx).catch(() => null);
  if (!commit?.tree) return { paths: [], headOid };

  const out: { path: string; oid: string }[] = [];
  const queue: { oid: string; base: string }[] = [{ oid: commit.tree, base: "" }];
  while (queue.length && out.length < MAX_FILES) {
    const { oid, base } = queue.shift()!;
    const entries = await readTree(env, repoId, oid, cacheCtx).catch(() => []);
    for (const e of entries) {
      if (out.length >= MAX_FILES) break;
      const p = base ? `${base}/${e.name}` : e.name;
      if (isTreeMode(e.mode)) queue.push({ oid: e.oid, base: p });
      else if (isIndexable(e.name)) out.push({ path: p, oid: e.oid });
    }
  }
  return { paths: out, headOid };
}

/** Load or build the Orama index for the repo's current HEAD. */
async function repoIndex(
  env: Env,
  repoId: string,
  cacheCtx: CacheContext | undefined
): Promise<{ index: RepoIndex; docs: FileDoc[]; headOid: string } | null> {
  const { paths, headOid } = await walkIndexablePaths(env, repoId, cacheCtx);
  if (!headOid || paths.length === 0) return null;

  const kvKey = `gsearchidx:${repoId}:${headOid}`;
  const cached = (await env.ROUTES.get(kvKey, "json").catch(() => null)) as {
    index: unknown;
    docs: FileDoc[];
  } | null;
  if (cached?.index && cached.docs) {
    const index = await create({ schema });
    await load(index, cached.index as Parameters<typeof load>[1]);
    return { index, docs: cached.docs, headOid };
  }

  const index = await create({ schema });
  const docs: FileDoc[] = [];
  for (const p of paths) {
    const blob = await readBlob(env, repoId, p.oid, cacheCtx).catch(() => null);
    if (!blob?.content || blob.content.byteLength > MAX_BLOB) continue;
    // Cheap binary sniff — NUL byte in the head means this isn't text.
    if (blob.content.slice(0, 512).includes(0)) continue;
    const content = new TextDecoder("utf-8", { fatal: false }).decode(blob.content.slice(0, CHUNK));
    const doc: FileDoc = {
      path: p.path,
      ext: p.path.split(".").pop() ?? "",
      content,
    };
    docs.push(doc);
    await insert(index, doc);
  }

  const serialized = await save(index);
  // Cache under the HEAD oid — stale indexes age out naturally when HEAD moves.
  await env.ROUTES.put(kvKey, JSON.stringify({ index: serialized, docs }), {
    expirationTtl: 86400,
  }).catch(() => {});
  // Embedding upserts run after the response — they'd otherwise blow the
  // request budget on a cold index build.
  const upsert = upsertVectors(env, repoId, headOid, docs).catch((err) =>
    log.warn("search:vectorize-upsert-failed", { repoId, error: String(err) })
  );
  if (cacheCtx?.ctx) cacheCtx.ctx.waitUntil(upsert);
  else await upsert;
  return { index, docs, headOid };
}

/** Upsert chunk embeddings to Vectorize — best-effort, skipped when unbound. */
async function upsertVectors(
  env: Env,
  repoId: string,
  headOid: string,
  docs: FileDoc[]
): Promise<void> {
  if (!env.VECTORIZE) return;
  const flagged = await env.ROUTES.get(`gvec:${repoId}:${headOid}`).catch(() => null);
  if (flagged) return;
  const texts = docs.map((d) => `${d.path}\n${d.content}`.slice(0, 4096));
  const rows: { id: string; values: number[]; metadata: Record<string, string> }[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = (await env.AI.run(EMBEDDING_MODEL, { text: batch })) as {
      data?: number[][];
    };
    (res.data ?? []).forEach((values, j) => {
      rows.push({
        id: `${repoId}:${docs[i + j].path}`,
        values,
        metadata: { repo: repoId, path: docs[i + j].path },
      });
    });
  }
  if (rows.length) await env.VECTORIZE.upsert(rows);
  await env.ROUTES.put(`gvec:${repoId}:${headOid}`, "1", { expirationTtl: 86400 }).catch(() => {});
}

export interface SearchHit {
  path: string;
  repo: string;
  score: number;
  snippet: string;
}

/** Snippet = first line containing the query's first term, trimmed. */
function snippetOf(doc: FileDoc | undefined, q: string): string {
  if (!doc) return "";
  const term = q.split(/\s+/)[0]?.toLowerCase() ?? "";
  const line = doc.content.split("\n").find((l) => l.toLowerCase().includes(term));
  return (line ?? doc.content.split("\n")[0] ?? "").trim().slice(0, 160);
}

/**
 * Raw indexed docs for a repo's HEAD — the gitness facade needs the contents
 * (not just ranked hits) to render line-level match fragments.
 */
export async function repoSearchDocs(
  env: Env,
  repoId: string,
  cacheCtx: CacheContext | undefined
): Promise<{ docs: FileDoc[]; headOid: string } | null> {
  const built = await repoIndex(env, repoId, cacheCtx);
  if (!built) return null;
  return { docs: built.docs, headOid: built.headOid };
}

/**
 * Vector-only hits for the semantic-search endpoint. Returns [] when the
 * VECTORIZE binding or embeddings are unavailable — callers degrade to
 * keyword search rather than erroring.
 */
export async function vectorSearchRepo(
  env: Env,
  repoId: string,
  q: string,
  limit = 20
): Promise<{ path: string; score: number }[]> {
  if (!env.VECTORIZE || !env.AI) return [];
  try {
    const res = (await env.AI.run(EMBEDDING_MODEL, { text: [q] })) as {
      data?: number[][];
    };
    const vec = res.data?.[0];
    if (!vec) return [];
    const qr = await env.VECTORIZE.query(vec, { topK: limit, returnMetadata: true });
    // Vectors are ids `repoId:path` — scope matches to this repo either via
    // metadata or the id prefix.
    return qr.matches
      .filter((m) => {
        const meta = m.metadata as { repo?: string } | undefined;
        return meta?.repo === repoId || m.id.startsWith(`${repoId}:`);
      })
      .map((m) => {
        const meta = m.metadata as { path?: string } | undefined;
        return { path: meta?.path ?? m.id.slice(repoId.length + 1), score: m.score };
      });
  } catch (err) {
    log.warn("search:vectorize-query-failed", { repoId, error: String(err) });
    return [];
  }
}

/**
 * Repo-scoped search: Orama keyword hits merged with Vectorize semantic hits
 * (when bound). Returns gitness-shaped results.
 */
export async function searchRepo(
  env: Env,
  repoId: string,
  repoRef: string,
  q: string,
  cacheCtx: CacheContext | undefined,
  limit = 20
): Promise<SearchHit[]> {
  const built = await repoIndex(env, repoId, cacheCtx);
  if (!built) return [];
  const { index, docs } = built;
  const byPath = new Map(docs.map((d) => [d.path, d]));

  const kw = await search(index, { term: q, limit: limit * 2, tolerance: 1 });
  const hits = new Map<string, SearchHit>();
  for (const h of kw.hits) {
    const doc = h.document as FileDoc;
    hits.set(doc.path, {
      path: doc.path,
      repo: repoRef,
      score: h.score * 2, // keyword outranks vector in a code forge
      snippet: snippetOf(doc, q),
    });
  }

  for (const m of await vectorSearchRepo(env, repoId, q, limit)) {
    const existing = hits.get(m.path);
    if (existing) existing.score += m.score;
    else
      hits.set(m.path, {
        path: m.path,
        repo: repoRef,
        score: m.score,
        snippet: snippetOf(byPath.get(m.path), q),
      });
  }

  return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface AskAnswer {
  answer: string;
  citations: { path: string; repo: string }[];
}

/**
 * RAG over the repo index: retrieve top files, feed trimmed context to the
 * LLM, return the answer with file citations. Model instructed to cite
 * paths inline so agents can traverse to the blob route.
 */
export async function askRepo(
  env: Env,
  repoId: string,
  repoRef: string,
  q: string,
  cacheCtx: CacheContext | undefined
): Promise<AskAnswer> {
  const hits = await searchRepo(env, repoId, repoRef, q, cacheCtx, 8);
  const built = await repoIndex(env, repoId, cacheCtx);
  const docs = built?.docs ?? [];
  const context = hits
    .map((h) => {
      const doc = docs.find((d) => d.path === h.path);
      return `--- ${h.path} ---\n${(doc?.content ?? "").slice(0, 2000)}`;
    })
    .join("\n\n")
    .slice(0, 24000);

  const res = (await env.AI.run(LLM_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "You answer questions about a code repository using only the provided file excerpts. " +
          "Cite file paths inline like `src/foo.ts`. If the context is insufficient, say so plainly.",
      },
      {
        role: "user",
        content: `Repository: ${repoRef}\n\n${context || "(no context retrieved)"}\n\nQuestion: ${q}`,
      },
    ],
    max_tokens: 512,
  })) as { response?: string };

  return {
    answer: res.response ?? "",
    citations: hits.map((h) => ({ path: h.path, repo: repoRef })),
  };
}
