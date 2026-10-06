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
    /**
     * Required status-check contexts — merges into matching refs 409
     * until every listed context reports `success` on the PR head
     * (GitHub "require status checks to pass" parity).
     */
    status_checks?: { contexts?: string[] };
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
 * otherwise exact. Rules in `monitor`/`disabled` state never match.
 */
function ruleMatchesRef(rule: RepoRule, short: string, kind: string): boolean {
  if (rule.state !== "active" || rule.type !== kind) return false;
  const p = rule.pattern;
  if (p === "*" || p === short) return true;
  if (p.endsWith("/*") && short.startsWith(p.slice(0, -1))) return true;
  return false;
}

export function ruleBlocksRef(rules: RepoRule[], ref: string, verb: "update" | "delete"): boolean {
  const short = ref.replace(/^refs\/(heads|tags)\//, "");
  const kind = ref.startsWith("refs/tags/") ? "tag" : "branch";
  return rules.some((r) => ruleMatchesRef(r, short, kind) && Boolean(r.definition[verb]));
}

/**
 * Union of required status-check contexts across active branch rules
 * matching `ref` (full `refs/heads/...`). Empty array = no check gate.
 */
export function requiredCheckContexts(rules: RepoRule[], ref: string): string[] {
  const short = ref.replace(/^refs\/heads\//, "");
  const contexts = new Set<string>();
  for (const rule of rules) {
    if (!ruleMatchesRef(rule, short, "branch")) continue;
    for (const ctx of rule.definition.status_checks?.contexts ?? []) {
      if (ctx.trim()) contexts.add(ctx.trim());
    }
  }
  return [...contexts];
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

/** A declared pipeline trigger — `push` events are honored by the queue task. */
export interface RepoPipelineTrigger {
  identifier: string;
  /** push | pull_request | cron (cron records persist; scheduling is a gap). */
  event: string;
  /** Glob-ish branch filter (bare names or `*`-suffix prefixes). */
  branch_scope?: string;
  cron?: string;
  enabled: boolean;
  created: number;
}

export interface RepoPipeline {
  id: number;
  identifier: string;
  config_path: string;
  /** Branch the pipeline yaml and manual runs target (defaults to main). */
  default_branch?: string;
  description?: string;
  /** Push trigger — when true, every advancing head ref spawns an execution. */
  on_push?: boolean;
  /** Optional branch allow-list for the push trigger (bare names). */
  branches?: string[];
  triggers?: RepoPipelineTrigger[];
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
// Pipeline executions — real records written by the runner protocol
// (/api/{owner}/{repo}/dg/runner/*) and the push trigger. The list record
// holds execution metadata; log lines live per-execution under a second key
// so list reads stay small.
// ---------------------------------------------------------------------------

export type ExecutionStatus =
  | "pending"
  | "running"
  | "success"
  | "failure"
  | "error"
  | "killed"
  | "skipped";

export interface RepoExecutionStep {
  number: number;
  name: string;
  status: ExecutionStatus;
  exit_code?: number;
  started?: number;
  stopped?: number;
}

export interface RepoExecutionStage {
  number: number;
  name: string;
  status: ExecutionStatus;
  exit_code?: number;
  started?: number;
  stopped?: number;
  steps: RepoExecutionStep[];
}

export interface RepoExecution {
  /** Monotonic per-pipeline number — matches gitness `execution_number`. */
  number: number;
  pipeline_id: number;
  pipeline_uid: string;
  status: ExecutionStatus;
  /** push | manual | cron */
  event: string;
  ref: string;
  after?: string;
  before?: string;
  message?: string;
  author_name?: string;
  author_email?: string;
  /** Runner that claimed this execution; set on claim. */
  runner?: string;
  /** Last runner heartbeat (ms) — stale heartbeats mark the exec `error`. */
  heartbeat?: number;
  error?: string;
  created: number;
  started?: number;
  finished?: number;
  stages: RepoExecutionStage[];
}

export interface RepoExecutionLogLine {
  stage: number;
  step: number;
  /** Line number within the step. */
  pos: number;
  time: number;
  line: string;
}

const MAX_EXECUTIONS = 100;
const MAX_LOG_LINES = 2000;

export async function readRepoExecutions(env: Env, doName: string): Promise<RepoExecution[]> {
  const raw = await env.ROUTES.get(`gexecs:${doName}`, "json").catch(() => null);
  return (raw as RepoExecution[] | null) ?? [];
}

export async function writeRepoExecutions(env: Env, doName: string, execs: RepoExecution[]) {
  // Newest-first, bounded — old executions age off the tail.
  await env.ROUTES.put(`gexecs:${doName}`, JSON.stringify(execs.slice(0, MAX_EXECUTIONS)));
}

/** Read-mutate-write a single execution by pipeline+number. */
export async function updateRepoExecution(
  env: Env,
  doName: string,
  pipelineId: number,
  num: number,
  mutate: (exec: RepoExecution) => RepoExecution | null
): Promise<RepoExecution | null> {
  const execs = await readRepoExecutions(env, doName);
  const idx = execs.findIndex((e) => e.pipeline_id === pipelineId && e.number === num);
  if (idx < 0) return null;
  const next = mutate(execs[idx]);
  if (!next) return null;
  execs[idx] = next;
  await writeRepoExecutions(env, doName, execs);
  return next;
}

/** Next execution number for a pipeline (max existing + 1). */
export function nextExecutionNumber(execs: RepoExecution[], pipelineId: number): number {
  let max = 0;
  for (const e of execs) if (e.pipeline_id === pipelineId && e.number > max) max = e.number;
  return max + 1;
}

export async function readRepoExecutionLogs(
  env: Env,
  doName: string,
  pipelineId: number,
  num: number
): Promise<RepoExecutionLogLine[]> {
  const raw = await env.ROUTES.get(`gexeclogs:${doName}:${pipelineId}:${num}`, "json").catch(
    () => null
  );
  return (raw as RepoExecutionLogLine[] | null) ?? [];
}

export async function appendRepoExecutionLogs(
  env: Env,
  doName: string,
  pipelineId: number,
  num: number,
  lines: RepoExecutionLogLine[]
): Promise<RepoExecutionLogLine[]> {
  const existing = await readRepoExecutionLogs(env, doName, pipelineId, num);
  const next = [...existing, ...lines].slice(-MAX_LOG_LINES);
  await env.ROUTES.put(`gexeclogs:${doName}:${pipelineId}:${num}`, JSON.stringify(next));
  return next;
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
// Pinned issues — ordered issue numbers surfaced at the top of the issues
// list. GitHub caps pins at 3 per repo; the cap lives in the route layer.
// ---------------------------------------------------------------------------

export const MAX_PINNED_ISSUES = 3;

export async function readPinnedIssues(env: Env, doName: string): Promise<number[]> {
  const raw = await env.ROUTES.get(`gpins:${doName}`, "json").catch(() => null);
  return (raw as number[] | null) ?? [];
}

export async function writePinnedIssues(env: Env, doName: string, pins: number[]) {
  await env.ROUTES.put(`gpins:${doName}`, JSON.stringify(pins));
}

// ---------------------------------------------------------------------------
// Saved issue views — repo-shared named filter presets (the `q` qualifier
// string). Writers create them for the whole space to use.
// ---------------------------------------------------------------------------

export interface SavedView {
  id: number;
  name: string;
  /** Raw qualifier string passed to `parseIssueQuery` (`is:open label:bug`). */
  query: string;
  created: number;
}

export const MAX_SAVED_VIEWS = 50;

export async function readSavedViews(env: Env, doName: string): Promise<SavedView[]> {
  const raw = await env.ROUTES.get(`gviews:${doName}`, "json").catch(() => null);
  return (raw as SavedView[] | null) ?? [];
}

export async function writeSavedViews(env: Env, doName: string, views: SavedView[]) {
  await env.ROUTES.put(`gviews:${doName}`, JSON.stringify(views));
}

// ---------------------------------------------------------------------------
// Hidden comments — moderation flags over DO issue comments (they're DO
// rows, so the flag is a KV overlay keyed by comment id). PR comments are
// KV records already and carry the field directly.
// ---------------------------------------------------------------------------

export interface HiddenComment {
  reason?: string;
  by: string;
  at: number;
}

export async function readHiddenComments(
  env: Env,
  doName: string
): Promise<Record<string, HiddenComment>> {
  const raw = await env.ROUTES.get(`ghidden:${doName}`, "json").catch(() => null);
  return (raw as Record<string, HiddenComment> | null) ?? {};
}

export async function writeHiddenComments(
  env: Env,
  doName: string,
  hidden: Record<string, HiddenComment>
) {
  await env.ROUTES.put(`ghidden:${doName}`, JSON.stringify(hidden));
}

// ---------------------------------------------------------------------------
// Issue types — free-form per-issue type names ("Bug", "Feature", "Task")
// stored as a number → name map, same shape as the locks map. Lives in KV
// rather than the DO so no schema migration is needed for a display field.
// ---------------------------------------------------------------------------

export async function readIssueTypes(env: Env, doName: string): Promise<Record<number, string>> {
  const raw = await env.ROUTES.get(`gitypes:${doName}`, "json").catch(() => null);
  return (raw as Record<number, string> | null) ?? {};
}

export async function writeIssueTypes(env: Env, doName: string, types: Record<number, string>) {
  await env.ROUTES.put(`gitypes:${doName}`, JSON.stringify(types));
}

// ---------------------------------------------------------------------------
// Locked conversations — every commenter here is a namespace member (the
// forge's collaborator equivalent), so GitHub's "collaborators exempt" lock
// would never bite. Our lock is a full freeze: no new comments until a
// writer unlocks. One repo-scoped map keeps list rendering to a single read.
// ---------------------------------------------------------------------------

export interface IssueLock {
  /** GitHub's lock vocabulary: off-topic | too heated | spam | resolved. */
  reason?: string;
  by: string;
  at: number;
}

export async function readIssueLocks(env: Env, doName: string): Promise<Record<string, IssueLock>> {
  const raw = await env.ROUTES.get(`glocks:${doName}`, "json").catch(() => null);
  return (raw as Record<string, IssueLock> | null) ?? {};
}

export async function writeIssueLocks(env: Env, doName: string, locks: Record<string, IssueLock>) {
  await env.ROUTES.put(`glocks:${doName}`, JSON.stringify(locks));
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
// User favorites — the repo-header star toggle and the repo list's
// `is_favorite` flag. One JSON array per user; resource ids are the
// numeric ids the facade already emits (`numericId`).
// ---------------------------------------------------------------------------

export interface FavoriteRef {
  resource_type: string;
  resource_id: number;
}

export async function readUserFavorites(env: Env, userId: string): Promise<FavoriteRef[]> {
  const raw = await env.ROUTES.get(`gfav:${userId}`, "json").catch(() => null);
  return (raw as FavoriteRef[] | null) ?? [];
}

export async function writeUserFavorites(env: Env, userId: string, favs: FavoriteRef[]) {
  await env.ROUTES.put(`gfav:${userId}`, JSON.stringify(favs));
}

// ---------------------------------------------------------------------------
// Repo security settings — secret-scanning enforcement is real on the
// receive path; the toggle here is persisted state the settings page reads
// and writes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sealed secrets — client-sovereign custody
// ---------------------------------------------------------------------------
// Secret VALUES never reach the server: the browser's key-custody worker
// seals them and holds the bytes. What we persist is metadata plus an
// optional client-wrapped ciphertext blob (AES-GCM to the client's vault
// key) for same-device restore and later delegate delivery — the server
// cannot unwrap it. A compromised platform leaks names and ciphertext only.
// ---------------------------------------------------------------------------

export interface SecretRecord {
  /** Client custody handle (`sec_…`) — opaque, issued by the broker. */
  id: string;
  name: string;
  description?: string;
  /** Hostnames this secret may be sent to (broker-enforced client-side). */
  allowed_hosts: string[];
  canary?: boolean;
  /** Optional client-wrapped ciphertext (opaque to the server). */
  ciphertext?: string;
  created_by?: string;
  created: number;
  updated: number;
}

export async function readSecrets(env: Env, scopeKey: string): Promise<SecretRecord[]> {
  const raw = await env.ROUTES.get(`gsecrets:${scopeKey}`, "json").catch(() => null);
  return (raw as SecretRecord[] | null) ?? [];
}

export async function writeSecrets(env: Env, scopeKey: string, secrets: SecretRecord[]) {
  await env.ROUTES.put(`gsecrets:${scopeKey}`, JSON.stringify(secrets));
}

// Repo push-scan policy — driven by the vendored security form's
// `vulnerability_scanning_mode` (detect/block/disabled). "report" records
// client-side scan attestations without gating; "require" refuses receive
// finalization when a pushed head has no pass/warn attestation; "off"
// disables both.
export type PushScanPolicy = "report" | "require" | "off";

export interface SecuritySettings {
  /** Include secret detectors in the client-side push scan suite. */
  secret_scanning?: boolean;
  /** Block force-pushes / history rewrites on receive. */
  force_push_blocked?: boolean;
  /** Client-side push scan enforcement level — see PushScanPolicy. */
  push_scan?: PushScanPolicy;
  /** Vendored `principal_committer_match` — stored, not yet enforced. */
  committer_match?: boolean;
}

export async function readSecuritySettings(env: Env, doName: string): Promise<SecuritySettings> {
  const raw = await env.ROUTES.get(`gsec:${doName}`, "json").catch(() => null);
  return (raw as SecuritySettings | null) ?? {};
}

export async function writeSecuritySettings(env: Env, doName: string, s: SecuritySettings) {
  await env.ROUTES.put(`gsec:${doName}`, JSON.stringify(s));
}
