// KV-backed stores for gitness features that have no DO/D1 equivalent.
//
// These are real records — labels, branch rules, pipeline definitions,
// link/fork upstream config — persisted in the ROUTES namespace under
// repo- or space-scoped keys. ROUTES is already the route-cache KV; records
// live under `g*` prefixes so route-cache keys stay untouched.

export interface RepoLabel {
  id: number;
  key: string;
  color?: string;
  description?: string;
  created: number;
}

const LABELS_TTL_S = 0; // permanent — no TTL on metadata records.

export async function readRepoLabels(env: Env, doName: string): Promise<RepoLabel[]> {
  const raw = await env.ROUTES.get(`glabels:${doName}`, "json").catch(() => null);
  return (raw as RepoLabel[] | null) ?? [];
}

export async function writeRepoLabels(env: Env, doName: string, labels: RepoLabel[]) {
  await env.ROUTES.put(`glabels:${doName}`, JSON.stringify(labels), {
    expirationTtl: LABELS_TTL_S || undefined,
  });
}

// ---------------------------------------------------------------------------
// Branch/tag protection rules
// ---------------------------------------------------------------------------

export interface RepoRule {
  id: number;
  identifier: string;
  /** `branch` | `tag` — the ref class the rule protects. */
  type: string;
  /** Ref glob — `main`, `release/*`, or `*` . */
  pattern: string;
  state: "active" | "monitor" | "disabled";
  definition: {
    /** Block deleting matching refs. */
    delete?: boolean;
    /** Block updating (push/commit) matching refs. */
    update?: boolean;
    /** Require pull-request review (block direct commits). */
    pullreq?: boolean;
  };
  created: number;
  updated: number;
}

export async function readRepoRules(env: Env, doName: string): Promise<RepoRule[]> {
  const raw = await env.ROUTES.get(`grules:${doName}`, "json").catch(() => null);
  return (raw as RepoRule[] | null) ?? [];
}

export async function writeRepoRules(env: Env, doName: string, rules: RepoRule[]) {
  await env.ROUTES.put(`grules:${doName}`, JSON.stringify(rules));
}

/**
 * Minimal glob: `*` matches anything, `prefix/*` matches a namespace prefix,
 * otherwise exact. Rules in `monitor`/`disabled` state never block.
 */
