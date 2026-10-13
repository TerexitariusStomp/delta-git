// Platform security scans + supply-chain document builds.
//
// `POST /security-tests` records a queued test and enqueues a
// `security-scan` message when the target is a repo on this forge — the
// sandbox image's pinned tools (gitleaks / trivy / osv-scanner) run
// against a staged worktree and the row is updated with REAL findings.
// Non-repo targets stay `queued` for client-side delegates (the /result
// route remains their write path).
//
// `POST /supply-chain` without a document enqueues `supply-chain-build`:
// `sbom` runs syft on the staged worktree; `provenance` / `attestation`
// produce an in-toto SLSA statement wrapped in a DSSE envelope signed by
// the node's Ed25519 key.

import { createLogger } from "@/worker/common/logger";
import { getRepoStub } from "@/worker/common";
import { createDb } from "@/worker/db/d1/client";
import {
  findSecurityTest,
  updateSecurityTest,
  findSupplyChainDoc,
  updateSupplyChainDoc,
} from "@/worker/db/d1/dal/modules";
import { findRepositoryById } from "@/worker/db/d1/dal/repositories";
import { jobSandbox } from "@/worker/compute/sandbox";
import { applyEgressPolicy, JOB_EGRESS_ALLOWLISTS } from "@/worker/compute/egress";
import { openRepoTar } from "@/worker/routes/archive";
import { loadNodeKey } from "@/worker/agent/repCert";
import type {
  RepoQueueMessageHandle,
  SecurityScanQueueMessage,
  SupplyChainBuildQueueMessage,
} from "./types";

const log = createLogger(undefined, { service: "SecurityScan" });

/** Report payloads are capped — summaries, never raw tool dumps. */
const MAX_REPORT_BYTES = 256 * 1024;

const SCAN_TIMEOUT_MS = 8 * 60 * 1000;

// ---------------------------------------------------------------------------
// worktree staging — same tar flow as the CI runner, but we keep the Sandbox
// handle so reports can be read back out of the container.
// ---------------------------------------------------------------------------

async function stageWorktree(args: { env: Env; doName: string; commitOid: string; jobId: string }) {
  const { env, doName, commitOid, jobId } = args;
  const sandbox = jobSandbox(env, doName, "scan", jobId, {
    containerTimeouts: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 120_000 },
  });
  // Lock egress to the vuln-DB/GitHub allowlist before the repo contents
  // are staged — scanned code is untrusted input.
  const egress = await applyEgressPolicy(sandbox, JOB_EGRESS_ALLOWLISTS["security-scan"]);
  if (!egress.enforced) {
    log.warn("scan:egress-not-enforced", { jobId, detail: egress.detail });
  }
  const tar = await openRepoTar({
    env,
    doName,
    commitOid,
    cacheCtx: undefined,
    log,
  });
  if (!tar) return { ok: false as const, detail: "worktree too large or unreadable" };
  const write = await sandbox.writeFile("/workspace/repo.tar", tar.readable);
  if (!write.success) return { ok: false as const, detail: "worktree upload failed" };
  const unpack = await sandbox.exec(
    "mkdir -p /workspace/repo && tar -xf /workspace/repo.tar -C /workspace/repo && rm -f /workspace/repo.tar",
    { timeout: 120_000 }
  );
  await tar.done.catch(() => undefined);
  if (!unpack.success) {
    return { ok: false as const, detail: `extract failed (exit ${unpack.exitCode})` };
  }
  return { ok: true as const, sandbox };
}

async function headCommit(env: Env, doName: string): Promise<string | undefined> {
  const stub = getRepoStub(env, doName);
  const { refs, head } = await stub.getHeadAndRefs();
  return (
    (head.target ? refs.find((r) => r.name === head.target)?.oid : undefined) ??
    refs.find((r) => r.name === "refs/heads/main")?.oid ??
    refs[0]?.oid
  );
}

// ---------------------------------------------------------------------------
// tool table — each entry returns the shell command plus a summarizer that
// turns the tool's JSON report into {findings, items}. Summaries NEVER carry
// secret values: gitleaks reports include the matched secret and we strip it.
// ---------------------------------------------------------------------------

interface ScanSummary {
  findings: number;
  items: unknown[];
}

interface ScanTool {
  tool: string;
  /** Shell inside /workspace/repo; must write JSON to /out/report.json. */
  command: string;
  summarize: (report: unknown) => ScanSummary;
}

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(secret|match|line|author_email|commit)$/i.test(k)) continue;
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

