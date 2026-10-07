// dgit push-scan — client-side security scan for pushes to delta-git remotes.
//
// The forge's scan model: whatever is uploaded gets scanned *on the pusher's
// machine* before the pack leaves it. This module runs the local toolchain —
// gitleaks + trufflehog on the commit ranges being pushed, trivy fs + semgrep
// on a temp worktree at each pushed head — and produces a pass/warn/fail
// verdict plus an audit report under ~/.local/share/delta-git/scan-audits/.
//
// On by default. Opt-out precedence:
//   --no-scan flag  >  DG_SCAN=0 / SECURITY_SKIP=1  >  `git config dgit.scan false`
// A repo admin can set the repo's scanning policy to "block", in which case the
// server refuses heads with no prior pass/warn attestation regardless of local
// opt-out — attestation is POSTed to /api/{owner}/{repo}/dg/scan-attest.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface RefUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  /** 40 zeros when the remote ref does not exist yet. */
  remoteSha: string;
}

export type ToolStatus = "pass" | "warn" | "fail" | "skipped" | "missing";
export type ScanStatus = "pass" | "warn" | "fail" | "skipped";

export interface ToolRun {
  tool: string;
  version?: string;
  status: ToolStatus;
  findings: number;
  durationMs: number;
  note?: string;
}

export interface ScanResult {
  status: ScanStatus;
  toolRuns: ToolRun[];
  updates: RefUpdate[];
  reportPath?: string;
  durationMs: number;
}

export interface RemoteInfo {
  host: string;
  owner: string;
  repo: string;
}

const ZERO_SHA = "0000000000000000000000000000000000000000";
const TOOL_TIMEOUT_MS = 300_000;

// Paths almost always vendored third-party code or test fixtures — findings
// there are false positives (ported from the machine's pre-push gate).
const FP_PATH_RE =
  /(^|\/)(lib|vendor|node_modules|third[_-]?party|external|deps|testdata|fixtures?|__fixtures__|forge-std)(\/|$)|\.(test|spec)\./;

// Well-known public/test secrets (normalized: lowercase, no 0x prefix):
// Anvil/Hardhat default accounts, secp256k1 curve constants, sentinel values.
const ALLOWED_SECRETS = new Set([
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "47e179ec197488593b187f80a00eb0da91f1b9d0c13f8733639f19c30a34926a",
  "8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  "fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f",
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000001",
]);

function normalizeSecret(raw: string): string {
  return raw.toLowerCase().replace(/^0x/, "");
}

export function isAllowlistedSecret(raw: string): boolean {
  return ALLOWED_SECRETS.has(normalizeSecret(raw));
}

export function isFalsePositivePath(path: string): boolean {
  return FP_PATH_RE.test(path);
}

// ---------------------------------------------------------------------------
// tool discovery + shell helpers
// ---------------------------------------------------------------------------

function which(bin: string): string | null {
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function toolVersion(bin: string, flag = "--version"): string | undefined {
  try {
    return execFileSync(bin, [flag], { encoding: "utf8", timeout: 15_000 })
      .trim()
      .split("\n")[0]
      ?.slice(0, 64);
  } catch {
    return undefined;
  }
}

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
}

// ---------------------------------------------------------------------------
// pre-push stdin + range planning
// ---------------------------------------------------------------------------

/** Parse the `<local ref> <local sha> <remote ref> <remote sha>` lines git
 * feeds a pre-push hook on stdin. Deletes are filtered out. */
