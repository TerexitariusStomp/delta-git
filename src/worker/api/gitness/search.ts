// Code-search endpoints behind the gitness `/api/v1` facade.
//
// The vendored SPA's search page calls two contracts:
//   POST /api/v1/search                          {repo_paths, space_paths,
//                                                 query, enable_regex, ...}
//   POST /api/v1/repos/{ref}/+/semantic/search   {query}
// We add a third, agent-facing:
//   POST /api/v1/repos/{ref}/+/ask               {query}  → RAG answer + cites
//
// Matching is real: `repoSearchDocs` yields every indexable file's content
// (Orama-indexed, HEAD-keyed KV cache), and results are produced by a line
// scan — grep semantics, not fuzzy guessing. `lang:`/`case:`/`enable_regex`
// in the gitness query syntax are honored. Private repos search fine here —
// read access is enforced by resolveGitnessRepo. Strict-E2E encrypted repos
// carry no server-side plaintext: repo-scoped endpoints refuse them and the
// space fan-out skips them (the custody worker owns their search lane).

import type { AppRouter } from "@/worker/routes/hono";
import { loadViewer } from "@/worker/auth/session";
import { findNamespaceBySlug } from "@/worker/db/d1/dal/namespaces";
import { listRepositoriesForNamespace } from "@/worker/db/d1/dal/repositories";
import { loadHeadAndRefsCached } from "@/worker/routes/ui/helpers";
import { createLogger } from "@/worker/common/logger";
import {
  repoSearchDocs,
  searchRepo,
  vectorSearchRepo,
  askRepo,
  type FileDoc,
} from "@/worker/search";
import { gErr, parseRepoRef, resolveGitnessRepo } from "./shared";

const log = createLogger(undefined, { service: "GitnessSearch" });

/** Budget guard: a space-scoped search fans out to at most this many repos. */
const MAX_SPACE_REPOS = 8;
const MAX_MATCHES_PER_FILE = 5;
const CONTEXT_LINES = 2;
const SEMANTIC_LINE_WINDOW = 5;

/** SPA `lang:` option values → file extensions. */
const LANG_TO_EXTS: Record<string, string[]> = {
  typescript: ["ts", "tsx"],
  javascript: ["js", "jsx", "mjs", "cjs"],
  python: ["py"],
  go: ["go"],
  java: ["java"],
  kotlin: ["kt", "kts"],
  rust: ["rs"],
  scala: ["scala"],
  markdown: ["md", "mdx"],
  c: ["c", "h"],
  cpp: ["cc", "cpp", "hpp"],
  csharp: ["cs"],
  ruby: ["rb"],
  php: ["php"],
  swift: ["swift"],
  shell: ["sh", "bash", "zsh"],
  yaml: ["yaml", "yml"],
  json: ["json", "jsonc"],
  toml: ["toml"],
  sql: ["sql"],
  html: ["html"],
  css: ["css", "scss", "less"],
  proto: ["proto"],
  graphql: ["graphql", "gql"],
};

interface ParsedGitnessQuery {
  term: string;
  caseSensitive: boolean;
  lang?: string;
}

/**
 * The SPA sends gitness query syntax — `( term ) case:no lang:ts`. Extract
 * the parenthesized term plus the filters we honor; unknown qualifiers are
 * ignored rather than misinterpreted as search text.
 */
