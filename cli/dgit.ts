#!/usr/bin/env -S npx tsx
// dgit — the delta-git client CLI.
//
//   dgit push [remote] [refspec...]      client-side scan → attest → git push
//   dgit scan [--hook]                   run the push scanner standalone
//   dgit hooks install|uninstall         gate plain `git push` via pre-push
//   dgit intents <owner>/<repo>          list merge intents
//   dgit run <owner>/<repo> <intent>     attempt a merge
//   dgit dryrun <owner>/<repo> <oid>     predict conflicts
//   dgit secrets set <owner>/<repo> NAME  write a repo secret (stdin value)
//   dgit watch <dir>                     auto-commit + push on file changes
//
// Auth: DG_PAT env var (Basic PAT) or --did/--key for agent signatures.
// Server: DG_HOST env or --host (default https://delta-git.workers.dev).
//
// Push scanning: whatever is uploaded is scanned on this machine (gitleaks,
// trufflehog, trivy, semgrep) before the pack leaves. On by default; opt out
// per push with --no-scan or `git config dgit.scan false`, globally DG_SCAN=0.

import { Command } from "commander";
import { watch } from "chokidar";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  attestScan,
  dryRunUpdates,
  isDeltaGitRemote,
  parsePrePushStdin,
  parseRemoteInfo,
  renderScanSummary,
  runPushScan,
  scanDisabled,
} from "./scan";

const program = new Command();

function host(): string {
  return (program.opts().host ?? process.env.DG_HOST ?? "http://localhost:8787").replace(/\/$/, "");
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.DG_PAT) {
    const user = process.env.DG_USER ?? "agent";
    h.Authorization = `Basic ${Buffer.from(`${user}:${process.env.DG_PAT}`).toString("base64")}`;
  }
  return h;
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${host()}${path}`, {
    ...init,
    headers: { ...headers(), ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`error ${res.status}:`, body);
    process.exit(1);
  }
  return body;
}

program.name("dgit").description("delta-git client").option("--host <url>", "delta-git host");

program.command("intents <repo>").action(async (repo: string) => {
  const [owner, name] = repo.split("/");
  const data = (await api(`/api/${owner}/${name}/dg/intents`)) as { intents: unknown[] };
  console.log(JSON.stringify(data.intents, null, 2));
});

program.command("run <repo> <intent>").action(async (repo: string, intent: string) => {
  const [owner, name] = repo.split("/");
  const res = await api(`/api/${owner}/${name}/dg/intents/${intent}/run`, {
    method: "POST",
    body: "{}",
  });
  console.log(JSON.stringify(res, null, 2));
});

program
  .command("dryrun <repo> <oid>")
  .option("--ref <ref>", "target ref", "main")
  .action(async (repo: string, oid: string, opts: { ref: string }) => {
    const [owner, name] = repo.split("/");
    const res = await api(`/api/${owner}/${name}/dg/merge/dryrun`, {
      method: "POST",
      body: JSON.stringify({ ref: opts.ref, delta_oid: oid }),
    });
    console.log(JSON.stringify(res, null, 2));
  });

program
  .command("secrets")
  .command("set <repo> <name>")
  .action(async (repo: string, name: string) => {
    const [owner, repoName] = repo.split("/");
    const value = execFileSync("cat", [], { input: process.stdin.fd as never })
      .toString()
      .trim();
    const res = await api(`/api/${owner}/${repoName}/dg/secrets/${name}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    console.log(JSON.stringify(res));
  });

program
  .command("watch <dir>")
  .description("auto-commit + push on file changes (GH-Desktop-style sync)")
  .option("--debounce <ms>", "debounce window", "2000")
  .action(async (dir: string, opts: { debounce: string }) => {
    const debounceMs = Number(opts.debounce);
    let timer: NodeJS.Timeout | undefined;
    const commit = () => {
      try {
        execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "inherit" });
        execFileSync(
          "git",
          ["-C", dir, "commit", "-m", "dgit watch sync", "--allow-empty-message"],
          {
            stdio: "inherit",
          }
        );
        execFileSync("git", ["-C", dir, "push"], { stdio: "inherit" });
      } catch (error) {
        console.error("watch push failed:", String(error));
      }
    };
    watch(dir, { ignoreInitial: true, ignored: /(^|[/\\])\.git([/\\]|$)/ }).on("all", () => {
      clearTimeout(timer);
      timer = setTimeout(commit, debounceMs);
    });
    console.log(`watching ${dir} — edits auto-commit + push`);
  });

program
  .command("events <repo>")
  .description("tail the repo firehose")
  .action(async (repo: string) => {
    const [owner, name] = repo.split("/");
    const res = await fetch(`${host()}/api/${owner}/${name}/dg/events`, {
      headers: headers(),
    });
    if (!res.body) {
      console.error("no stream");
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      process.stdout.write(decoder.decode(value));
    }
  });

