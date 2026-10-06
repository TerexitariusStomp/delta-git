// cli/oauth.ts — dgit's OAuth 2.1 client for delta-git.
//
// Flow (RFC 8252 native-app pattern + RFC 9449 DPoP):
//   dgit login → loopback HTTP listener on an ephemeral port → browser opens
//   /oauth/authorize (consent page is the SPA; dg_session proves identity) →
//   redirect back with a code → PKCE exchange at /oauth/token with a DPoP
//   proof → access + refresh tokens bound to this keypair.
//
// Token custody mirrors the browser model: the private key and tokens live
// in ~/.dgit/auth.json (mode 0600) and never leave this machine. Git Smart
// HTTP can't carry per-request DPoP proofs (the jti is single-use and the
// htu is per-request — a static http.extraHeader satisfies neither), so
// bound tokens degrade to plain bearer on the git transport; dgit's own
// API calls attach a fresh proof per request.

import { execFile } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DpopKeypair {
  /** public JWK — what the server thumbprints */
  jwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  /** private JWK — stays in the creds file, mode 0600 */
  privateJwk: { kty: "EC"; crv: "P-256"; x: string; y: string; d: string };
}

export interface HostCredentials {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt: number;
  dpop: DpopKeypair;
}

interface CredsFile {
  hosts: Record<string, HostCredentials>;
}

const SCOPES = "repo:read repo:write offline_access";
const CALLBACK_PATH = "/callback";

function credsPath(): string {
  return join(homedir(), ".dgit", "auth.json");
}

function loadCreds(): CredsFile {
  try {
    return JSON.parse(readFileSync(credsPath(), "utf8")) as CredsFile;
  } catch {
    return { hosts: {} };
  }
}

function saveCreds(creds: CredsFile): void {
  const path = credsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function storedCredentials(host: string): HostCredentials | null {
  return loadCreds().hosts[host] ?? null;
}

export function clearCredentials(host: string): boolean {
  const creds = loadCreds();
  if (!creds.hosts[host]) return false;
  delete creds.hosts[host];
  saveCreds(creds);
  return true;
}

function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function newDpopKeypair(): DpopKeypair {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.publicKey.export({ format: "jwk" }) as DpopKeypair["jwk"];
  const privateJwk = pair.privateKey.export({ format: "jwk" }) as DpopKeypair["privateJwk"];
  return { jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, privateJwk };
}

/** ES256-signed DPoP proof JWT. `ath` binds the proof to a specific access
 *  token on resource requests; absent on the token endpoint itself. */
export function dpopProof(
  keypair: DpopKeypair,
  htm: string,
  htu: string,
  accessToken?: string
): string {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: keypair.jwk };
  const payload: Record<string, unknown> = {
    htm: htm.toUpperCase(),
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: b64url(randomBytes(16)),
  };
  if (accessToken) {
    payload.ath = b64url(createHash("sha256").update(accessToken).digest());
  }
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(
    Buffer.from(JSON.stringify(payload))
  )}`;
  // JOSE ES256 = raw r||s, not DER — ieee-p1363 gives exactly that.
  const signature = sign("SHA256", Buffer.from(signingInput), {
    key: createPrivateKey({ key: keypair.privateJwk, format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${b64url(signature)}`;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(cmd, args, () => {});
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  host: string,
  keypair: DpopKeypair,
  form: URLSearchParams
): Promise<TokenResponse> {
  const res = await fetch(`${host}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Presenting a proof at token time binds the issued tokens to this
      // key — a stolen refresh token can't rotate without it.
      DPoP: dpopProof(keypair, "POST", `${host}/oauth/token`),
    },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    throw new Error(`token request failed: ${body.error_description ?? body.error ?? res.status}`);
  }
  return body;
}

/**
 * Ensure a dgit client registration exists on this host. Public client:
 * token_endpoint_auth_method "none" — the credential is the DPoP key, not a
 * shared secret. RFC 8252 loopback handling lets a single registered
 * 127.0.0.1 URI match any port.
 */
async function ensureClient(host: string, creds: CredsFile): Promise<string> {
  const existing = creds.hosts[host];
  if (existing?.clientId) return existing.clientId;
  const res = await fetch(`${host}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "dgit CLI",
      redirect_uris: [`http://127.0.0.1${CALLBACK_PATH}`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { client_id?: string; error?: string };
  if (!res.ok || !body.client_id) {
    throw new Error(`client registration failed: ${body.error ?? res.status}`);
  }
  // Persist the registration marker now (token fields filled post-exchange)
  // so an interrupted login never double-registers.
  creds.hosts[host] = {
    clientId: body.client_id,
    accessToken: "",
    expiresAt: 0,
    dpop: newDpopKeypair(),
  };
  saveCreds(creds);
  return body.client_id;
}

/**
 * `dgit login` — full browser round-trip. Resolves once the token exchange
 * completes and the credential file is written.
 */
export async function login(host: string): Promise<HostCredentials> {
  const creds = loadCreds();
  const keypair = creds.hosts[host]?.dpop ?? newDpopKeypair();
  const clientId = await ensureClient(host, creds);

  // PKCE (RFC 7636)
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
    (resolve, reject) => {
      let redirectUri = "";
      const finish = (fn: () => void) => {
        server.close();
        clearTimeout(timeout);
        fn();
      };
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end();
          return;
        }
        const err = url.searchParams.get("error");
        if (err) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<p>Authorization denied. You can close this tab.</p>");
          finish(() => reject(new Error(`authorize error: ${err}`)));
          return;
        }
        const authCode = url.searchParams.get("code");
        if (url.searchParams.get("state") !== state || !authCode) {
          res.writeHead(400).end("bad callback");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<p>Signed in — you can close this tab and return to dgit.</p>");
        finish(() => resolve({ code: authCode, redirectUri }));
      });
      server.on("error", (e) => finish(() => reject(e)));
      // Abandon the listener if the browser never comes back.
      const timeout = setTimeout(
        () => finish(() => reject(new Error("authorization timed out waiting for the browser callback"))),
        5 * 60 * 1000
      );
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        // The exact URI goes into the grant; token exchange must repeat it
        // byte-for-byte, so we capture it rather than reconstructing.
        redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
        const authorize = new URL(`${host}/oauth/authorize`);
        authorize.searchParams.set("response_type", "code");
        authorize.searchParams.set("client_id", clientId);
        authorize.searchParams.set("redirect_uri", redirectUri);
        authorize.searchParams.set("scope", SCOPES);
        authorize.searchParams.set("state", state);
        authorize.searchParams.set("code_challenge", challenge);
        authorize.searchParams.set("code_challenge_method", "S256");
        console.error(`opening browser to authorize:\n${authorize.toString()}`);
        openBrowser(authorize.toString());
      });
    }
  );

  const tokens = await tokenRequest(
    host,
    keypair,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    })
  );

  const stored: HostCredentials = {
    clientId,
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    dpop: keypair,
  };
  creds.hosts[host] = stored;
  saveCreds(creds);
  return stored;
}

