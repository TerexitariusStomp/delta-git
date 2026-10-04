// Push protection: scan server-constructed or pushed content for live secret
// patterns. Same class of feature GitHub sells as "push protection" — here
// it flags the commit in the op log and lets callers reject.

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github-pat", re: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: "github-oauth", re: /\bgho_[A-Za-z0-9]{36,}\b/ },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "gcp-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: "generic-secret-assign",
    re: /(?:secret|token|api[_-]?key|password)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{24,}["']/i,
  },
];

export type SecretFinding = { name: string; path?: string };

/** Scan a text payload; returns findings or empty. */
export function scanTextForSecrets(text: string, path?: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) findings.push({ name, path });
  }
  return findings;
}

/** Scan every file entry in a patch-like {path: text} map. */
export function scanForSecrets(
  files: Map<string, string> | Record<string, string>
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const entries = files instanceof Map ? files.entries() : Object.entries(files);
  for (const [path, text] of entries) {
    findings.push(...scanTextForSecrets(text, path));
  }
  return findings;
}
