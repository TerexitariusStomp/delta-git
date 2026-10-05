// Repo knowledge base — extraction, graph, and storage for the
// understandability surfaces (knowledge endpoints, llms.txt, MCP, KB tab).
//
// Extraction is line-based per language (imports + top-level symbols) —
// deterministic and dependency-free; tree-sitter can slot behind the same
// `extractFile` contract later without touching storage or endpoints.
// Summaries/diagrams degrade gracefully when Workers AI is unavailable.

import { createLogger } from "@/worker/common/logger";
import type { CacheContext } from "@/worker/cache";
import { repoSearchDocs, type FileDoc } from "@/worker/search";

export interface FileKnowledge {
  path: string;
  ext: string;
  symbols: { name: string; kind: string; line: number }[];
  imports: string[];
}

export interface KnowledgeEdge {
  from: string;
  to: string;
  kind: "file" | "package";
}

export interface RepoKnowledge {
  version: 1;
  headOid: string | null;
  generated: number;
  summary: string;
  moduleBlurbs: Record<string, string>;
  files: FileKnowledge[];
  edges: KnowledgeEdge[];
  packages: string[];
  entrypoints: string[];
  glossary: { term: string; definition: string }[];
  diagrams: { id: string; title: string; mermaid: string }[];
  tours: { id: string; title: string; steps: { path: string; line?: number; note: string }[] }[];
}

const KV_PREFIX = "gkb:";
const MAX_FILES = 400;
const MAX_LINE = 500;
const MAX_GLOSSARY = 24;
const MAX_SYMBOLS_PER_FILE = 60;

export function kbKvKey(doName: string): string {
  return `${KV_PREFIX}${doName}`;
}

export async function readRepoKnowledge(env: Env, doName: string): Promise<RepoKnowledge | null> {
  const raw = await env.ROUTES.get(kbKvKey(doName));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RepoKnowledge;
  } catch {
    return null;
  }
}

async function writeRepoKnowledge(env: Env, doName: string, kb: RepoKnowledge): Promise<void> {
  await env.ROUTES.put(kbKvKey(doName), JSON.stringify(kb), { expirationTtl: 86400 * 7 });
}

// --- extraction ------------------------------------------------------------

const EXT_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  go: "go",
  rs: "rs",
  java: "java",
  kt: "java",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  hpp: "c",
  rb: "rb",
};

interface Rule {
  kind: string;
  re: RegExp;
  name: (m: RegExpMatchArray) => string | null;
}