/**
 * Credentials for outbound calls: refreshes when expired (the refresh
 * request itself needs a DPoP proof — bound refresh tokens enforce it).
 * Returns null when no login exists so callers can fall back to DG_PAT.
 */
export async function activeCredentials(host: string): Promise<HostCredentials | null> {
  const creds = loadCreds();
  const stored = creds.hosts[host];
  if (!stored || !stored.accessToken) return null;
  // 60s skew margin — a token expiring mid-request is worse than refreshing
  // slightly early.
  if (stored.expiresAt - Date.now() > 60_000) return stored;
  if (!stored.refreshToken) return null;
  try {
    const tokens = await tokenRequest(
      host,
      stored.dpop,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        client_id: stored.clientId,
      })
    );
    const next: HostCredentials = {
      ...stored,
      accessToken: tokens.access_token!,
      refreshToken: tokens.refresh_token ?? stored.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    };
    creds.hosts[host] = next;
    saveCreds(creds);
    return next;
  } catch (err) {
    console.error(`[dgit] token refresh failed — re-run \`dgit login\`: ${String(err)}`);
    return null;
  }
}

/** Authorization (+DPoP when a proof can be minted per request) headers
 *  for an API call. Returns null when no OAuth login exists — the caller
 *  falls back to DG_PAT Basic. */
export async function oauthRequestHeaders(
  host: string,
  method: string,
  url: string
): Promise<Record<string, string> | null> {
  const creds = await activeCredentials(host);
  if (!creds) return null;
  const { origin, pathname } = new URL(url);
  return {
    Authorization: `Bearer ${creds.accessToken}`,
    DPoP: dpopProof(creds.dpop, method, `${origin}${pathname}`, creds.accessToken),
  };
}

/** Bearer-only headers for the git transport — stock git can't mint
 *  per-request proofs, so bound tokens go bare here (the server accepts
 *  this on the git path; everywhere else the binding is enforced). */
export async function oauthGitHeaders(host: string): Promise<Record<string, string> | null> {
  const creds = await activeCredentials(host);
  if (!creds) return null;
  return { Authorization: `Bearer ${creds.accessToken}` };
}