export function ruleBlocksRef(rules: RepoRule[], ref: string, verb: "update" | "delete"): boolean {
  const short = ref.replace(/^refs\/(heads|tags)\//, "");
  const kind = ref.startsWith("refs/tags/") ? "tag" : "branch";
  return rules.some((r) => {
    if (r.state !== "active" || r.type !== kind) return false;
    if (!r.definition[verb]) return false;
    const p = r.pattern;
    if (p === "*" || p === short) return true;
    if (p.endsWith("/*") && short.startsWith(p.slice(0, -1))) return true;
    return false;
  });
}

// ---------------------------------------------------------------------------
// Pipelines (definitions only — no execution engine is bound)
// ---------------------------------------------------------------------------

export interface RepoPipeline {
  id: number;
  identifier: string;
  config_path: string;
  description?: string;
  created: number;
  updated: number;
}

export async function readRepoPipelines(env: Env, doName: string): Promise<RepoPipeline[]> {
  const raw = await env.ROUTES.get(`gpipes:${doName}`, "json").catch(() => null);
  return (raw as RepoPipeline[] | null) ?? [];
}

export async function writeRepoPipelines(env: Env, doName: string, pipes: RepoPipeline[]) {
  await env.ROUTES.put(`gpipes:${doName}`, JSON.stringify(pipes));
}

// ---------------------------------------------------------------------------
// Remote linkage (import/link/fork-sync upstreams)
// ---------------------------------------------------------------------------

export interface RepoLink {
  remote_url: string;
  type: "linked" | "fork";
  upstream_ref?: string;
  created: number;
}

export async function readRepoLink(env: Env, doName: string): Promise<RepoLink | null> {
  const raw = await env.ROUTES.get(`glink:${doName}`, "json").catch(() => null);
  return (raw as RepoLink | null) ?? null;
}

export async function writeRepoLink(env: Env, doName: string, link: RepoLink) {
  await env.ROUTES.put(`glink:${doName}`, JSON.stringify(link));
}

// ---------------------------------------------------------------------------
// Import/sync progress — the create/import/link/fork endpoints kick the real
// ingest off inside `ctx.waitUntil`; the progress endpoints read this record
// so the SPA's polling has real state to watch.
// ---------------------------------------------------------------------------

export interface ImportProgress {
  state: "running" | "finished" | "failed";
  /** Real counters or the failure reason once the ingest completes. */
  refs?: number;
  objects?: number;
  reason?: string;
  updated: number;
}

export async function readImportProgress(env: Env, doName: string): Promise<ImportProgress | null> {
  const raw = await env.ROUTES.get(`gimport:${doName}`, "json").catch(() => null);
  return (raw as ImportProgress | null) ?? null;
}

export async function writeImportProgress(env: Env, doName: string, progress: ImportProgress) {
  await env.ROUTES.put(`gimport:${doName}`, JSON.stringify(progress));
}

// ---------------------------------------------------------------------------
// PR file-view marks — per (repo, intent, viewer): which diff files the
// viewer marked as reviewed, and at which blob checksum. The SPA stores the
// whole map; we persist it verbatim so "viewed" survives reloads.
// ---------------------------------------------------------------------------

export interface FileViews {
  /** path → blob sha the viewer marked viewed at ("" when unmarked). */
  views: Record<string, string>;
  updated: number;
}

export async function readFileViews(
  env: Env,
  doName: string,
  intentId: string,
  viewer: string
): Promise<FileViews> {
  const raw = await env.ROUTES.get(`gfv:${doName}:${intentId}:${viewer}`, "json").catch(() => null);
  return (raw as FileViews | null) ?? { views: {}, updated: 0 };
}

export async function writeFileViews(
  env: Env,
  doName: string,
  intentId: string,
  viewer: string,
  views: FileViews
) {
  await env.ROUTES.put(`gfv:${doName}:${intentId}:${viewer}`, JSON.stringify(views));
}

// ---------------------------------------------------------------------------
// Pipeline/PR templates — real records; used by the template pickers.
// ---------------------------------------------------------------------------

export interface RepoTemplate {
  id: number;
  identifier: string;
  /** Template body (markdown/yaml — opaque to us). */
  data: string;
  created: number;
}

export async function readRepoTemplates(env: Env, doName: string): Promise<RepoTemplate[]> {
  const raw = await env.ROUTES.get(`gtmpl:${doName}`, "json").catch(() => null);
  return (raw as RepoTemplate[] | null) ?? [];
}

export async function writeRepoTemplates(env: Env, doName: string, templates: RepoTemplate[]) {
  await env.ROUTES.put(`gtmpl:${doName}`, JSON.stringify(templates));
}

// ---------------------------------------------------------------------------
// Repo security settings — secret-scanning enforcement is real on the
// receive path; the toggle here is persisted state the settings page reads
// and writes.
// ---------------------------------------------------------------------------

export interface SecuritySettings {
  /** Reject pushes whose packs trip the secret scanner. */
  secret_scanning?: boolean;
  /** Block force-pushes / history rewrites on receive. */
  force_push_blocked?: boolean;
}

export async function readSecuritySettings(env: Env, doName: string): Promise<SecuritySettings> {
  const raw = await env.ROUTES.get(`gsec:${doName}`, "json").catch(() => null);
  return (raw as SecuritySettings | null) ?? {};
}

export async function writeSecuritySettings(env: Env, doName: string, s: SecuritySettings) {
  await env.ROUTES.put(`gsec:${doName}`, JSON.stringify(s));
}
