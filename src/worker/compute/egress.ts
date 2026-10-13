// In-container egress policy. Cloudflare Containers expose no worker-side
// network policy API, so isolation is enforced inside the job sandbox via
// iptables: resolve the allowlist to IPs *before* locking DNS, then
// OUTPUT-chain default-DROP. Requires NET_ADMIN — when the container
// doesn't carry the cap the exec fails and the caller gets
// `enforced:false` to record honestly (fail-open is a documented
// trade-off; user code is already isolated per-job and cannot reach
// other spaces' sandboxes either way).
//
// Per-kind policies live here so the allowlist is reviewed infrastructure,
// not a call-site free-for-all.

export interface EgressPolicyResult {
  enforced: boolean;
  detail: string;
}

/**
 * Domains a job kind may reach. `null` means "open" (workspaces are dev
 * environments — developers need the public internet).
 */
export const JOB_EGRESS_ALLOWLISTS: Record<string, string[]> = {
  // CI needs package registries + VCS hosts. Kept deliberately narrow —
  // a workflow that needs more must declare it (future `network:` spec).
  ci: [
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "proxy.golang.org",
    "sum.golang.org",
    "crates.io",
    "index.crates.io",
    "static.crates.io",
    "github.com",
    "api.github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "github-cloud.s3.amazonaws.com",
  ],
  // Security scanners hit vuln DBs + the platform's own origin (repo tar).
  "security-scan": [
    "api.osv.dev",
    "osv-vulnerabilities.storage.googleapis.com",
    "storage.googleapis.com",
    "github.com",
    "api.github.com",
    "codeload.github.com",
    "services.nvd.nist.gov",
    "cveawg.mitre.org",
    "code.widespread.fyi",
  ],
  // Chaos probes only ever talk back to the platform itself.
  chaos: ["code.widespread.fyi"],
};

/**
 * Apply an egress allowlist to a running sandbox. Domains are resolved to
 * IPs first (DNS must stay up while we resolve), then OUTPUT goes
 * default-deny except loopback, DNS (for runtime lookups), and the
 * allowlisted IPs.
 */
export async function applyEgressPolicy(
  sandbox: { exec(cmd: string, opts?: { timeout?: number }): Promise<{ success: boolean; stdout: string; stderr: string }> },
  allowDomains: string[]
): Promise<EgressPolicyResult> {
  // Resolve every allowlisted domain to A/AAAA records first — after the
  // policy lands, DNS answers still work but nothing else does.
  const resolve = await sandbox.exec(
    `for d in ${allowDomains.map((d) => `'${d}'`).join(" ")}; do getent ahostsv4 "$d"; done | awk '{print $1}' | sort -u`,
    { timeout: 30_000 }
  );
  if (!resolve.success) {
    return { enforced: false, detail: `resolve failed: ${resolve.stderr.slice(0, 120)}` };
  }
  const ips = resolve.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[0-9.]+$/.test(l));

  const rules = [
    // Loopback + already-established flows stay live.
    "iptables -A OUTPUT -o lo -j ACCEPT",
    "iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    // DNS stays open so in-job resolution keeps working.
    "iptables -A OUTPUT -p udp --dport 53 -j ACCEPT",
    "iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT",
    ...ips.map((ip) => `iptables -A OUTPUT -d ${ip} -j ACCEPT`),
    "iptables -A OUTPUT -j DROP",
  ];
  const apply = await sandbox.exec(rules.join(" && "), { timeout: 30_000 });
  if (!apply.success) {
    return {
      enforced: false,
      detail: `iptables unavailable: ${(apply.stderr || apply.stdout).slice(0, 160)}`,
    };
  }
  return { enforced: true, detail: `egress locked to ${ips.length} IPs across ${allowDomains.length} domains` };
}
