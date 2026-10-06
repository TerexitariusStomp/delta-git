import type { AppRouter } from "@/worker/routes/hono";

import { readPath } from "@/worker/git/operations/read/tree";
import { findMergeBase } from "@/worker/merge/engine";
import { commitTreeOf, diffTrees, type TreeChange } from "./gitdata";
import { gErr, resolveGitnessRepo } from "./shared";

// CODEOWNERS — GitHub's review-ownership convention. Patterns follow
// gitignore syntax (minus negation), anchored to the repo root regardless of
// which conventional location hosts the file. Last matching rule wins, so
// evaluation walks rules in order and keeps the latest hit per path.

export type CodeOwnerRule = {
  pattern: string;
  owners: string[];
};

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

const REGEXP_ESCAPE = /[.+^${}()|\\]/g;

/** gitignore-style glob → RegExp. `*`/`?` never cross `/`; `**` does. */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);

  let body = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i]!;
    if (c === "\\" && i + 1 < p.length) {
      body += p[i + 1]!.replace(REGEXP_ESCAPE, "\\$&");
      i += 2;
      continue;
    }
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**/` matches zero or more path segments; bare `**` matches any.
        if (p[i + 2] === "/") {
          body += "(?:[^/]+/)*";
          i += 3;
        } else {
          body += ".*";
          i += 2;
        }
      } else {
        body += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (c === "?") {
      body += "[^/]";
      i += 1;
      continue;
    }
    if (c === "[") {
      const close = p.indexOf("]", i + 1);
      if (close > i) {
        body += p.slice(i, close + 1);
        i = close + 1;
      } else {
        body += "\\[";
        i += 1;
      }
      continue;
    }
    body += c.replace(REGEXP_ESCAPE, "\\$&");
    i += 1;
  }

  // Patterns containing an internal slash anchor to the root; bare basenames
  // (`*.js`, `docs/`) match at any depth — gitignore semantics.
  const prefix = anchored || p.includes("/") ? "^" : "(?:^|/)";
  const suffix = dirOnly ? "(?:/.*)?$" : "$";
  return new RegExp(`${prefix}${body}${suffix}`);
}

export function parseCodeowners(source: string): CodeOwnerRule[] {
  const rules: CodeOwnerRule[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [pattern, ...owners] = parts;
    if (!pattern || owners.length === 0) continue;
    rules.push({ pattern, owners });
  }
  return rules;
}

type CompiledRule = { owners: string[]; re: RegExp };

export function compileCodeowners(rules: CodeOwnerRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    try {
      compiled.push({ owners: rule.owners, re: globToRegExp(rule.pattern) });
    } catch {
      // Malformed patterns are skipped rather than failing the whole file —
      // matches GitHub's lenient behavior on partially-invalid CODEOWNERS.
    }
  }
  return compiled;
}

/** Owners for a path — last matching rule wins, matching GitHub. */
export function ownersForPath(compiled: CompiledRule[], path: string): string[] {
  const normalized = path.replace(/^\/+/, "");
  let owners: string[] = [];
  for (const rule of compiled) {
    if (rule.re.test(normalized)) owners = rule.owners;
  }
  return owners;
}

export function registerGitnessCodeowners(router: AppRouter) {
  // GET /api/v1/repos/{ref}/codeowners — the parsed rule list.
  router.get("/api/v1/repos/:repo_ref{.+}/codeowners", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const source = await loadCodeownersSource(c.env, access);
    if (source === null) return c.json({ rules: [] });
    return c.json({ rules: parseCodeowners(source) });
  });

  // GET /api/v1/repos/{ref}/codeowners/owners?paths=a,b — resolved owners per
  // path (the query agents use for reviewer assignment).
  router.get("/api/v1/repos/:repo_ref{.+}/codeowners/owners", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const paths = (c.req.query("paths") ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (paths.length === 0 || paths.length > 256) {
      return gErr(c, 422, "paths required (comma-separated, max 256)");
    }
    const source = await loadCodeownersSource(c.env, access);
    const compiled = compileCodeowners(source === null ? [] : parseCodeowners(source));
    const result: Record<string, string[]> = {};
    for (const path of paths) result[path] = ownersForPath(compiled, path);
    return c.json({ owners: result });
  });
}

/**
 * Reviewer suggestions for a change set: every owner of every touched path,
 * deduplicated, with the actor stripped (self-review is meaningless).
 * Returns `@`-prefixed handles as written in the CODEOWNERS file.
 */
export async function suggestCodeOwnerReviewers(args: {
  env: Env;
  access: { route: { doName: string }; cacheCtx?: Parameters<typeof readPath>[4] };
  baseOid: string;
  headOid: string;
  exclude?: string;
}): Promise<string[]> {
  const source = await loadCodeownersSource(args.env, args.access);
  if (source === null) return [];
  const compiled = compileCodeowners(parseCodeowners(source));
  if (compiled.length === 0) return [];

  const mergeBase = await findMergeBase(
    args.env,
    args.access.route.doName,
    args.baseOid,
    args.headOid,
    args.access.cacheCtx
  ).catch(() => args.baseOid);
  const [baseTree, headTree] = await Promise.all([
    commitTreeOf(
      args.env,
      args.access.route.doName,
      mergeBase ?? args.baseOid,
      args.access.cacheCtx
    ),
    commitTreeOf(args.env, args.access.route.doName, args.headOid, args.access.cacheCtx),
  ]);
  if (!headTree) return [];

  const changes: TreeChange[] = [];
  await diffTrees(
    args.env,
    args.access.route.doName,
    baseTree,
    headTree,
    "",
    changes,
    { pairs: 0 },
    args.access.cacheCtx
  );
  const owners = new Set<string>();
  for (const change of changes.slice(0, 256)) {
    for (const owner of ownersForPath(compiled, change.path)) owners.add(owner);
  }
  if (args.exclude) owners.delete(`@${args.exclude}`);
  return [...owners];
}

export async function loadCodeownersSource(
  env: Env,
  access: { route: { doName: string }; cacheCtx?: Parameters<typeof readPath>[4] }
): Promise<string | null> {
  for (const path of CODEOWNERS_PATHS) {
    const result = await readPath(env, access.route.doName, "HEAD", path, access.cacheCtx).catch(
      () => null
    );
    if (!result || result.type !== "blob" || result.tooLarge) continue;
    return new TextDecoder().decode(result.content);
  }
  return null;
}
