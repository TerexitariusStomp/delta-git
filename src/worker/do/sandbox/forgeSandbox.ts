// ForgeSandbox — the platform's one container-backed Durable Object.
//
// Every feature that needs real compute runs inside one of these:
//   - CI pipeline executions (the built-in `cloudflare` delegate)
//   - security scans (gitleaks / trivy / osv-scanner)
//   - SBOM generation + provenance attestations (syft)
//   - certificate expiry probes (openssl s_client)
//   - federation mirror pushes (ssh://, tangled knots, Radicle seeds)
//   - dev-environment workspaces (repo checkout, shell, preview)
//
// One class serves both roles — the DO id names the instance and selects
// its own container:
//   `job-{id}` — short-lived unit of work (CI run, scan, mirror push)
//   `ws-{id}`  — longer-lived user workspace (terminal + preview)
//
// Isolation rule: a sandbox id is only ever addressed through helpers in
// `src/worker/compute/sandbox.ts`, which enforce that one space's job can
// never reach another space's sandbox.

import { Sandbox } from "@cloudflare/sandbox";

export class ForgeSandbox extends Sandbox {
  // No overrides — the SDK's `Sandbox` base already implements container
  // lifecycle (start/stop, inactivity sleep, exec, processes, git, port
  // exposure, tunnels). Per-instance behavior is selected at
  // `getSandbox(FORGE_SANDBOX, id, options)` call time.
}