export function parsePrePushStdin(text: string): RefUpdate[] {
  const updates: RefUpdate[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts as [string, string, string, string];
    if (localSha === ZERO_SHA) continue; // ref deletion — nothing uploaded
    updates.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return updates;
}

/**
 * Ask git what `git push` *would* send — parses `--dry-run --porcelain` output
 * into the same RefUpdate shape the hook stdin provides. Used by `dgit push`
 * where no hook stdin exists.
 */
export function dryRunUpdates(repoDir: string, remote: string, refspecs: string[]): RefUpdate[] {
  const out = git(repoDir, ["push", "--dry-run", "--porcelain", remote, ...refspecs]);
  const updates: RefUpdate[] = [];
  for (const line of out.split("\n")) {
    // Porcelain format: "<flag>\t<from>:<to>\t<summary>" — one line per ref.
    const m = /^([ *+\-!=])\t([^\t]+)\t(.*)$/.exec(line);
    if (!m) continue;
    const [, flag, refs, summary] = m as unknown as [string, string, string, string];
    if (flag === "-" || flag === "!" || flag === "=") continue; // delete / rejected / up-to-date
    const [local, remoteRef] = refs.split(":");
    if (!local || !remoteRef) continue;
    let remoteSha = ZERO_SHA;
    const range = /([0-9a-f]{40})\.\.+([0-9a-f]{40})/.exec(summary);
    if (range) {
      remoteSha = range[1]!;
    } else {
      // Forced/new-tracking cases carry no old..new range — use the remote-
      // tracking ref if we have one, else scan as a new ref (full history).
      try {
        const short = remoteRef.replace(/^refs\/heads\//, "");
        remoteSha = git(repoDir, ["rev-parse", `refs/remotes/${remote}/${short}`]);
      } catch {
        remoteSha = ZERO_SHA;
      }
    }
    const localSha = git(repoDir, ["rev-parse", local]);
    updates.push({ localRef: local, localSha, remoteRef, remoteSha });
  }
  return updates;
}

/** Dedupe updates that resolve to the same commit range — a multi-branch push
 * often points several refs at the same head. */
export function planRanges(updates: RefUpdate[]): RefUpdate[] {
  const seen = new Set<string>();
  const plan: RefUpdate[] = [];
  for (const u of updates) {
    const key = `${u.remoteSha}..${u.localSha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    plan.push(u);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// scanners
// ---------------------------------------------------------------------------

function missingRun(tool: string): ToolRun {
  return { tool, status: "missing", findings: 0, durationMs: 0 };
}

function failedRun(tool: string, note: string, started: number): ToolRun {
  return { tool, status: "warn", findings: 0, durationMs: Date.now() - started, note };
}

interface GitleaksFinding {
  File?: string;
  Secret?: string;
  RuleID?: string;
  Commit?: string;
}

function runGitleaks(repoDir: string, update: RefUpdate): ToolRun {
  const started = Date.now();
  const bin = which("gitleaks");
  if (!bin) return missingRun("gitleaks");
  const version = toolVersion(bin, "version");
  const reportPath = join(mkdtempSync(join(tmpdir(), "dgit-gl-")), "report.json");
  const range =
    update.remoteSha === ZERO_SHA
      ? update.localSha // new ref — scan everything reachable from it
      : `${update.remoteSha}..${update.localSha}`;
  try {
    // `gitleaks git` (v8.18+) scans rev ranges via --log-opts; older versions
    // use `detect --log-opts`. Try the modern subcommand first.
    try {
      execFileSync(
        bin,
        [
          "git",
          "--log-opts",
          range,
          "--report-format",
          "json",
          "--report-path",
          reportPath,
          repoDir,
        ],
        { encoding: "utf8", timeout: TOOL_TIMEOUT_MS }
      );
    } catch (err) {
      const code = (err as { status?: number }).status;
      if (code !== 1) throw err; // non-finding error (usage, crash) → fallback
    }
    let findings: GitleaksFinding[] = [];
    try {
      findings = JSON.parse(
        execFileSync("cat", [reportPath], { encoding: "utf8" }) || "[]"
      ) as GitleaksFinding[];
    } catch {
      findings = [];
    }
    const real = findings.filter(
      (f) =>
        !(f.File && isFalsePositivePath(f.File)) && !(f.Secret && isAllowlistedSecret(f.Secret))
    );
    return {
      tool: "gitleaks",
      version,
      status: real.length > 0 ? "fail" : "pass",
      findings: real.length,
      durationMs: Date.now() - started,
    };
  } catch {
    // Fallback for gitleaks versions without the `git` subcommand.
    try {
      execFileSync(
        bin,
        [
          "detect",
          "--source",
          repoDir,
          "--log-opts",
          range,
          "--report-format",
          "json",
          "--report-path",
          reportPath,
        ],
        { encoding: "utf8", timeout: TOOL_TIMEOUT_MS }
      );
    } catch (err) {
      if ((err as { status?: number }).status !== 1) {
        return failedRun("gitleaks", String(err).slice(0, 200), started);
      }
    }
    let findings: GitleaksFinding[] = [];
    try {
      findings = JSON.parse(
        execFileSync("cat", [reportPath], { encoding: "utf8" }) || "[]"
      ) as GitleaksFinding[];
    } catch {
      findings = [];
    }
    const real = findings.filter(
      (f) =>
        !(f.File && isFalsePositivePath(f.File)) && !(f.Secret && isAllowlistedSecret(f.Secret))
    );
    return {
      tool: "gitleaks",
      version,
      status: real.length > 0 ? "fail" : "pass",
      findings: real.length,
      durationMs: Date.now() - started,
    };
  }
}

interface TrufflehogFinding {
  SourceMetadata?: { Data?: { Git?: { file?: string; commit?: string } } };
  Raw?: string;
  DetectorName?: string;
  Verified?: boolean;
}

function runTrufflehog(repoDir: string, update: RefUpdate): ToolRun {
  const started = Date.now();
  const bin = which("trufflehog");
  if (!bin) return missingRun("trufflehog");
  const version = toolVersion(bin, "--version");
  const args = ["git", `file://${repoDir}`, "--no-verification", "--json"];
  if (update.remoteSha !== ZERO_SHA) {
    args.push("--since-commit", update.remoteSha, "--branch", update.localSha);
  } else {
    args.push("--branch", update.localSha);
  }
  let out = "";
  try {
    out = execFileSync(bin, args, { encoding: "utf8", timeout: TOOL_TIMEOUT_MS });
  } catch (err) {
    // trufflehog exits non-zero on findings in some versions — keep output.
    out = String((err as { stdout?: string }).stdout ?? "");
    if (!out.trim()) return failedRun("trufflehog", String(err).slice(0, 200), started);
  }
  let real = 0;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let f: TrufflehogFinding;
    try {
      f = JSON.parse(line) as TrufflehogFinding;
    } catch {
      continue;
    }
    const file = f.SourceMetadata?.Data?.Git?.file;
    if (file && isFalsePositivePath(file)) continue;
    if (f.Raw && isAllowlistedSecret(f.Raw)) continue;
    real += 1;
  }
  return {
    tool: "trufflehog",
    version,
    status: real > 0 ? "fail" : "pass",
    findings: real,
    durationMs: Date.now() - started,
  };
}

interface TrivyResult {
  Results?: {
    Secrets?: unknown[];
    Vulnerabilities?: { Severity?: string }[];
    Misconfigurations?: { Severity?: string }[];
  }[];
}

function runTrivy(dir: string): ToolRun {
  const started = Date.now();
  const bin = which("trivy");
  if (!bin) return missingRun("trivy");
  const version = toolVersion(bin, "--version");
  let out = "";
  try {
    out = execFileSync(
      bin,
      [
        "fs",
        "--scanners",
        "secret,vuln,misconfig",
        "--severity",
        "HIGH,CRITICAL",
        "--format",
        "json",
        dir,
      ],
      { encoding: "utf8", timeout: TOOL_TIMEOUT_MS }
    );
  } catch (err) {
    out = String((err as { stdout?: string }).stdout ?? "");
    if (!out.trim()) return failedRun("trivy", String(err).slice(0, 200), started);
  }
  let findings = 0;
  try {
    const report = JSON.parse(out) as TrivyResult;
    for (const r of report.Results ?? []) {
      findings += (r.Secrets ?? []).length;
      findings += (r.Vulnerabilities ?? []).length;
      findings += (r.Misconfigurations ?? []).length;
    }
  } catch {
    return failedRun("trivy", "unparseable report", started);
  }
  return {
    tool: "trivy",
    version,
    status: findings > 0 ? "fail" : "pass",
    findings,
    durationMs: Date.now() - started,
  };
}

interface SemgrepResult {
  results?: { path?: string }[];
}

function runSemgrep(dir: string): ToolRun {
  const started = Date.now();
  const bin = which("semgrep");
  if (!bin) return missingRun("semgrep");
  const version = toolVersion(bin, "--version");
  let out = "";
  try {
    out = execFileSync(bin, ["scan", "--config", "p/owasp-top-ten", "--json", "--quiet", dir], {
      encoding: "utf8",
      timeout: TOOL_TIMEOUT_MS,
    });
  } catch (err) {
    out = String((err as { stdout?: string }).stdout ?? "");
    if (!out.trim()) return failedRun("semgrep", String(err).slice(0, 200), started);
  }
  let findings = 0;
  try {
    const report = JSON.parse(out) as SemgrepResult;
    findings = (report.results ?? []).filter(
      (r) => !(r.path && isFalsePositivePath(r.path))
    ).length;
  } catch {
    return failedRun("semgrep", "unparseable report", started);
  }
  // SAST findings are advisory — warn, never hard-block a push on lint-level
  // signal. `--strict` promotes this to fail.
  return {
    tool: "semgrep",
    version,
    status: findings > 0 ? "warn" : "pass",
    findings,
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

/** Materialize a worktree at `sha` so trivy/semgrep scan exactly the content
 * being uploaded — not whatever the working directory currently contains. */
function checkoutTempWorktree(repoDir: string, sha: string): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "dgit-wt-")).replace(/\/$/, "");
  execFileSync("git", ["-C", repoDir, "worktree", "add", "--detach", dir, sha], {
    stdio: "pipe",
    timeout: 60_000,
  });
  return {
    dir,
    cleanup() {
      try {
        execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", dir], {
          stdio: "pipe",
          timeout: 60_000,
        });
      } catch {
        /* best effort */
      }
    },
  };
}

