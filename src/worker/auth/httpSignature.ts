import { pubkeyFromDidKey } from "@/worker/agent/atpauth/didkey";
import { getAgent } from "@/worker/agent/auth";
import type { AgentRow } from "@/worker/db/d1/schema/agents";
import type { Db } from "@/worker/db/d1/client";

// RFC 9421 HTTP Message Signatures — the GLIP-01 lane for agent pushes.
// Twigpine `gl` clients sign requests with ed25519 keys identified by
// `did:key` keyids; accepting the standard here lets that installed base push
// to delta-git unchanged. Their documented profile leaves `@authority`
// uncovered ([OPEN] replay hole — a signature minted for one host replays on
// any other). We close it: the hardened profile below REQUIRES
// @method + @authority + @path (or @target-uri) + content-digest coverage,
// plus a live created/expires window.
//
// Request-body note: content-digest binds the whole body, so signature-gated
// receives are buffered at the gate (rebuilt Request for the streaming
// handler) and size-capped — the PAT path keeps full streaming.
export const HTTP_SIG_WINDOW_SEC = 300;
export const HTTP_SIG_MAX_BODY_BYTES = 64 * 1024 * 1024;

export type HttpSigVerify =
  | { kind: "ok"; did: string; agent: AgentRow }
  | { kind: "rejected"; reason: string };

interface SigParams {
  components: string[];
  /** verbatim `;k=v;k=v` suffix from the header — the signature base embeds
   *  the client's own serialization, never a re-ordering of ours. */
  rawSuffix: string;
  created?: number;
  expires?: number;
  nonce?: string;
  alg?: string;
  keyid?: string;
}

const te = new TextEncoder();