function parseGitnessQuery(raw: string): ParsedGitnessQuery {
  let term = raw;
  const paren = raw.match(/\(([^)]*)\)/);
  if (paren) term = paren[1];
  // Strip known qualifiers out of the term in case they appeared inside ().
  term = term.replace(/\b(case|lang|type|repo|file|archived|fork):[^\s]+/g, "").trim();
  return {
    term,
    caseSensitive: /\bcase:yes\b/.test(raw),
    lang: raw.match(/\blang:([a-zA-Z0-9+#]+)/)?.[1]?.toLowerCase(),
  };
}

interface FileMatch {
  file_name: string;
  repo_path: string;
  repo_branch: string;
  language: string;
  matches: {
    line_num: number;
    before: string;
    after: string;
    fragments: { pre: string; match: string; post: string }[];
  }[];
}

/** Compile the query term into a line matcher honoring case/regex flags. */
function makeLineMatcher(
  pq: ParsedGitnessQuery,
  enableRegex: boolean
): ((line: string) => { pre: string; match: string; post: string }[] | null) | null {
  if (!pq.term) return null;
  if (enableRegex) {
    try {
      const re = new RegExp(pq.term, pq.caseSensitive ? "g" : "gi");
      return (line) => {
        re.lastIndex = 0;
        const fragments: { pre: string; match: string; post: string }[] = [];
        let m: RegExpExecArray | null;
        let last = 0;
        while ((m = re.exec(line)) !== null && fragments.length < 8) {
          if (m[0].length === 0) break; // zero-width — don't loop forever
          fragments.push({ pre: line.slice(last, m.index), match: m[0], post: "" });
          last = m.index + m[0].length;
        }
        if (!fragments.length) return null;
        fragments[fragments.length - 1].post = line.slice(last);
        return fragments;
      };
    } catch {
      return null; // invalid user regex — treated as no matcher → empty result
    }
  }
  const needle = pq.caseSensitive ? pq.term : pq.term.toLowerCase();
  return (line) => {
    const hay = pq.caseSensitive ? line : line.toLowerCase();
    const at = hay.indexOf(needle);
    if (at < 0) return null;
    return [
      {
        pre: line.slice(0, at),
        match: line.slice(at, at + pq.term.length),
        post: line.slice(at + pq.term.length),
      },
    ];
  };
}

function scanDoc(
  doc: FileDoc,
  matchLine: (line: string) => { pre: string; match: string; post: string }[] | null,
  repoPath: string,
  branch: string
): FileMatch | null {
  const lines = doc.content.split("\n");
  const matches: FileMatch["matches"] = [];
  for (let i = 0; i < lines.length && matches.length < MAX_MATCHES_PER_FILE; i++) {
    const fragments = matchLine(lines[i]);
    if (!fragments) continue;
    matches.push({
      line_num: i + 1,
      before: lines.slice(Math.max(0, i - CONTEXT_LINES), i).join("\n"),
      after: lines.slice(i + 1, i + 1 + CONTEXT_LINES).join("\n"),
      fragments,
    });
  }
  if (!matches.length) return null;
  return {
    file_name: doc.path,
    repo_path: repoPath,
    repo_branch: branch,
    language: doc.ext,
    matches,
  };
}

/** Extract a line window around the best hit for semantic results. */
function semanticWindow(doc: FileDoc, query: string): { start: number; lines: string[] } {
  const lines = doc.content.split("\n");
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  let best = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (terms.some((t) => l.includes(t))) {
      best = i;
      break;
    }
  }
  const start = Math.max(0, best - 1);
  return { start, lines: lines.slice(start, start + SEMANTIC_LINE_WINDOW) };
}

/** `owner/repo` (or longer `a/b/c/repo` refs) → repo_ref the facade parses. */
function refFromPath(path: string): string | null {
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const ref = segs.slice(-2).join("/");
  return parseRepoRef(ref) ? ref : null;
}

export function registerGitnessSearch(router: AppRouter) {
  // POST /api/v1/search — gitness global/repo-scoped code search.
  router.post("/api/v1/search", async (c) => {
    const viewer = await loadViewer(c);
    const body = (await c.req.json().catch(() => null)) as {
      repo_paths?: string[];
      space_paths?: string[];
      query?: string;
      max_result_count?: number;
      enable_regex?: boolean;
    } | null;
    const pq = parseGitnessQuery(body?.query ?? "");
    const matchLine = makeLineMatcher(pq, body?.enable_regex === true);
    if (!matchLine || !body) {
      return c.json({ file_matches: [], stats: { total_files: 0, total_matches: 0 } });
    }
    const limit = Math.min(Math.max(body.max_result_count ?? 50, 1), 200);
    const exts = pq.lang ? (LANG_TO_EXTS[pq.lang] ?? [pq.lang]) : undefined;

    // Resolve candidate repos: explicit repo_paths plus every visible repo
    // in the requested spaces (space_paths carry `scope/space` refs — the
    // space slug is the last segment).
    const refs = new Set<string>();
    for (const p of body.repo_paths ?? []) {
      const r = refFromPath(p);
      if (r) refs.add(r);
    }
    for (const p of body.space_paths ?? []) {
      const slug = p.split("/").filter(Boolean).at(-1);
      if (!slug) continue;
      const ns = await findNamespaceBySlug(c.var.db, slug).catch(() => null);
      if (!ns) continue;
      const rows = await listRepositoriesForNamespace(c.var.db, ns.id, viewer?.userId ?? null);
      for (const row of rows.slice(0, MAX_SPACE_REPOS)) refs.add(`${ns.slug}/${row.slug}`);
    }
    if (!refs.size) {
      return c.json({ file_matches: [], stats: { total_files: 0, total_matches: 0 } });
    }

    const fileMatches: FileMatch[] = [];
    let scannedFiles = 0;
    let totalMatches = 0;
    for (const ref of refs) {
      if (fileMatches.length >= limit) break;
      const access = await resolveGitnessRepo(c, ref);
      if (access.kind !== "ok") continue;
      // Strict-E2E repos carry no server-side plaintext — skip them in the
      // space fan-out rather than returning misleading empties.
      if (access.route.encrypted) continue;
      const built = await repoSearchDocs(c.env, access.route.doName, access.cacheCtx).catch(
        (err) => {
          log.warn("search:docs-load-failed", {
            repoId: access.route.doName,
            error: String(err),
          });
          return null;
        }
      );
      if (!built) continue;
      const refsData = await loadHeadAndRefsCached(c.env, access.cacheCtx, access.route.doName);
      const branch = refsData?.head?.target?.replace(/^refs\/heads\//, "") ?? "main";
      for (const doc of built.docs) {
        if (fileMatches.length >= limit) break;
        if (exts && !exts.includes(doc.ext)) continue;
        scannedFiles++;
        const fm = scanDoc(doc, matchLine, ref, branch);
        if (fm) {
          totalMatches += fm.matches.length;
          fileMatches.push(fm);
        }
      }
    }

    return c.json({
      file_matches: fileMatches,
      stats: { total_files: scannedFiles, total_matches: totalMatches },
    });
  });

  // POST /api/v1/repos/{ref}/+/semantic/search — Vectorize lane; falls back
  // to the Orama index so the toggle still yields results pre-index. The
  // gitness `+` separator lands inside repo_ref and is stripped by
  // parseRepoRef — declaring it as a literal would let RegExpRouter read it
  // as a quantifier.
  router.post("/api/v1/repos/:repo_ref{.+}/semantic/search", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (access.route.encrypted) {
      return gErr(c, 400, "repo is end-to-end encrypted — search runs client-side");
    }
    const body = (await c.req.json().catch(() => null)) as { query?: string } | null;
    const query = (body?.query ?? "").trim();
    if (!query) return c.json([]);

    const built = await repoSearchDocs(c.env, access.route.doName, access.cacheCtx).catch(
      () => null
    );
    if (!built) return c.json([]);
    const byPath = new Map(built.docs.map((d) => [d.path, d]));

    let hits = await vectorSearchRepo(c.env, access.route.doName, query, 20);
    if (!hits.length) {
      hits = (
        await searchRepo(
          c.env,
          access.route.doName,
          c.req.param("repo_ref"),
          query,
          access.cacheCtx,
          20
        )
      ).map((h) => ({ path: h.path, score: h.score }));
    }
    const items = hits
      .map((h) => {
        const doc = byPath.get(h.path);
        if (!doc) return null;
        const { start, lines } = semanticWindow(doc, query);
        return {
          commit: built.headOid,
          file_path: doc.path,
          start_line: start + 1,
          end_line: start + lines.length,
          file_name: doc.path.split("/").pop() ?? doc.path,
          lines,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return c.json(items);
  });

  // POST /api/v1/repos/{ref}/+/ask — delta extension: repo Q&A with file
  // citations, for agents (and the future ask UI). Same `+` handling as
  // semantic/search above.
  router.post("/api/v1/repos/:repo_ref{.+}/ask", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (access.route.encrypted) {
      return gErr(c, 400, "repo is end-to-end encrypted — ask runs client-side");
    }
    const body = (await c.req.json().catch(() => null)) as { query?: string } | null;
    const query = (body?.query ?? "").trim();
    if (!query) return gErr(c, 400, "query required");
    try {
      const answer = await askRepo(
        c.env,
        access.route.doName,
        c.req.param("repo_ref"),
        query,
        access.cacheCtx
      );
      return c.json(answer);
    } catch (err) {
      log.warn("search:ask-failed", { repoId: access.route.doName, error: String(err) });
      return gErr(c, 503, "ask backend unavailable");
    }
  });
}
