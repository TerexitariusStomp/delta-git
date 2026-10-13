#!/usr/bin/env node
// Mint a real did:key session on the live deployment, create a demo repo,
// and mint a push-scoped PAT — used to capture presentation screenshots.
// Usage: node scripts/demo-session.mjs [origin]

const ORIGIN = process.argv[2] ?? "https://code.widespread.fyi";

// --- base58btc (bitcoin alphabet) — enough for the 34-byte did:key payload ---
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58btc(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry = (carry + (digits[j] << 8)) | 0;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return (
    "1".repeat(zeros) +
    digits
      .reverse()
      .map((d) => ALPHABET[d])
      .join("")
  );
}

const te = new TextEncoder();
const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function main() {
  // 1. Fresh ed25519 identity → did:key
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pubkey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const did = `did:key:z${base58btc(new Uint8Array([0xed, 0x01, ...pubkey]))}`;
  console.error(`[demo-session] did=${did}`);

  // 2. Challenge → sign → verify → dg_session cookie
  const chRes = await fetch(`${ORIGIN}/auth/did/challenge?did=${encodeURIComponent(did)}`);
  const ch = await chRes.json();
  if (!chRes.ok) throw new Error(`challenge: ${JSON.stringify(ch)}`);
  const sig = b64url(
    new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, te.encode(ch.payload)))
  );
  const vRes = await fetch(`${ORIGIN}/auth/did/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ did: ch.did, nonce: ch.nonce, sig, iat: ch.iat, exp: ch.exp }),
  });
  if (!vRes.ok) throw new Error(`verify: ${await vRes.text()}`);
  const setCookie = vRes.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  console.error(`[demo-session] session minted`);

  // 3. Who am I → personal namespace
  const meRes = await fetch(`${ORIGIN}/api/v1/user`, { headers: { Cookie: cookie } });
  const me = await meRes.json();
  if (!meRes.ok) throw new Error(`user: ${JSON.stringify(me)}`);
  const ns = me.uid ?? me.username ?? me.name;
  console.error(`[demo-session] namespace=${ns}`);

  // 4. Demo repo (public so Explore shows it)
  const repo = "demo-forge";
  const cRes = await fetch(`${ORIGIN}/api/v1/repos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({
      identifier: repo,
      description: "Never-reject forge — concurrent pushes become merge intents",
      is_public: true,
      parent_ref: ns,
    }),
  });
  const cBody = await cRes.json();
  if (!cRes.ok && cRes.status !== 409) throw new Error(`create repo: ${JSON.stringify(cBody)}`);
  console.error(`[demo-session] repo ${ns}/${repo} status=${cRes.status}`);

  // 5. Push-scoped PAT
  const tRes = await fetch(`${ORIGIN}/auth/api/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({
      scope: "namespace",
      name: "demo-shots",
      namespaceSlug: ns,
      level: "push",
    }),
  });
  const tBody = await tRes.json();
  if (!tRes.ok) throw new Error(`pat: ${JSON.stringify(tBody)}`);
  const pat = tBody.token ?? tBody.pat ?? tBody.plaintext ?? tBody.access_token;

  console.log(JSON.stringify({ cookie, ns, repo, pat, origin: ORIGIN }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