export interface PushScanOptions {
  /** Include only secret detectors (repo policy `secret_scanning` off). */
  secretsOnly?: boolean;
  /** Promote warn-level findings (semgrep) to fail. */
  strict?: boolean;
  /** Write the JSON audit report under this dir. */
  reportDir?: string;
}

export function runPushScan(
  repoDir: string,
  updates: RefUpdate[],
  opts: PushScanOptions = {}
): ScanResult {
  const started = Date.now();
  const ranges = planRanges(updates);
  const toolRuns: ToolRun[] = [];

  for (const update of ranges) {
    toolRuns.push(runGitleaks(repoDir, update));
    toolRuns.push(runTrufflehog(repoDir, update));
  }

  if (!opts.secretsOnly) {
    // Tree scanners run once per unique pushed head — the tree at that sha is
    // the exact content being uploaded.
    const heads = [...new Set(ranges.map((u) => u.localSha))];
    for (const sha of heads) {
      const wt = checkoutTempWorktree(repoDir, sha);
      try {
        toolRuns.push(runTrivy(wt.dir));
        toolRuns.push(runSemgrep(wt.dir));
      } finally {
        wt.cleanup();
      }
    }
  }

  const anyFail = toolRuns.some((r) => r.status === "fail");
  const anyWarn = toolRuns.some((r) => r.status === "warn");
  const strictFail = opts.strict && anyWarn;
  const status: ScanStatus = anyFail || strictFail ? "fail" : anyWarn ? "warn" : "pass";

  const result: ScanResult = {
    status,
    toolRuns,
    updates,
    durationMs: Date.now() - started,
  };
  result.reportPath = writeReport(repoDir, result, opts.reportDir);
  return result;
}