const SCAN_TOOLS: Record<string, ScanTool> = {
  secrets: {
    tool: "gitleaks",
    command:
      "mkdir -p /out && gitleaks dir --no-git --report-format json --report-path /out/report.json .",
    summarize: (report) => {
      const items = Array.isArray(report) ? report : [];
      return {
        findings: items.length,
        items: items.slice(0, 200).map(stripSecrets),
      };
    },
  },
  sast: {
    tool: "trivy",
    command:
      "mkdir -p /out && trivy fs --scanners vuln,secret,misconfig --format json --output /out/report.json .",
    summarize: summarizeTrivy,
  },
  vuln: {
    tool: "trivy",
    command:
      "mkdir -p /out && trivy fs --scanners vuln,secret,misconfig --format json --output /out/report.json .",
    summarize: summarizeTrivy,
  },
  dast: {
    tool: "trivy",
    command:
      "mkdir -p /out && trivy fs --scanners vuln,secret,misconfig --format json --output /out/report.json .",
    summarize: summarizeTrivy,
  },
  deps: {
    tool: "osv-scanner",
    command: "mkdir -p /out && osv-scanner scan --format json --output /out/report.json .",
    summarize: (report) => {
      const results = (report as { results?: { packages?: { vulnerabilities?: unknown[] }[] }[] })
        ?.results;
      const items: unknown[] = [];
      let findings = 0;
      for (const r of results ?? []) {
        for (const pkg of r.packages ?? []) {
          findings += pkg.vulnerabilities?.length ?? 0;
          if (items.length < 200) items.push(stripSecrets(pkg));
        }
      }
      return { findings, items };
    },
  },
};
// Aliases → canonical kinds.
SCAN_TOOLS.secret = SCAN_TOOLS.secrets;
SCAN_TOOLS.gitleaks = SCAN_TOOLS.secrets;
SCAN_TOOLS.trivy = SCAN_TOOLS.sast;
SCAN_TOOLS.osv = SCAN_TOOLS.deps;
SCAN_TOOLS.sca = SCAN_TOOLS.deps;

interface TrivyResult {
  Target?: string;
  Vulnerabilities?: {
    VulnerabilityID?: string;
    PkgName?: string;
    Severity?: string;
    Title?: string;
  }[];
  Misconfigurations?: { ID?: string; Title?: string; Severity?: string }[];
  Secrets?: { RuleID?: string; Target?: string; Severity?: string }[];
}

function summarizeTrivy(report: unknown): ScanSummary {
  const results = (report as { Results?: TrivyResult[] })?.Results ?? [];
  const items: unknown[] = [];
  let findings = 0;
  for (const r of results) {
    findings +=
      (r.Vulnerabilities?.length ?? 0) +
      (r.Misconfigurations?.length ?? 0) +
      (r.Secrets?.length ?? 0);
    if (items.length < 200) {
      for (const v of r.Vulnerabilities ?? []) {
        items.push({
          kind: "vuln",
          id: v.VulnerabilityID,
          pkg: v.PkgName,
          severity: v.Severity,
          title: v.Title,
        });
      }
      for (const m of r.Misconfigurations ?? []) {
        items.push({ kind: "misconfig", id: m.ID, severity: m.Severity, title: m.Title });
      }
      for (const s of r.Secrets ?? []) {
        items.push({ kind: "secret", id: s.RuleID, severity: s.Severity });
      }
    }
  }
  return { findings, items };
}

// ---------------------------------------------------------------------------
// security-scan handler
// ---------------------------------------------------------------------------

export async function handleSecurityScanMessage(
  message: Omit<RepoQueueMessageHandle<SecurityScanQueueMessage>, "body">,
  body: SecurityScanQueueMessage,
  env: Env
): Promise<void> {
  const db = createDb(env.DB);
  const row = await findSecurityTest(db, body.testId);
  if (!row || row.status === "pass" || row.status === "fail") {
    message.ack();
    return;
  }
  const finish = async (status: string, findings: number, report: unknown) => {
    await updateSecurityTest(db, row.id, {
      status,
      findings,
      report: JSON.stringify(report).slice(0, MAX_REPORT_BYTES),
      finishedAt: Date.now(),
    });
    message.ack();
  };

  const tool = SCAN_TOOLS[row.kind] ?? SCAN_TOOLS[row.kind.toLowerCase()];
  if (!tool) {
    await finish("fail", 0, { error: `unsupported scan kind: ${row.kind}` });
    return;
  }
  if (!row.repositoryId) {
    // External targets are client-delegate work — leave queued.
    message.ack();
    return;
  }
  const repo = await findRepositoryById(db, row.repositoryId);
  if (!repo) {
    await finish("fail", 0, { error: "repository not found" });
    return;
  }
  await updateSecurityTest(db, row.id, { status: "running" });
  try {
    const commitOid = await headCommit(env, repo.doName);
    if (!commitOid) {
      await finish("fail", 0, { error: "repository has no commits" });
      return;
    }
    const staged = await stageWorktree({ env, doName: repo.doName, commitOid, jobId: row.id });
    if (!staged.ok) {
      await finish("fail", 0, { error: staged.detail });
      return;
    }
    const run = await staged.sandbox.exec(`cd /workspace/repo && ${tool.command}`, {
      timeout: SCAN_TIMEOUT_MS,
    });
    // Scanners exit non-zero when they FIND issues — a missing report file
    // is the only real failure.
    const reportRead = await staged.sandbox.exec("cat /out/report.json", { timeout: 30_000 });
    if (!reportRead.success || !reportRead.stdout.trim()) {
      await finish("fail", 0, {
        error: `${tool.tool} produced no report (exit ${run.exitCode})`,
        stderr: run.stderr?.slice(0, 2000),
      });
      return;
    }
    let report: unknown;
    try {
      report = JSON.parse(reportRead.stdout);
    } catch {
      await finish("fail", 0, { error: `${tool.tool} report was not valid JSON` });
      return;
    }
    const summary = tool.summarize(report);
    await finish(summary.findings > 0 ? "fail" : "pass", summary.findings, {
      tool: tool.tool,
      commit: commitOid,
      items: summary.items,
    });
  } catch (error) {
    log.warn("scan:failed", { testId: row.id, error: String(error) });
    await finish("fail", 0, { error: `scan failed: ${String(error).slice(0, 500)}` });
  }
}