// --- push scanning ------------------------------------------------------------

function repoDir(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function defaultRemote(dir: string): string {
  try {
    const upstream = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { encoding: "utf8" }
    ).trim();
    return upstream.split("/")[0] || "origin";
  } catch {
    return "origin";
  }
}

function remoteUrl(dir: string, remote: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", remote], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

/** Attest the scan outcome for the heads about to be pushed — must run before
 * `git push` so a `require` policy finds the rows. Best-effort: a failed
 * attestation warns rather than aborting (a `require` push fails anyway). */
async function attest(
  url: string,
  updates: { remoteRef: string; localSha: string }[],
  status: string,
  toolRuns: {
    tool: string;
    version?: string;
    status: string;
    findings: number;
    durationMs: number;
  }[],
  durationMs: number
): Promise<void> {
  const info = parseRemoteInfo(url);
  if (!info || !process.env.DG_PAT) return;
  const res = await attestScan(
    info,
    { user: process.env.DG_USER ?? "agent", token: process.env.DG_PAT },
    {
      heads: updates.map((u) => ({ ref: u.remoteRef, oid: u.localSha })),
      status: status as "pass" | "warn" | "fail" | "skipped",
      tools: toolRuns.map((r) => ({
        tool: r.tool,
        version: r.version,
        status: r.status as "pass" | "warn" | "fail" | "skipped" | "missing",
        findings: r.findings,
        duration_ms: r.durationMs,
      })),
      duration_ms: durationMs,
    }
  ).catch((err: unknown) => {
    console.error(`[dgit-scan] attestation failed: ${String(err)}`);
    return null;
  });
  if (res && !res.ok) {
    console.error(`[dgit-scan] attestation rejected: ${res.status}`);
  }
}

program
  .command("push [remote] [refspec...]")
  .description("client-side scan → attest → git push")
  .option("--no-scan", "skip the client-side security scan")
  .option("--strict", "promote warn-level findings to blocking")
  .option("--secrets-only", "run only secret detectors")
  .allowUnknownOption()
  .action(async (remote: string | undefined, refspecs: string[], opts) => {
    const dir = repoDir();
    const remoteName = remote ?? defaultRemote(dir);
    const url = remoteUrl(dir, remoteName);
    const args = ["push", remoteName, ...refspecs];

    const disabledReason = scanDisabled(dir, !opts.scan);
    let updates: ReturnType<typeof dryRunUpdates> = [];
    if (!disabledReason) {
      try {
        updates = dryRunUpdates(dir, remoteName, refspecs);
      } catch {
        console.error("[dgit-scan] could not compute push ranges — scanning skipped");
      }
    }
    if (disabledReason) {
      console.error(`[dgit-scan] disabled via ${disabledReason}`);
    } else if (updates.length === 0) {
      console.error("[dgit-scan] nothing new to upload — skipping scan");
    } else {
      const result = runPushScan(dir, updates, {
        strict: !!opts.strict,
        secretsOnly: !!opts.secretsOnly,
      });
      console.error(renderScanSummary(result));
      if (result.status === "fail") {
        console.error("[dgit-scan] blocking findings — push aborted. Override with --no-scan.");
        process.exit(1);
      }
      if (url && isDeltaGitRemote(url)) {
        await attest(url, updates, result.status, result.toolRuns, result.durationMs);
      }
    }

    try {
      execFileSync("git", ["-C", dir, ...args], { stdio: "inherit" });
    } catch (err) {
      process.exit((err as { status?: number }).status ?? 1);
    }
  });

program
  .command("scan")
  .description("run the push scanner standalone (or as the pre-push hook)")
  .option("--hook", "read ref updates from stdin like a pre-push hook")
  .option("--remote-name <name>", "hook arg: remote name")
  .option("--remote-url <url>", "hook arg: remote url")
  .option("--remote <name>", "remote to dry-run against", "origin")
  .option("--strict", "promote warn-level findings to blocking")
  .option("--all-remotes", "scan even when the remote is not delta-git")
  .option("--json", "print the JSON result")
  .action(async (opts) => {
    const dir = repoDir();
    let updates;
    if (opts.hook) {
      // Only gate pushes headed for delta-git remotes — the hook fires for
      // every remote, and scanning e.g. a github push would surprise.
      if (
        opts.remoteUrl &&
        !opts.allRemotes &&
        !isDeltaGitRemote(opts.remoteUrl) &&
        process.env.DG_SCAN_ALL !== "1"
      ) {
        return;
      }
      const stdin = await readFile(0, "utf8");
      updates = parsePrePushStdin(stdin);
    } else {
      updates = dryRunUpdates(dir, opts.remote as string, []);
    }
    if (updates.length === 0) {
      if (opts.hook) return;
      console.error("[dgit-scan] nothing new to upload");
      return;
    }
    const result = runPushScan(dir, updates, { strict: !!opts.strict });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(renderScanSummary(result));
    }
    // Hook mode attests too — keeps `require` pushes working under plain git.
    if (opts.hook && opts.remoteUrl && isDeltaGitRemote(opts.remoteUrl)) {
      await attest(
        opts.remoteUrl,
        result.updates,
        result.status,
        result.toolRuns,
        result.durationMs
      );
    }
    if (result.status === "fail") process.exit(1);
  });

