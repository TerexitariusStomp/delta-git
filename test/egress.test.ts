// Node unit coverage for compute/egress.ts — the policy is iptables
// strings + ordering; a fake exec surface is enough to verify behavior
// without a real container.

import { describe, expect, it } from "vitest";
import { applyEgressPolicy } from "../src/worker/compute/egress";

interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

function fakeSandbox(handler: (cmd: string) => ExecResult) {
  const calls: string[] = [];
  return {
    calls,
    async exec(cmd: string): Promise<ExecResult> {
      calls.push(cmd);
      return handler(cmd);
    },
  };
}

describe("applyEgressPolicy", () => {
  it("resolves domains before locking and emits default-DROP rules", async () => {
    const sb = fakeSandbox((cmd) =>
      cmd.startsWith("for d in")
        ? { success: true, stdout: "1.2.3.4\n2.3.4.5\n1.2.3.4\n", stderr: "" }
        : { success: true, stdout: "", stderr: "" }
    );
    const r = await applyEgressPolicy(sb, ["registry.npmjs.org", "github.com"]);
    expect(r.enforced).toBe(true);

    // Resolution happens first (DNS must be up while we resolve).
    expect(sb.calls[0]).toContain("getent ahostsv4");
    expect(sb.calls[0]).toContain("registry.npmjs.org");

    const rules = sb.calls[1];
    // Loopback + established + DNS survive; allowlisted IPs pass; DROP last.
    expect(rules).toContain("-o lo -j ACCEPT");
    expect(rules).toContain("--dport 53 -j ACCEPT");
    expect(rules).toContain("-d 1.2.3.4 -j ACCEPT");
    expect(rules).toContain("-d 2.3.4.5 -j ACCEPT");
    expect(rules).toContain("-j DROP");
    // DROP is the last rule appended.
    expect(rules.trim().endsWith("-j DROP")).toBe(true);
  });

  it("fails open with an honest detail when resolution breaks", async () => {
    const sb = fakeSandbox(() => ({ success: false, stdout: "", stderr: "no getent" }));
    const r = await applyEgressPolicy(sb, ["x.example"]);
    expect(r.enforced).toBe(false);
    expect(r.detail).toContain("resolve failed");
  });

  it("fails open with an honest detail when iptables is unavailable", async () => {
    const sb = fakeSandbox((cmd) =>
      cmd.startsWith("for d in")
        ? { success: true, stdout: "9.9.9.9\n", stderr: "" }
        : { success: false, stdout: "", stderr: "Permission denied" }
    );
    const r = await applyEgressPolicy(sb, ["x.example"]);
    expect(r.enforced).toBe(false);
    expect(r.detail).toContain("iptables unavailable");
    expect(r.detail).toContain("Permission denied");
  });

  it("ignores non-IP resolver output (CNAME lines, blank)", async () => {
    const sb = fakeSandbox((cmd) =>
      cmd.startsWith("for d in")
        ? { success: true, stdout: "cdn.example.com\n\n10.0.0.1\n", stderr: "" }
        : { success: true, stdout: "", stderr: "" }
    );
    const r = await applyEgressPolicy(sb, ["cdn.example.com"]);
    expect(r.enforced).toBe(true);
    const rules = sb.calls[1];
    expect(rules).toContain("-d 10.0.0.1 -j ACCEPT");
    expect(rules).not.toContain("-d cdn.example.com");
  });
});
