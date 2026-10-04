#!/usr/bin/env -S npx tsx
// did:key sign-in helper — the browser flow at /auth asks for a signature
// over a single-use challenge payload; this tool produces it locally so
// no private key ever leaves your machine.
//
//   npx tsx tools/did-sign.ts keygen
//       → prints a fresh did:key identity (ed25519) + private key hex.
//         Save the private key; it IS your login credential.
//
//   npx tsx tools/did-sign.ts sign --key <privkey-hex> --payload '<challenge-json>'
//       → prints the base64url signature to paste into the sign-in form.
//         With no --payload it reads the payload from stdin.
//
// Typical sign-in:
//   1. keygen once, store the output somewhere safe
//   2. paste the printed did:key:… into the site's Handle/DID box
//   3. copy the challenge payload it shows into `sign --payload '…'`
//   4. paste the printed signature back into the form

import { didKeyFromPubkey } from "../src/worker/agent/atpauth/didkey";

const te = new TextEncoder();

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes as ArrayBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function keygen(): Promise<void> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pubkey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const did = didKeyFromPubkey(pubkey, "ed25519");
  // PKCS#8 is the portable private-key container — the `sign` command
  // re-imports it rather than handling raw seed bytes.
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  console.log(JSON.stringify({ did, privateKeyHex: toHex(pkcs8) }, null, 2));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function sign(args: string[]): Promise<void> {
  const get = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const keyHex = get("key");
  if (!keyHex) {
    console.error("usage: sign --key <pkcs8-hex> [--payload '<json>']");
    process.exit(1);
  }
  const payload = get("payload") ?? (await readStdin());
  if (!payload) {
    console.error("no payload — pass --payload or pipe the challenge JSON to stdin");
    process.exit(1);
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    fromHex(keyHex) as BufferSource,
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", key, te.encode(payload) as BufferSource)
  );
  console.log(b64url(sig));
}

const cmd = process.argv[2];
if (cmd === "keygen") await keygen();
else if (cmd === "sign") await sign(process.argv.slice(3));
else {
  console.error(
    "usage:\n  did-sign.ts keygen\n  did-sign.ts sign --key <hex> [--payload '<json>']"
  );
  process.exit(1);
}
