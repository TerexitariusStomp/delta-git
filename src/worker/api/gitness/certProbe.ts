// Real certificate-expiry probing. Workers cannot inspect the TLS peer
// certificate of an outbound fetch, so the authoritative source for
// publicly-trusted expiry is the Certificate Transparency logs: every
// CA-signed cert for a public domain is logged there with `not_after`.
// crt.sh serves the aggregated CT corpus as JSON. Operator-asserted
// `expiresAt` values are refreshed from the log so expiry notifications
// track reality, not bookkeeping.

const CRT_SH = "https://crt.sh";
const PROBE_TIMEOUT_MS = 10_000;

export interface CertProbeResult {
  ok: boolean;
  /** Furthest `not_after` observed for an exactly-matching name. */
  expiresAt?: number;
  issuer?: string;
  /** Diagnostic when `ok` is false — never a thrown error. */
  error?: string;
}

interface CrtShEntry {
  common_name?: string;
  name_value?: string;
  issuer_name?: string;
  not_after?: string;
}

function namesMatch(entry: CrtShEntry, domain: string): boolean {
  const names = [entry.common_name ?? "", ...(entry.name_value ?? "").split("\n")];
  return names.some((name) => {
    const n = name.trim().toLowerCase();
    // Wildcard SAN entries cover the domain one label down.
    return n === domain || n === `*.${domain.split(".").slice(1).join(".")}` || (n.startsWith("*.") && domain.endsWith(n.slice(1)));
  });
}

/** Parse an X.509-ish timestamp like `2026-09-11T23:59:59` — UTC. */
function parseNotAfter(value: string): number | undefined {
  const t = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
  return Number.isFinite(t) ? t : undefined;
}

export async function probeCertificateExpiry(domain: string): Promise<CertProbeResult> {
  const res = await fetch(`${CRT_SH}/?q=${encodeURIComponent(domain)}&output=json`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  }).catch(() => null);
  if (!res) return { ok: false, error: "ct-log-unreachable" };
  if (!res.ok) return { ok: false, error: `ct-log-http-${res.status}` };
  const entries = (await res.json().catch(() => null)) as CrtShEntry[] | null;
  if (!Array.isArray(entries)) return { ok: false, error: "ct-log-bad-payload" };

  const d = domain.toLowerCase();
  let best: number | undefined;
  let issuer: string | undefined;
  for (const entry of entries) {
    if (!entry.not_after || !namesMatch(entry, d)) continue;
    const expiry = parseNotAfter(entry.not_after);
    if (expiry === undefined) continue;
    if (best === undefined || expiry > best) {
      best = expiry;
      // `issuer_name` arrives as an X.500 DN; the O= segment is the CA name.
      const o = entry.issuer_name?.match(/O=([^,]+)/);
      issuer = o?.[1] ?? entry.issuer_name ?? undefined;
    }
  }
  if (best === undefined) return { ok: false, error: "ct-log-no-entries" };
  return { ok: true, expiresAt: best, issuer };
}
