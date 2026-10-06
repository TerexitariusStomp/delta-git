// Dependency graph — GitHub's dependency-submission API shape plus an
// OSV-backed vulnerability view.
//
//   POST /repos/{ref}/dependency-graph/snapshots   submit (writer)
//   GET  /repos/{ref}/dependency-graph             list resolved deps
//   GET  /repos/{ref}/dependency-graph/vulnerabilities   OSV batch query
//
// Snapshots replace the stored graph wholesale (GitHub semantics: a new
// snapshot for the same detector supersedes). Storage is KV
// (`gdeps:{doName}`) — the graph is small (<500 deps) and derived state.
//
// OSV lookups go to a single fixed upstream (api.osv.dev) — no
// user-controlled URLs, so no SSRF surface. Results cache 6h in KV;
// the fetcher is injectable for tests.

import type { AppRouter } from "@/worker/routes/hono";
import { gErr, requireWriter, resolveGitnessRepo } from "./shared";

const VULN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_DEPS = 500;
const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";

// purl type → OSV ecosystem name.
const PURL_ECOSYSTEMS: Record<string, string> = {
  npm: "npm",
  pypi: "PyPI",
  cargo: "crates.io",
  golang: "Go",
  maven: "Maven",
  gem: "RubyGems",
  nuget: "NuGet",
};

export interface DepEntry {
  /** Package URL, e.g. pkg:npm/lodash@4.17.21. */
  purl: string;
  name: string;
  version: string;
  ecosystem: string;
  relationship: string;
  scope: string;
  manifest: string;
}

interface DepSnapshot {
  sha?: string;
  ref?: string;
  detector?: { name?: string };
  submittedAt: number;
  deps: DepEntry[];
}

export type OsvQueryFetch = (input: string, init?: RequestInit) => Promise<Response>;

function depKey(doName: string): string {
  return `gdeps:${doName}`;
}
function vulnKey(doName: string): string {
  return `gdepsvuln:${doName}`;
}

async function readSnapshot(env: Env, doName: string): Promise<DepSnapshot | null> {
  return (await env.ROUTES.get(depKey(doName), "json").catch(() => null)) as DepSnapshot | null;
}

/** Parse `pkg:<type>/<name>@<version>` (namespace tolerated in name). */
function parsePurl(purl: string): { name: string; version: string; ecosystem: string } | null {
  const m = /^pkg:([a-z]+)\/(.+?)@([^@]+)$/.exec(purl);
  if (!m) return null;
  const ecosystem = PURL_ECOSYSTEMS[m[1]];
  if (!ecosystem) return null;
  return { name: m[2], version: m[3], ecosystem };
}

interface OsvVuln {
  id?: string;
  aliases?: string[];
  summary?: string;
  severity?: { type?: string; score?: string }[];
  affected?: {
    ranges?: { events?: { introduced?: string; fixed?: string }[] }[];
  }[];
}

/** Query OSV for the stored dep set — injectable fetch for tests. */
export async function queryOsvBatch(
  deps: DepEntry[],
  fetcher: OsvQueryFetch = fetch
): Promise<Record<string, OsvVuln[]>> {
  const queries = deps
    .filter((d) => d.ecosystem && d.version)
    .map((d) => ({
      package: { name: d.name, ecosystem: d.ecosystem },
      version: d.version,
    }));
  if (queries.length === 0) return {};
  const res = await fetcher(OSV_BATCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries }),
  });
  if (!res.ok) throw new Error(`osv:${res.status}`);
  const body = (await res.json()) as { results?: { vulns?: OsvVuln[] | null }[] };
  const out: Record<string, OsvVuln[]> = {};
  deps.forEach((d, i) => {
    const vulns = body.results?.[i]?.vulns ?? [];
    if (vulns.length > 0) out[d.purl] = vulns;
  });
  return out;
}

function depView(d: DepEntry) {
  return {
    package_url: d.purl,
    name: d.name,
    version: d.version,
    ecosystem: d.ecosystem,
    relationship: d.relationship,
    scope: d.scope,
    manifest: d.manifest,
  };
}

export function registerGitnessDepGraph(router: AppRouter) {
  // POST snapshots — GitHub dependency submission API request shape; we
  // flatten `manifests.*.resolved` into purl rows.
  router.post("/api/v1/repos/:repo_ref{.+}/dependency-graph/snapshots", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const body = (await c.req.json().catch(() => null)) as {
      sha?: string;
      ref?: string;
      detector?: { name?: string };
      manifests?: Record<
        string,
        {
          resolved?: Record<
            string,
            { relationship?: string; scope?: string; dependencies?: string[] }
          >;
        }
      >;
    } | null;
    if (!body?.manifests || Object.keys(body.manifests).length === 0) {
      return gErr(c, 422, "manifests with resolved dependencies required");
    }
    const deps: DepEntry[] = [];
    for (const [manifest, m] of Object.entries(body.manifests)) {
      for (const [purl, meta] of Object.entries(m.resolved ?? {})) {
        const parsed = parsePurl(purl);
        if (!parsed) continue; // unknown purl type — skip, don't fail the batch
        if (deps.length >= MAX_DEPS) break;
        deps.push({
          purl,
          name: parsed.name,
          version: parsed.version,
          ecosystem: parsed.ecosystem,
          relationship: meta.relationship ?? "unknown",
          scope: meta.scope ?? "runtime",
          manifest,
        });
      }
    }
    const snapshot: DepSnapshot = {
      sha: body.sha,
      ref: body.ref,
      detector: body.detector,
      submittedAt: Date.now(),
      deps,
    };
    await c.env.ROUTES.put(depKey(access.route.doName), JSON.stringify(snapshot));
    // A new graph invalidates the cached vuln report.
    await c.env.ROUTES.delete(vulnKey(access.route.doName));
    return c.json({ id: snapshot.submittedAt, dependencies: deps.length }, 201);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/dependency-graph", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const snap = await readSnapshot(c.env, access.route.doName);
    if (!snap) return c.json({ dependencies: [], submitted_at: null });
    return c.json({
      dependencies: snap.deps.map(depView),
      submitted_at: snap.submittedAt,
      sha: snap.sha ?? null,
      ref: snap.ref ?? null,
      detector: snap.detector?.name ?? null,
    });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/dependency-graph/vulnerabilities", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const snap = await readSnapshot(c.env, access.route.doName);
    if (!snap) return c.json({ vulnerabilities: {}, snapshot: null });

    const cached = (await c.env.ROUTES.get(vulnKey(access.route.doName), "json").catch(
      () => null
    )) as { at: number; vulnerabilities: Record<string, OsvVuln[]> } | null;
    if (cached && Date.now() - cached.at < VULN_CACHE_TTL_MS) {
      return c.json({ vulnerabilities: cached.vulnerabilities, snapshot: snap.submittedAt });
    }
    let vulnerabilities: Record<string, OsvVuln[]>;
    try {
      vulnerabilities = await queryOsvBatch(snap.deps);
    } catch {
      return gErr(c, 502, "osv query failed");
    }
    await c.env.ROUTES.put(
      vulnKey(access.route.doName),
      JSON.stringify({ at: Date.now(), vulnerabilities }),
      { expirationTtl: Math.ceil(VULN_CACHE_TTL_MS / 1000) * 2 }
    );
    return c.json({ vulnerabilities, snapshot: snap.submittedAt });
  });
}
