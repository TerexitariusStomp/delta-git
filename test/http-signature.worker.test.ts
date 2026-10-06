import { describe, it, expect } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { asBufferSource } from "@/worker/common";
import { bytesToHex } from "@/worker/common/hex";
import { concatChunks, decodePktLines, flushPkt, pktLine } from "@/worker/git";
import { registerAgent } from "@/worker/agent/auth";
import { createDb } from "@/worker/db/d1/client";

import { buildPack, uniqueRepoId, zero40, toRequestBody } from "./util/test-helpers";
import { makeTree, makeCommit } from "./util/git-pack";
import { setupRepoForTests } from "./util/repoSeed";
import { ensureD1Migrations } from "./util/d1Setup";

// RFC 9421 / GLIP-01 signed pushes: a did:key-identified agent signs the
// receive-pack request (method + authority + path + content-digest) and
// pushes without a PAT.

const te = new TextEncoder();

async function b64sha256(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", asBufferSource(body));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function newAgent() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const db = createDb(env.DB);
  const agent = await registerAgent(db, { pubkeyHex: bytesToHex(pub), label: "glip-agent" });
  if (!("did" in agent)) throw new Error("register failed");
  return { pair, did: agent.did as string };
}

function signatureBase(params: {
  method: string;
  authority: string;
  path: string;
  digest: string;
  sigInput: string;
}): string {
  return [
    `"@method": ${params.method}`,
    `"@authority": ${params.authority}`,
    `"@path": ${params.path}`,
    `"content-digest": ${params.digest}`,
    `"@signature-params": ${params.sigInput}`,
  ].join("\n");
}

async function signedReceivePack(args: {
  url: string;
  body: Uint8Array;
  pair: CryptoKeyPair;
  did: string;
  covered?: string[];
  created?: number;
}): Promise<Response> {
  const url = new URL(args.url);
  const digest = `sha-256=:${await b64sha256(args.body)}:`;
  const covered = args.covered ?? ["@method", "@authority", "@path", "content-digest"];
  const created = args.created ?? Math.floor(Date.now() / 1000);
  const params =
    `(${covered.map((c) => `"${c}"`).join(" ")})` +
    `;created=${created};keyid="${args.did}#k";nonce="n-${Math.random().toString(36).slice(2)}";alg="ed25519"`;
  const base = signatureBase({
    method: "post",
    authority: url.host,
    path: url.pathname,
    digest,
    sigInput: params,
  });
  const sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", args.pair.privateKey, te.encode(base) as BufferSource)
  );
  return await workerExports.default.fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-git-receive-pack-request",
      "Content-Digest": digest,
      "Signature-Input": `sig1=${params}`,
      Signature: `sig1=:${b64encode(sig)}:`,
    },
    body: toRequestBody(args.body),
  });
}

describe("GLIP-01: RFC 9421 signed pushes", () => {
  it("accepts a did:key-signed ref update without a PAT", async () => {
    await ensureD1Migrations(env);
    const owner = "o";
    const repo = uniqueRepoId("rsig");
    await setupRepoForTests(env, owner, repo);
    const { pair, did } = await newAgent();

    const tree = await makeTree();
    const commit = await makeCommit(tree.oid, "agent signed push\n");
    const pack = await buildPack([
      { type: "commit", payload: commit.payload },
      { type: "tree", payload: tree.payload },
    ]);
    const cmd = `${zero40()} ${commit.oid} refs/heads/siglane\0 report-status ofs-delta agent=gl\n`;
    const body = concatChunks([pktLine(cmd), flushPkt(), pack]);

    const res = await signedReceivePack({
      url: `https://example.com/${owner}/${repo}/git-receive-pack`,
      body,
      pair,
      did,
    });
    expect(res.status).toBe(200);
    const items = decodePktLines(new Uint8Array(await res.arrayBuffer()));
    const lines = items.filter((i) => i.type === "line").map((i) => (i.text as string).trim());
    expect(lines.some((l) => l.startsWith("unpack ok"))).toBe(true);
    expect(lines.some((l) => l.startsWith("ok refs/heads/siglane"))).toBe(true);
  });

  it("rejects a signature over a tampered body (digest mismatch)", async () => {
    const owner = "o";
    const repo = uniqueRepoId("rsig");
    await setupRepoForTests(env, owner, repo);
    const { pair, did } = await newAgent();

    const tree = await makeTree();
    const commit = await makeCommit(tree.oid, "x\n");
    const pack = await buildPack([
      { type: "commit", payload: commit.payload },
      { type: "tree", payload: tree.payload },
    ]);
    const cmd = `${zero40()} ${commit.oid} refs/heads/tamper\0 report-status ofs-delta\n`;
    const body = concatChunks([pktLine(cmd), flushPkt(), pack]);

    const url = new URL(`https://example.com/${owner}/${repo}/git-receive-pack`);
    // Sign for a DIFFERENT body than we send.
    const wrongDigest = `sha-256=:${await b64sha256(te.encode("other"))}:`;
    const created = Math.floor(Date.now() / 1000);
    const params =
      `("@method" "@authority" "@path" "content-digest")` +
      `;created=${created};keyid="${did}#k";nonce="nn";alg="ed25519"`;
    const base = signatureBase({
      method: "post",
      authority: url.host,
      path: url.pathname,
      digest: wrongDigest,
      sigInput: params,
    });
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", pair.privateKey, te.encode(base) as BufferSource)
    );
    const res = await workerExports.default.fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-receive-pack-request",
        // header claims the digest of "other" — doesn't match the real body
        "Content-Digest": wrongDigest,
        "Signature-Input": `sig1=${params}`,
        Signature: `sig1=:${b64encode(sig)}:`,
      },
      body: toRequestBody(body),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Signature");
  });

  it("rejects requests missing @authority coverage (replay-hardened profile)", async () => {
    const owner = "o";
    const repo = uniqueRepoId("rsig");
    await setupRepoForTests(env, owner, repo);
    const { pair, did } = await newAgent();

    const pack = await buildPack([]);
    const cmd = `${zero40()} ${zero40()} refs/heads/none\0 report-status ofs-delta\n`;
    const body = concatChunks([pktLine(cmd), flushPkt(), pack]);

    const res = await signedReceivePack({
      url: `https://example.com/${owner}/${repo}/git-receive-pack`,
      body,
      pair,
      did,
      covered: ["@method", "@path", "content-digest"], // no @authority
    });
    expect(res.status).toBe(401);
  });
});
