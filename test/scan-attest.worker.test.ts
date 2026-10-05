import { describe, it, expect, beforeAll } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";
import { seedPackFirstRepo } from "./util/pack-first";
import { buildStreamingReceiveBody, decodeReportStatus } from "./util/streaming-helpers";
import { uniqueRepoId, postReceivePack } from "./util/test-helpers";

let seeded: SetupRepoForTestsResult;
let owner: string;
let repo: string;
let baseOid: string;

async function req(path: string, opts: { method?: string; body?: unknown; basic?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.basic) headers.Authorization = opts.basic;
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

beforeAll(async () => {
  owner = `scans-${Math.random().toString(36).slice(2, 8)}`;
  repo = uniqueRepoId("scanrepo");
  seeded = await setupRepoForTests(env, owner, repo);
  const packed = await seedPackFirstRepo(`${owner}/${repo}`);
  baseOid = packed.nextCommit.oid;
});

async function buildPush(): Promise<{ body: Uint8Array; commitOid: string }> {
  const built = await buildStreamingReceiveBody({
    parentOid: baseOid,
    nextText: "scanned content\n",
    commitMessage: "scan gate test",
    capabilities: "report-status ofs-delta agent=test",
  });
  return { body: built.body, commitOid: built.commit.oid };
}

describe("push-scan policy + attestation", () => {
  it("reports the default scan policy and accepts attestations", async () => {
    const policy = await req(`/api/${owner}/${repo}/dg/scan-policy`);
    expect(policy.status).toBe(200);
    expect(policy.body).toMatchObject({ push_scan: "report", secret_scanning: true });

    const attest = await req(`/api/${owner}/${repo}/dg/scan-attest`, {
      method: "POST",
      basic: seeded.pushAuthHeader,
      body: {
        heads: [{ ref: "refs/heads/main", oid: baseOid }],
        status: "pass",
        tools: [{ tool: "gitleaks", status: "pass", findings: 0, duration_ms: 1200 }],
        duration_ms: 1200,
      },
    });
    expect(attest.status).toBe(200);
    expect(attest.body).toMatchObject({ recorded: true, policy: "report", heads: 1 });

    const scans = await req(`/api/${owner}/${repo}/dg/scans`);
    expect(scans.status).toBe(200);
    const list = (scans.body as { scans: { head_oid: string; status: string }[] }).scans;
    expect(list.some((s) => s.head_oid === baseOid && s.status === "pass")).toBe(true);
  });

  it("rejects un-attested heads under a block policy, then accepts after attest", async () => {
    // Flip the repo to "block" through the vendored security-settings shape.
    const patch = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${owner}/${repo}/+/settings/security`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: seeded.cookieHeader },
        body: JSON.stringify({ vulnerability_scanning_mode: "block" }),
      }
    );
    expect(patch.status).toBe(200);

    const policy = await req(`/api/${owner}/${repo}/dg/scan-policy`);
    expect(policy.body).toMatchObject({ push_scan: "require" });

    // Push without attestation — the new head is rejected.
    const { body, commitOid } = await buildPush();
    const denied = await postReceivePack(
      `https://example.com/${owner}/${repo}/git-receive-pack`,
      body
    );
    expect(denied.status).toBe(200);
    const deniedLines = decodeReportStatus(new Uint8Array(await denied.arrayBuffer()));
    expect(deniedLines.some((l) => l.startsWith("ng refs/heads/main"))).toBe(true);
    expect(deniedLines.join("\n")).toContain("push scan required");

    // Attest the same head, then the identical push succeeds.
    const attest = await req(`/api/${owner}/${repo}/dg/scan-attest`, {
      method: "POST",
      basic: seeded.pushAuthHeader,
      body: {
        heads: [{ ref: "refs/heads/main", oid: commitOid }],
        status: "pass",
        tools: [
          { tool: "gitleaks", status: "pass", findings: 0 },
          { tool: "trivy", status: "pass", findings: 0 },
        ],
        duration_ms: 5400,
      },
    });
    expect(attest.status).toBe(200);
    expect(attest.body).toMatchObject({ recorded: true, policy: "require" });

    const { body: body2 } = await buildPush();
    const allowed = await postReceivePack(
      `https://example.com/${owner}/${repo}/git-receive-pack`,
      body2
    );
    const allowedLines = decodeReportStatus(new Uint8Array(await allowed.arrayBuffer()));
    expect(allowedLines).toContain("ok refs/heads/main");
    baseOid = commitOid;
  });

  it("records nothing when the policy is off", async () => {
    await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${owner}/${repo}/+/settings/security`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: seeded.cookieHeader },
        body: JSON.stringify({ vulnerability_scanning_mode: "disabled" }),
      }
    );
    const attest = await req(`/api/${owner}/${repo}/dg/scan-attest`, {
      method: "POST",
      basic: seeded.pushAuthHeader,
      body: {
        heads: [{ ref: "refs/heads/main", oid: baseOid }],
        status: "skipped",
        tools: [],
      },
    });
    expect(attest.status).toBe(200);
    expect(attest.body).toMatchObject({ recorded: false, policy: "off" });
  });
});