function writeReport(repoDir: string, result: ScanResult, reportDir?: string): string {
  const dir = reportDir ?? join(homedir(), ".local", "share", "delta-git", "scan-audits");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${basename(repoDir)}-${ts}.scan.json`);
  writeFileSync(path, JSON.stringify(result, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// opt-out + remote detection + attestation
// ---------------------------------------------------------------------------

/** Opt-out precedence: explicit flag > env > `git config dgit.scan false`. */
export function scanDisabled(repoDir: string, flagNoScan?: boolean): string | null {
  if (flagNoScan) return "--no-scan";
  if (process.env.DG_SCAN === "0" || process.env.SECURITY_SKIP === "1") {
    return "env";
  }
  try {
    const v = git(repoDir, ["config", "--get", "dgit.scan"]);
    if (v === "false" || v === "0") return "git-config";
  } catch {
    /* unset */
  }
  return null;
}

/** Is this remote URL a delta-git host? Match against DG_HOST or the
 * canonical workers.dev hostname pattern. */
export function isDeltaGitRemote(url: string, host?: string): boolean {
  const configured = (host ?? process.env.DG_HOST ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*/, "");
  try {
    const u = new URL(url);
    // Compare host:port first (dev hosts like localhost:8787 carry a port),
    // then hostname for bare-domain configs.
    if (configured && (u.host === configured || u.hostname === configured)) return true;
    return u.hostname === "delta-git.workers.dev" || u.hostname.endsWith(".delta-git.workers.dev");
  } catch {
    return configured !== "" && url.includes(configured);
  }
}

/** Parse `https://host/owner/repo(.git)` into the API path pieces. */
export function parseRemoteInfo(url: string): RemoteInfo | null {
  try {
    const u = new URL(url);
    const parts = u.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return null;
    return { host: u.origin, owner: parts[0]!, repo: parts[1]! };
  } catch {
    return null;
  }
}

export async function attestScan(
  info: RemoteInfo,
  authHeaders: Record<string, string>,
  payload: {
    heads: { ref: string; oid: string }[];
    status: ScanStatus;
    tools: Omit<ToolRun, "durationMs"> & { duration_ms?: number }[];
    duration_ms: number;
  }
): Promise<Response> {
  const res = await fetch(`${info.host}/api/${info.owner}/${info.repo}/dg/scan-attest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  return res;
}

/** Console rendering for `dgit push` / the hook shim. */
export function renderScanSummary(result: ScanResult): string {
  const lines = [`[dgit-scan] ${result.status.toUpperCase()} in ${result.durationMs}ms`];
  for (const r of result.toolRuns) {
    const ver = r.version ? ` (${r.version})` : "";
    const note = r.note ? ` — ${r.note}` : "";
    lines.push(
      `[dgit-scan]   ${r.tool}${ver}: ${r.status}${r.findings ? `, ${r.findings} findings` : ""}${note}`
    );
  }
  if (result.reportPath) lines.push(`[dgit-scan] report: ${result.reportPath}`);
  return lines.join("\n");
}