function b64decode(s: string): Uint8Array | undefined {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

// `Signature-Input: sig1=("@method" "@authority");created=…;keyid="did:…"`
// — the covered-components subset only; full RFC 8941 parsing is overkill.
function parseSignatureInput(header: string): { label: string; params: SigParams } | undefined {
  const eq = header.indexOf("=");
  if (eq === -1) return undefined;
  const label = header.slice(0, eq).trim();
  let rest = header.slice(eq + 1).trim();
  if (!rest.startsWith("(")) return undefined;
  const close = rest.indexOf(")");
  if (close === -1) return undefined;
  const inner = rest.slice(1, close);
  const components = [...inner.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  if (components.length === 0) return undefined;
  rest = rest.slice(close + 1);

  const params: SigParams = { components, rawSuffix: rest.trim() };
  for (const m of rest.matchAll(/;([a-zA-Z0-9_-]+)\s*=\s*("[^"]*"|[^;\s]+)/g)) {
    const key = m[1]!.toLowerCase();
    let value = m[2]!;
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key === "created" || key === "expires") {
      const n = Number(value);
      if (Number.isFinite(n)) params[key] = n;
    } else if (key === "nonce") params.nonce = value;
    else if (key === "alg") params.alg = value;
    else if (key === "keyid") params.keyid = value;
  }
  return { label, params };
}

function parseSignatureValue(header: string, label: string): Uint8Array | undefined {
  // `Signature: sig1=:b64:` — label lookup, base64 between colons.
  const prefix = `${label}=:`;
  const start = header.indexOf(prefix);
  if (start === -1) return undefined;
  const valueStart = start + prefix.length;
  const end = header.indexOf(":", valueStart);
  if (end === -1) return undefined;
  return b64decode(header.slice(valueStart, end));
}

function coveredValue(component: string, request: Request, url: URL): string | undefined {
  const name = component.toLowerCase();
  if (name.startsWith("@")) {
    switch (name) {
      case "@method":
        return request.method.toLowerCase();
      case "@authority":
        return url.host.toLowerCase();
      case "@scheme":
        return url.protocol.replace(":", "").toLowerCase();
      case "@path":
        return url.pathname;
      case "@query":
        return url.search ? url.search : undefined;
      case "@target-uri":
        return url.toString();
      default:
        return undefined; // unknown derived component — verifier rejects
    }
  }
  const v = request.headers.get(name);
  return v === null ? undefined : v;
}

// `("a" "b")` + the client's verbatim parameter suffix — reproduces the exact
// covered-string the client signed (RFC 9421 §2.5) without re-serializing.
function serializeParams(p: SigParams): string {
  const comp = `(${p.components.map((c) => `"${c}"`).join(" ")})`;
  return p.rawSuffix
    ? `${comp}${p.rawSuffix.startsWith(";") ? p.rawSuffix : `;${p.rawSuffix}`}`
    : comp;
}

async function sha256B64(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body as BufferSource);
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function hasHttpSignature(request: Request): boolean {
  return request.headers.has("signature-input") && request.headers.has("signature");
}

/**
 * Verify an RFC 9421-signed request. `body` must be the full request body
 * (caller buffers — the streaming receive path rebuilds the Request after).
 */
export async function verifyHttpSignature(args: {
  request: Request;
  body: Uint8Array;
  db: Db;
  nowSec?: number;
}): Promise<HttpSigVerify> {
  const { request, body, db } = args;
  const url = new URL(request.url);

  const inputHeader = request.headers.get("signature-input")!;
  const sigHeader = request.headers.get("signature")!;
  const parsed = parseSignatureInput(inputHeader);
  if (!parsed) return { kind: "rejected", reason: "bad-signature-input" };
  const { params } = parsed;

  // Hardened covered-components profile — no @authority is the replay hole
  // other GLIP nodes leave open; no content-digest lets a replayed signature
  // authorize a swapped body.
  const covered = params.components.map((c) => c.toLowerCase());
  if (!covered.includes("@method")) return { kind: "rejected", reason: "missing-method-coverage" };
  if (!covered.includes("@authority"))
    return { kind: "rejected", reason: "missing-authority-coverage" };
  if (!covered.includes("@path") && !covered.includes("@target-uri"))
    return { kind: "rejected", reason: "missing-path-coverage" };
  if (!covered.includes("content-digest"))
    return { kind: "rejected", reason: "missing-digest-coverage" };

  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  if (params.created === undefined) return { kind: "rejected", reason: "missing-created" };
  if (Math.abs(now - params.created) > HTTP_SIG_WINDOW_SEC)
    return { kind: "rejected", reason: "stale-created" };
  if (params.expires !== undefined && now > params.expires)
    return { kind: "rejected", reason: "expired" };
  if (params.alg !== undefined && params.alg !== "ed25519")
    return { kind: "rejected", reason: "unsupported-alg" };

  const keyid = params.keyid ?? "";
  const didMatch = keyid.match(/^(did:key:z[1-9A-HJ-NP-Za-km-z]+)/);
  if (!didMatch) return { kind: "rejected", reason: "keyid-not-did-key" };
  const did = didMatch[1]!;
  const decoded = pubkeyFromDidKey(did);
  if (!decoded || decoded.curve !== "ed25519")
    return { kind: "rejected", reason: "unsupported-did-key-curve" };

  const agent = await getAgent(db, did);
  if (!agent) return { kind: "rejected", reason: "unknown-did" };
  if (agent.banned === 1) return { kind: "rejected", reason: "agent-banned" };

  // Body integrity — the digest the client signed must match ours.
  const digestHeader = request.headers.get("content-digest") ?? "";
  const expected = `sha-256=:${await sha256B64(body)}:`;
  if (digestHeader.trim() !== expected)
    return { kind: "rejected", reason: "content-digest-mismatch" };

  // Signature base: one "name": value line per covered component, then the
  // "@signature-params" line serializing the input exactly as signed.
  const baseLines: string[] = [];
  for (const comp of covered) {
    const value = coveredValue(comp, request, url);
    if (value === undefined) return { kind: "rejected", reason: `uncovered-component:${comp}` };
    baseLines.push(`"${comp}": ${value}`);
  }
  baseLines.push(`"@signature-params": ${serializeParams(params)}`);
  const base = baseLines.join("\n");

  const sigBytes = parseSignatureValue(sigHeader, parsed.label);
  if (!sigBytes || sigBytes.length !== 64)
    return { kind: "rejected", reason: "bad-signature-format" };

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      decoded.pubkey as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
  } catch {
    return { kind: "rejected", reason: "bad-pubkey" };
  }
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    sigBytes as BufferSource,
    te.encode(base) as BufferSource
  );
  if (!ok) return { kind: "rejected", reason: "signature-mismatch" };

  return { kind: "ok", did, agent };
}

// Per RFC 9421 the server names its profile in the challenge so clients can
// self-correct covered components.
export function signatureChallenge(): Response {
  return new Response("HTTP signature authentication required\n", {
    status: 401,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate":
        'Signature realm="git", alg="ed25519", covered="(@method @authority @path content-digest)"',
    },
  });
}
