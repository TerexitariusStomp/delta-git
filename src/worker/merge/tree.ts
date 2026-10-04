import { bytesToHex, hexToBytes } from "@/worker/common/hex";

// Full tree entry codec — the core repo only ships a child-oid parser, so the
// merge engine needs its own read/write of "<mode> <name>\0<20-byte-oid>" rows.

export type TreeEntry = {
  /** Octal mode string as stored in the tree, e.g. "100644", "40000", "100755". */
  mode: string;
  name: string;
  oid: string;
};

export type Tree = Map<string, TreeEntry>;

const td = new TextDecoder();
const te = new TextEncoder();

export function isTreeMode(mode: string): boolean {
  return mode === "40000" || mode === "040000";
}

export function parseTree(payload: Uint8Array): Tree {
  const entries: Tree = new Map();
  let i = 0;
  while (i < payload.length) {
    let sp = i;
    while (sp < payload.length && payload[sp] !== 0x20) sp++;
    if (sp >= payload.length) break;
    const mode = td.decode(payload.subarray(i, sp));
    let nul = sp + 1;
    while (nul < payload.length && payload[nul] !== 0x00) nul++;
    if (nul + 20 > payload.length) break;
    const name = td.decode(payload.subarray(sp + 1, nul));
    const oid = bytesToHex(payload.subarray(nul + 1, nul + 21));
    entries.set(name, { mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Serialize tree entries in Git's ordering rules (dirs sort as "name/"). */
export function serializeTree(entries: Tree): Uint8Array {
  const sorted = [...entries.values()].sort((a, b) => {
    const an = isTreeMode(a.mode) ? `${a.name}/` : a.name;
    const bn = isTreeMode(b.mode) ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Uint8Array[] = [];
  for (const entry of sorted) {
    const head = te.encode(`${entry.mode} ${entry.name}`);
    const row = new Uint8Array(head.length + 1 + 20);
    row.set(head, 0);
    row[head.length] = 0x00;
    row.set(hexToBytes(entry.oid), head.length + 1);
    parts.push(row);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
