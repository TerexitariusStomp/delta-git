import { bytesToHex } from "@/worker/common/hex";

const te = new TextEncoder();

/**
 * Stable repository DID: `did:dg:repo:<sha256(owner/repo)[:16]>`.
 * Content-derived so it survives repo renames and is deterministic across
 * systems — any federation peer can recompute it from the repo's canonical
 * owner/slug pair.
 */
export async function repoDidFor(owner: string, repo: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    te.encode(`${owner.toLowerCase()}/${repo.toLowerCase()}`)
  );
  return `did:dg:repo:${bytesToHex(new Uint8Array(digest).slice(0, 16))}`;
}
