#!/usr/bin/env node
// Fire two concurrent receive-pack requests at the live deployment with the
// same expected-old oid — the in-flight race the never-reject contract is
// built for. One lands on main; the other becomes refs/delta/* + an intent.
// Usage: node scripts/demo-race.mjs <ns> <repo> <pat> <parentOid> <treeOid>

const [ns, repo, pat, parentOid, treeOid] = process.argv.slice(2);
const ORIGIN = process.env.DEMO_ORIGIN ?? "https://code.widespread.fyi";
if (!ns || !repo || !pat || !parentOid || !treeOid) {
  console.error("usage: demo-race.mjs <ns> <repo> <pat> <parentOid> <treeOid>");
  process.exit(1);
}

const te = new TextEncoder();
const concat = (parts) => {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

const { deflateSync } = await import("node:zlib");

function pktLine(payload) {
  const p = typeof payload === "string" ? te.encode(payload) : payload;
  const len = (p.length + 4).toString(16).padStart(4, "0");
  return concat([te.encode(len), p]);
}
const flushPkt = () => te.encode("0000");

// git object header: first byte = (type<<4) | low4(size); continuation bytes
// carry 7 size bits each with the MSB set until the last.
function encodeObjHeader(type, size) {
  const out = [];
  let byte = (type << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    out.push(byte | 0x80);
    byte = size & 0x7f;
    size >>>= 7;
  }
  out.push(byte);
  return Uint8Array.from(out);
}

async function makeCommit(msg) {
  const author = "Demo Agent <demo@widespread.fyi> 0 +0000";
  const payload = te.encode(
    `tree ${treeOid}\nparent ${parentOid}\nauthor ${author}\ncommitter ${author}\n\n${msg}\n`
  );
  const oid = hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-1", concat([te.encode(`commit ${payload.length}\0`), payload]))
    )
  );
  return { oid, payload };
}

async function buildPack(objects) {
  const header = new Uint8Array(12);
  header.set(te.encode("PACK"));
  new DataView(header.buffer).setUint32(4, 2, false);
  new DataView(header.buffer).setUint32(8, objects.length, false);
  const parts = [header];
  for (const o of objects) {
    parts.push(encodeObjHeader(o.typeCode, o.payload.length));
    parts.push(new Uint8Array(deflateSync(o.payload)));
  }
  const body = concat(parts);
  return concat([body, new Uint8Array(await crypto.subtle.digest("SHA-1", body))]);
}

async function push(commit, label) {
  const pack = await buildPack([{ typeCode: 1, payload: commit.payload }]); // 1=commit
  const res = await fetch(`${ORIGIN}/${ns}/${repo}/git-receive-pack`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-git-receive-pack-request",
      Authorization: `Basic ${btoa(`${ns}:${pat}`)}`,
    },
    body: concat([
      pktLine(
        `${parentOid} ${commit.oid} refs/heads/main\0 report-status ofs-delta agent=demo-race\n`
      ),
      flushPkt(),
      pack,
    ]),
  });
  const body = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(body);
  console.log(`[${label}] status=${res.status} report=${JSON.stringify(text.slice(0, 400))}`);
  return res.status;
}

const [cA, cB] = await Promise.all([
  makeCommit(`Racer A: concurrent commit ${Date.now()}`),
  makeCommit(`Racer B: concurrent commit ${Date.now()}`),
]);
console.log(`parent=${parentOid} A=${cA.oid} B=${cB.oid}`);
await Promise.all([push(cA, "A"), push(cB, "B")]);

const refs = await fetch(`${ORIGIN}/${ns}/${repo}/info/refs?service=git-upload-pack`, {
  headers: { Authorization: `Basic ${btoa(`${ns}:${pat}`)}` },
}).then((r) => r.text());
console.log("refs after race:", refs.match(/[0-9a-f]{40} refs\/[^\n ]+/g));