const HOOK_SHIM = `#!/usr/bin/env bash
# dgit pre-push gate — installed by \`dgit hooks install\`.
# Scans pushes headed for delta-git remotes with the local toolchain before
# they leave the machine. Opt out per push: git push --no-verify · DG_SCAN=0.
set -u
DGIT_BIN="$(command -v dgit || true)"
stdin_tmp="$(mktemp)"
trap 'rm -f "$stdin_tmp"' EXIT
cat > "$stdin_tmp"
if [ -n "$DGIT_BIN" ]; then
  "$DGIT_BIN" scan --hook --remote-name "$1" --remote-url "$2" < "$stdin_tmp"
elif command -v npx >/dev/null 2>&1; then
  npx --yes tsx "__DGIT_PATH__" scan --hook --remote-name "$1" --remote-url "$2" < "$stdin_tmp"
else
  echo "[dgit-scan] WARNING: dgit not found — push unscanned" >&2
fi
rc=$?
[ $rc -ne 0 ] && exit $rc
if [ -x "__CHAIN__" ]; then
  "__CHAIN__" "$@" < "$stdin_tmp"
  exit $?
fi
exit 0
`;

function writeHook(hooksDir: string, chainPath: string | null, global_ = false): void {
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-push");
  const dgitPath = join(dirname(new URL(import.meta.url).pathname), "dgit.ts");
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (!existing.includes("dgit pre-push gate")) {
      const backup = join(hooksDir, "pre-push.dgit-orig");
      renameSync(hookPath, backup);
      chmodSync(backup, 0o755);
      // Re-render with the backup as the chained hook.
      writeFileSync(
        hookPath,
        HOOK_SHIM.replace("__DGIT_PATH__", dgitPath).replace("__CHAIN__", backup),
        { mode: 0o755 }
      );
      console.log(`existing pre-push moved to ${backup} (chained)`);
      return;
    }
  }
  // Re-install over our own shim keeps chaining a prior backup if one exists.
  const backup = join(hooksDir, "pre-push.dgit-orig");
  const effectiveChain = chainPath ?? (existsSync(backup) ? backup : "");
  writeFileSync(
    hookPath,
    HOOK_SHIM.replace("__DGIT_PATH__", dgitPath).replace("__CHAIN__", effectiveChain),
    { mode: 0o755 }
  );
  console.log(`pre-push gate installed at ${hookPath}${global_ ? " (global)" : ""}`);
}

const hooks = program.command("hooks").description("manage the pre-push scan gate");
hooks
  .command("install")
  .option("--global", "install into ~/.dgit/hooks and set core.hooksPath")
  .action((opts: { global?: boolean }) => {
    if (opts.global) {
      // core.hooksPath holds exactly one dir — if the user already has a
      // global hooks dir (e.g. a gitleaks gate), install INTO it and chain
      // rather than replacing the path and orphaning their other hooks.
      let hooksDir = join(homedir(), ".dgit", "hooks");
      let chain: string | null = null;
      let existingPath = "";
      try {
        existingPath = execFileSync("git", ["config", "--global", "--get", "core.hooksPath"], {
          encoding: "utf8",
        }).trim();
      } catch {
        /* unset */
      }
      if (existingPath) {
        hooksDir = existingPath.replace(/^~/, homedir());
      } else {
        execFileSync("git", ["config", "--global", "core.hooksPath", hooksDir]);
        console.log(`core.hooksPath set to ${hooksDir}`);
      }
      writeHook(hooksDir, chain, true);
      return;
    }
    const dir = repoDir();
    writeHook(join(dir, ".git", "hooks"), null);
  });
hooks.command("uninstall").action(() => {
  const dir = repoDir();
  const hookPath = join(dir, ".git", "hooks", "pre-push");
  if (existsSync(hookPath) && readFileSync(hookPath, "utf8").includes("dgit pre-push gate")) {
    const backup = join(dir, ".git", "hooks", "pre-push.dgit-orig");
    if (existsSync(backup)) renameSync(backup, hookPath);
    else execFileSync("rm", [hookPath]);
    console.log("pre-push gate removed");
    return;
  }
  console.log("no dgit pre-push gate found");
});

program.parse();
