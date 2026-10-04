import { verifyMessage } from "viem";
import type { Env } from "./env";

// SIWE-lite: client signs "wp-cloud login <did> <nonce>", we verify + issue
// an HMAC session token  did|exp|sig  (base64url).
export async function verifySignature(address: string, message: string, signature: string) {
  try {
    return await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch { return false; }
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]!));
}

export async function issueToken(env: Env, did: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  return `${did}|${exp}|${await hmac(env.SESSION_SECRET ?? "dev", `${did}|${exp}`)}`;
}

export async function whoami(env: Env, req: Request): Promise<string | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return null;
  const [did, exp, sig] = token.split("|");
  if (!did || !exp || !sig || +exp < Date.now() / 1000) return null;
  return (await hmac(env.SESSION_SECRET ?? "dev", `${did}|${exp}`)) === sig ? did : null;
}

export function didFromAddress(addr: string) {
  return `did:pkh:eip155:8453:${addr.toLowerCase()}`;
}