// ---------------------------------------------------------------------------
// supply-chain-build handler — syft SBOMs + DSSE-signed in-toto provenance.
// ---------------------------------------------------------------------------

const te = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** DSSE PAE: DSSEv1 SP len(type) SP type SP len(payload) SP payload. */
function dssePae(payloadType: string, payload: Uint8Array): Uint8Array {
  const parts = [
    te.encode("DSSEv1"),
    te.encode(` ${payloadType.length} `),
    te.encode(payloadType),
    te.encode(` ${payload.length} `),
    payload,
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function dsseSign(
  env: Env,
  statement: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const node = await loadNodeKey(env);
  if (!node) return null;
  const payloadType = "application/vnd.in-toto+json";
  const payload = te.encode(JSON.stringify(statement));
  const sig = await crypto.subtle.sign(
    "Ed25519",
    node.privateKey,
    dssePae(payloadType, payload) as BufferSource
  );
  return {
    payloadType,
    payload: b64url(payload),
    signatures: [{ keyid: node.did, sig: b64url(new Uint8Array(sig)) }],
  };
}

export async function handleSupplyChainBuildMessage(
  message: Omit<RepoQueueMessageHandle<SupplyChainBuildQueueMessage>, "body">,
  body: SupplyChainBuildQueueMessage,
  env: Env
): Promise<void> {
  const db = createDb(env.DB);
  const row = await findSupplyChainDoc(db, body.docId);
  if (!row) {
    message.ack();
    return;
  }
  const fail = async (error: string) => {
    await updateSupplyChainDoc(db, row.id, {
      document: JSON.stringify({ status: "error", error }),
    });
    message.ack();
  };
  const done = async (document: Record<string, unknown>, commitOid: string) => {
    const json = JSON.stringify(document);
    if (json.length > MAX_REPORT_BYTES * 4) {
      await fail(`document too large (${json.length} bytes)`);
      return;
    }
    await updateSupplyChainDoc(db, row.id, { document: json, commitOid });
    message.ack();
  };

  const repo = await findRepositoryById(db, row.repositoryId);
  if (!repo) {
    await fail("repository not found");
    return;
  }
  try {
    const commitOid = row.commitOid ?? (await headCommit(env, repo.doName));
    if (!commitOid) {
      await fail("repository has no commits");
      return;
    }
    const staged = await stageWorktree({ env, doName: repo.doName, commitOid, jobId: row.id });
    if (!staged.ok) {
      await fail(staged.detail ?? "staging failed");
      return;
    }

    if (row.kind === "sbom") {
      const gen = await staged.sandbox.exec(
        "cd /workspace/repo && syft dir:. -o spdx-json=/out/sbom.json 2>/dev/null || syft dir:. -o spdx-json > /out/sbom.json",
        { timeout: SCAN_TIMEOUT_MS }
      );
      if (!gen.success) {
        await fail(`syft failed (exit ${gen.exitCode}): ${gen.stderr?.slice(0, 500)}`);
        return;
      }
      const read = await staged.sandbox.exec("cat /out/sbom.json", { timeout: 60_000 });
      if (!read.success || !read.stdout.trim()) {
        await fail("syft produced no document");
        return;
      }
      const parsed = JSON.parse(read.stdout) as Record<string, unknown>;
      parsed["x-delta-git"] = { repo: repo.doName, commit: commitOid, generatedAt: Date.now() };
      await done(parsed, commitOid);
      return;
    }

    // provenance | attestation → in-toto statement + DSSE envelope.
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: `repo:${repo.doName}`, digest: { sha1: commitOid } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        buildDefinition: {
          buildType: "https://delta-git.dev/build/supply-chain",
          externalParameters: { repo: repo.doName, commit: commitOid },
          resolvedDependencies: [],
        },
        runDetails: {
          builder: { id: "delta-git platform" },
          metadata: {
            invocationId: row.id,
            startedOn: new Date(row.createdAt).toISOString(),
            finishedOn: new Date().toISOString(),
          },
        },
      },
    };
    const envelope = await dsseSign(env, statement);
    if (!envelope) {
      await fail("node signing key unconfigured");
      return;
    }
    await done(envelope, commitOid);
  } catch (error) {
    log.warn("supply-chain:build-failed", { docId: row.id, error: String(error) });
    await fail(`build failed: ${String(error).slice(0, 500)}`);
  }
}