const SYMBOL_RULES: Record<string, Rule[]> = {
  ts: [
    {
      kind: "class",
      re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      name: (m) => m[1],
    },
    {
      kind: "interface",
      re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
      name: (m) => m[1],
    },
    {
      kind: "function",
      re: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
      name: (m) => m[1],
    },
    {
      kind: "function",
      re: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
      name: (m) => m[1],
    },
    { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, name: (m) => m[1] },
    { kind: "enum", re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, name: (m) => m[1] },
  ],
  py: [
    { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, name: (m) => m[1] },
    { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
  ],
  go: [
    { kind: "function", re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, name: (m) => m[1] },
    { kind: "type", re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, name: (m) => m[1] },
  ],
  rs: [
    { kind: "function", re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
    {
      kind: "type",
      re: /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/,
      name: (m) => m[1],
    },
  ],
  java: [
    {
      kind: "class",
      re: /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/,
      name: (m) => m[1],
    },
    { kind: "interface", re: /^\s*(?:public\s+)?interface\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
    { kind: "enum", re: /^\s*(?:public\s+)?enum\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
  ],
  c: [
    { kind: "type", re: /^\s*(?:typedef\s+)?(?:struct|enum)\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
    {
      kind: "function",
      re: /^\s*(?:static\s+)?[A-Za-z_][\w*\s]*\s+([A-Za-z_]\w*)\s*\([^;]*$/,
      name: (m) => m[1],
    },
  ],
  rb: [
    { kind: "function", re: /^\s*def\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
    { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
    { kind: "module", re: /^\s*module\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
  ],
};
SYMBOL_RULES.js = SYMBOL_RULES.ts;

const IMPORT_RULES: Record<string, RegExp[]> = {
  ts: [
    /import\s+(?:type\s+)?(?:[^'"]*from\s+)?['"]([^'"]+)['"]/,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
    /export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/,
  ],
  py: [/^\s*import\s+([\w.]+)/, /^\s*from\s+([\w.]+)\s+import/],
  go: [/"((?:[\w./-]+\.)?[\w./-]+)"/],
  rs: [/^\s*use\s+([\w:]+)/, /^\s*mod\s+([A-Za-z_]\w*)\s*;/],
  java: [/^\s*import\s+([\w.]+)\s*;/],
  c: [/^\s*#\s*include\s+[<"]([^>"]+)[>"]/],
  rb: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/],
};
IMPORT_RULES.js = IMPORT_RULES.ts;
IMPORT_RULES.kt = IMPORT_RULES.java;

function extractFile(doc: FileDoc): FileKnowledge {
  const lang = EXT_LANG[doc.ext] ?? "ts";
  const symbols: FileKnowledge["symbols"] = [];
  const imports = new Set<string>();
  const rules = SYMBOL_RULES[lang] ?? [];
  const importRules = IMPORT_RULES[lang] ?? [];
  const lines = doc.content.split("\n").slice(0, MAX_LINE);
  lines.forEach((line, i) => {
    if (symbols.length < MAX_SYMBOLS_PER_FILE) {
      for (const rule of rules) {
        const m = line.match(rule.re);
        const name = m ? rule.name(m) : null;
        if (name) {
          symbols.push({ name, kind: rule.kind, line: i + 1 });
          break;
        }
      }
    }
    for (const re of importRules) {
      const m = line.match(re);
      if (m?.[1]) {
        imports.add(m[1]);
        break;
      }
    }
  });
  return { path: doc.path, ext: doc.ext, symbols, imports: [...imports] };
}

/** Resolve a relative import specifier to a repo path, if it refers to a
 *  file inside the repo. Package specifiers stay external. */
function resolveImport(fromPath: string, spec: string, paths: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const dir = fromPath.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") dir.pop();
    else if (seg && seg !== ".") dir.push(seg);
  }
  const base = dir.join("/");
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.py`,
    `${base}.go`,
    `${base}.rs`,
    `${base}.rb`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/mod.rs`,
    `${base}/__init__.py`,
  ]) {
    if (paths.has(cand)) return cand;
  }
  return null;
}

export function topModule(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts[0] : "(root)";
}

const ENTRYPOINT_FILES = new Set([
  "main.go",
  "main.rs",
  "main.py",
  "app.py",
  "index.ts",
  "index.js",
  "main.ts",
  "main.js",
  "cli.ts",
  "server.ts",
  "index.tsx",
  "mod.rs",
]);

// --- build -----------------------------------------------------------------

function buildEdges(files: FileKnowledge[]): { edges: KnowledgeEdge[]; packages: string[] } {
  const paths = new Set(files.map((f) => f.path));
  const edges: KnowledgeEdge[] = [];
  const packages = new Set<string>();
  for (const f of files) {
    for (const spec of f.imports) {
      const resolved = resolveImport(f.path, spec, paths);
      if (resolved) edges.push({ from: f.path, to: resolved, kind: "file" });
      else if (!spec.startsWith(".")) {
        const pkg = spec
          .split("/")
          .slice(0, spec.startsWith("@") ? 2 : 1)
          .join("/");
        packages.add(pkg);
        edges.push({ from: f.path, to: pkg, kind: "package" });
      }
    }
  }
  return { edges, packages: [...packages].sort() };
}

function detectEntrypoints(files: FileKnowledge[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const base = f.path.split("/").pop() ?? "";
    if (ENTRYPOINT_FILES.has(base)) out.push(f.path);
    else if (f.symbols.some((s) => s.kind === "function" && s.name === "main")) out.push(f.path);
  }
  return out.slice(0, 20);
}

/** Deterministic mermaid module graph — module-level dep edges, no AI. */
export function mermaidModuleGraph(files: FileKnowledge[], edges: KnowledgeEdge[]): string {
  const mods = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.kind !== "file") continue;
    const a = topModule(e.from);
    const b = topModule(e.to);
    if (a === b) continue;
    if (!mods.has(a)) mods.set(a, new Set());
    mods.get(a)!.add(b);
  }
  const lines = ["graph LR"];
  const seen = new Set<string>();
  for (const [a, targets] of mods) {
    for (const b of targets) {
      const edge = `  ${safeNode(a)} --> ${safeNode(b)}`;
      if (!seen.has(edge)) {
        seen.add(edge);
        lines.push(edge);
      }
    }
  }
  if (seen.size === 0) {
    const modules = [...new Set(files.map((f) => topModule(f.path)))].slice(0, 12);
    for (const m of modules) lines.push(`  ${safeNode(m)}`);
  }
  return lines.join("\n");
}

function safeNode(s: string): string {
  return `"${s.replace(/[^A-Za-z0-9_.\-/]/g, "_")}"`;
}

function mermaidPackageGraph(packages: string[]): string {
  const lines = ["graph LR", "  repo((repo))"];
  for (const p of packages.slice(0, 30)) lines.push(`  repo --> ${safeNode(p)}`);
  return lines.join("\n");
}

// --- AI enrichment (best-effort) ------------------------------------------

async function aiSummarize(
  env: Env,
  kb: Pick<RepoKnowledge, "files" | "edges" | "packages" | "entrypoints">
): Promise<Pick<RepoKnowledge, "summary" | "moduleBlurbs" | "glossary"> | null> {
  const ai = (env as Env & { AI?: Ai }).AI;
  if (!ai) return null;
  const modules = [...new Set(kb.files.map((f) => topModule(f.path)))];
  const prompt = [
    "You are generating a repo knowledge base for a git forge. Given the file",
    "inventory below, respond with STRICT JSON only:",
    '{"summary": "...", "module_blurbs": {"<module>": "..."}, "glossary": [{"term": "...", "definition": "..."}]}',
    "Keep summary under 400 chars, blurbs under 120 chars each, at most 12 glossary terms.",
    "",
    `modules: ${modules.join(", ")}`,
    `packages: ${kb.packages.slice(0, 30).join(", ")}`,
    `entrypoints: ${kb.entrypoints.join(", ")}`,
    `files: ${kb.files
      .slice(0, 120)
      .map(
        (f) =>
          `${f.path} [${f.symbols
            .slice(0, 4)
            .map((s) => s.name)
            .join(",")}]`
      )
      .join("\n")}`,
  ].join("\n");
  try {
    const res = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
      prompt,
      max_tokens: 1200,
    });
    const text = (res as { response?: string }).response ?? "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as {
      summary?: string;
      module_blurbs?: Record<string, string>;
      glossary?: { term?: string; definition?: string }[];
    };
    const glossary = (parsed.glossary ?? [])
      .filter((g): g is { term: string; definition: string } => !!g.term && !!g.definition)
      .slice(0, MAX_GLOSSARY);
    return {
      summary: (parsed.summary ?? "").slice(0, 1200),
      moduleBlurbs: parsed.module_blurbs ?? {},
      glossary,
    };
  } catch {
    return null;
  }
}

function fallbackSummary(files: FileKnowledge[], packages: string[]): string {
  const mods = [...new Set(files.map((f) => topModule(f.path)))];
  const kinds = new Map<string, number>();
  for (const f of files) for (const s of f.symbols) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  const kindStr = [...kinds.entries()].map(([k, n]) => `${n} ${k}s`).join(", ");
  return (
    `Repository with ${files.length} indexed files across ${mods.length} top-level areas` +
    ` (${mods.slice(0, 8).join(", ")}${mods.length > 8 ? "…" : ""}).` +
    (kindStr ? ` Declares ${kindStr}.` : "") +
    (packages.length
      ? ` Depends on ${packages.slice(0, 6).join(", ")}${packages.length > 6 ? "…" : ""}.`
      : "")
  );
}

// --- pipeline --------------------------------------------------------------

export async function buildRepoKnowledge(
  env: Env,
  doName: string,
  cacheCtx: CacheContext | undefined
): Promise<RepoKnowledge> {
  const log = createLogger(env.LOG_LEVEL, { service: "Knowledge", repoId: doName });
  const built = await repoSearchDocs(env, doName, cacheCtx);
  const files = (built?.docs ?? []).slice(0, MAX_FILES).map(extractFile);
  const { edges, packages } = buildEdges(files);
  const entrypoints = detectEntrypoints(files);
  const ai = await aiSummarize(env, { files, edges, packages, entrypoints });
  const diagrams = [
    { id: "modules", title: "Module dependency map", mermaid: mermaidModuleGraph(files, edges) },
    { id: "packages", title: "External dependencies", mermaid: mermaidPackageGraph(packages) },
  ];
  const kb: RepoKnowledge = {
    version: 1,
    headOid: built?.headOid ?? null,
    generated: Date.now(),
    summary: ai?.summary || fallbackSummary(files, packages),
    moduleBlurbs: ai?.moduleBlurbs ?? {},
    files,
    edges,
    packages,
    entrypoints,
    glossary: ai?.glossary ?? [],
    diagrams,
    tours: buildTours(files, entrypoints, edges),
  };
  log.info("kb:built", {
    files: files.length,
    edges: edges.length,
    aiSummary: !!ai,
  });
  return kb;
}

function buildTours(
  files: FileKnowledge[],
  entrypoints: string[],
  edges: KnowledgeEdge[]
): RepoKnowledge["tours"] {
  const tours: RepoKnowledge["tours"] = [];
  // "Request/execution flow" tour: entrypoint → its direct file deps.
  const start = entrypoints[0];
  if (start) {
    const steps = [{ path: start, note: "Entrypoint — start here." }];
    const direct = edges.filter((e) => e.from === start && e.kind === "file").map((e) => e.to);
    for (const p of direct.slice(0, 6)) {
      steps.push({ path: p, note: `Imported by the entrypoint.` });
    }
    tours.push({ id: "flow", title: "Main flow", steps });
  }
  const topDefs = [...files]
    .sort((a, b) => b.symbols.length - a.symbols.length)
    .slice(0, 5)
    .map((f) => ({
      path: f.path,
      line: f.symbols[0]?.line,
      note: `Densest module (${f.symbols.length} symbols).`,
    }));
  if (topDefs.length) tours.push({ id: "core", title: "Where the logic lives", steps: topDefs });
  return tours;
}

/** Refresh on push — keyed to HEAD so stale KBs are never served. */
export async function refreshRepoKnowledge(
  env: Env,
  doName: string,
  headOid: string | null,
  cacheCtx: CacheContext | undefined
): Promise<RepoKnowledge> {
  const existing = await readRepoKnowledge(env, doName);
  if (existing && existing.headOid === headOid) return existing;
  const kb = await buildRepoKnowledge(env, doName, cacheCtx);
  await writeRepoKnowledge(env, doName, kb);
  return kb;
}

// --- llms.txt ---------------------------------------------------------------

export function llmsTxt(kb: RepoKnowledge, owner: string, repo: string): string {
  const mods = [...new Set(kb.files.map((f) => topModule(f.path)))];
  const lines = [
    `# ${owner}/${repo}`,
    "",
    `> ${kb.summary || "Repository knowledge base."}`,
    "",
    "## Structure",
    ...mods
      .slice(0, 20)
      .map((m) => `- ${m}${kb.moduleBlurbs[m] ? ` — ${kb.moduleBlurbs[m]}` : ""}`),
    "",
    "## Entrypoints",
    ...kb.entrypoints.slice(0, 10).map((e) => `- ${e}`),
    "",
    "## Dependencies",
    ...kb.packages.slice(0, 20).map((p) => `- ${p}`),
  ];
  return lines.join("\n") + "\n";
}

export function llmsFullTxt(kb: RepoKnowledge, owner: string, repo: string): string {
  const lines = [llmsTxt(kb, owner, repo), "", "## Files", ""];
  for (const f of kb.files.slice(0, MAX_FILES)) {
    const syms = f.symbols
      .slice(0, 8)
      .map((s) => `${s.kind} ${s.name}`)
      .join(", ");
    lines.push(`- ${f.path}${syms ? ` — ${syms}` : ""}`);
  }
  if (kb.glossary.length) {
    lines.push("", "## Glossary");
    for (const g of kb.glossary) lines.push(`- **${g.term}** — ${g.definition}`);
  }
  return lines.join("\n") + "\n";
}

/** Symbol xref: where `name` is defined + every file importing a path that
 *  defines it. */
export function symbolXref(kb: RepoKnowledge, name: string) {
  const defs: { path: string; kind: string; line: number }[] = [];
  for (const f of kb.files) {
    for (const s of f.symbols) {
      if (s.name === name) defs.push({ path: f.path, kind: s.kind, line: s.line });
    }
  }
  const defPaths = new Set(defs.map((d) => d.path));
  const usedIn = kb.edges.filter((e) => e.kind === "file" && defPaths.has(e.to)).map((e) => e.from);
  return { name, defs, used_in: [...new Set(usedIn)] };
}
