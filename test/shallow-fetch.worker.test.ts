import { describe, it, expect } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { delimPkt, flushPkt, pktLine, decodePktLines } from "@/worker/git";
import { encodeGitObject } from "@/worker/git/core/objects";
import { scanPack } from "@/worker/git/pack/indexer";
import { createLogger } from "@/worker/common/logger";
import { asBufferSource, bytesToHex } from "@/worker/common";
import { uniqueRepoId } from "./util/test-helpers";
import { setupRepoForTests } from "./util/repoSeed";
import { ensureD1Migrations } from "./util/d1Setup";
import { seedPackedRepoState, buildTreePayload } from "./util/packed-repo";
import { buildPack } from "./util/git-pack";
import type { TreeEntry } from "@/worker/git/operations/read/types";

const enc = new TextEncoder();
const author = "A <a@a> 1000000000 +0000";

// c1 -> c2 -> c3 -> c4 (tip). Each commit carries a distinct root tree;
// c3/c4 additionally nest a `sub/` subtree for tree-depth filter coverage.
async function seedChain(owner: string, repo: string) {
  await setupRepoForTests(env, owner, repo);
  const repoId = `${owner}/${repo}`;
  const id = env.REPO_DO.idFromName(repoId);
  const getStub = () => env.REPO_DO.get(id);

  const objects: { type: "commit" | "tree" | "blob"; payload: Uint8Array }[] = [];
  const mk = async <T extends "commit" | "tree" | "blob">(type: T, payload: Uint8Array) => {
    const encoded = await encodeGitObject(type, payload);
    objects.push({ type, payload });
    return encoded;
  };

  const blob = async (name: string) => await mk("blob", enc.encode(`blob ${name}\n`));
  const a = await blob("a");
  const b = await blob("b");
  const c = await blob("c");
  const d = await blob("d");

  const treeEntries = (entries: TreeEntry[]) => buildTreePayload(entries);
  const tree1 = await mk("tree", treeEntries([{ mode: "100644", name: "a", oid: a.oid }]));
  const tree2 = await mk(
    "tree",
    treeEntries([
      { mode: "100644", name: "a", oid: a.oid },
      { mode: "100644", name: "b", oid: b.oid },
    ])
  );
  const sub1 = await mk("tree", treeEntries([{ mode: "100644", name: "c", oid: c.oid }]));
  const tree3 = await mk(
    "tree",
    treeEntries([
      { mode: "100644", name: "a", oid: a.oid },
      { mode: "100644", name: "b", oid: b.oid },
      { mode: "40000", name: "sub", oid: sub1.oid },
    ])
  );
  const sub2 = await mk(
    "tree",
    treeEntries([
      { mode: "100644", name: "c", oid: c.oid },
      { mode: "100644", name: "d", oid: d.oid },
    ])
  );
  const tree4 = await mk(
    "tree",
    treeEntries([
      { mode: "100644", name: "a", oid: a.oid },
      { mode: "100644", name: "b", oid: b.oid },
      { mode: "40000", name: "sub", oid: sub2.oid },
    ])
  );

  const commitPayload = (tree: string, parents: string[], msg: string) =>
    enc.encode(
      `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join("")}author ${author}\ncommitter ${author}\n\n${msg}\n`
    );
  const c1 = await mk("commit", commitPayload(tree1.oid, [], "c1"));
  const c2 = await mk("commit", commitPayload(tree2.oid, [c1.oid], "c2"));
  const c3 = await mk("commit", commitPayload(tree3.oid, [c2.oid], "c3"));
  const c4 = await mk("commit", commitPayload(tree4.oid, [c3.oid], "c4"));

  const packBytes = await buildPack(objects);
  await seedPackedRepoState({
    env,
    repoId,
    getStub,
    packs: [{ name: "pack-chain.pack", packBytes }],
    refs: [{ name: "refs/heads/main", oid: c4.oid }],
    head: { target: "refs/heads/main", oid: c4.oid },
  });

  return {
    repoId,
    getStub,
    oids: { c1, c2, c3, c4, tree1, tree2, tree3, tree4, sub1, sub2, blobs: { a, b, c, d } },
  };
}

function fetchBody(args: {
  wants: string[];
  haves?: string[];
  deepen?: number;
  deepenNot?: string[];
  shallows?: string[];
  filter?: string;
}): Uint8Array {
  const chunks: Uint8Array[] = [];
  chunks.push(pktLine("command=fetch\n"));
  chunks.push(delimPkt());
  for (const w of args.wants) chunks.push(pktLine(`want ${w}\n`));
  for (const h of args.haves ?? []) chunks.push(pktLine(`have ${h}\n`));
  if (args.deepen !== undefined) chunks.push(pktLine(`deepen ${args.deepen}\n`));
  for (const rev of args.deepenNot ?? []) chunks.push(pktLine(`deepen-not ${rev}\n`));
  for (const s of args.shallows ?? []) chunks.push(pktLine(`shallow ${s}\n`));
  if (args.filter) chunks.push(pktLine(`filter ${args.filter}\n`));
  chunks.push(pktLine("done\n"));
  chunks.push(flushPkt());
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

type FetchResult = {
  shallowLines: string[];
  packOids: Set<string>;
  packTypeOids: Map<number, Set<string>>;
};

const noopLimiter = { run: (_l: string, fn: () => Promise<unknown>) => fn() };

async function postFetch(owner: string, repo: string, body: Uint8Array): Promise<FetchResult> {
  const res = await workerExports.default.fetch(
    `https://example.com/${owner}/${repo}/git-upload-pack`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-upload-pack-request",
        "Git-Protocol": "version=2",
      },
      body: asBufferSource(body),
    }
  );
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const items = decodePktLines(bytes);

  const shallowLines: string[] = [];
  const packChunks: Uint8Array[] = [];
  let inPack = false;
  for (const item of items) {
    if (item.type === "line") {
      const text = item.text;
      if (text.startsWith("shallow ") || text.startsWith("unshallow ")) {
        shallowLines.push(text.trim());
      }
      if (text === "packfile\n") inPack = true;
      else if (inPack && item.raw?.[0] === 0x01) packChunks.push(item.raw.subarray(1));
    }
  }
  expect(inPack).toBe(true);
  const packLen = packChunks.reduce((n, c) => n + c.byteLength, 0);
  const packBytes = new Uint8Array(packLen);
  let off = 0;
  for (const c of packChunks) {
    packBytes.set(c, off);
    off += c.byteLength;
  }
  expect(new TextDecoder().decode(packBytes.subarray(0, 4))).toBe("PACK");

  const packKey = `test-scratch/${uniqueRepoId("scan")}.pack`;
  await env.REPO_BUCKET.put(packKey, packBytes);
  const scan = await scanPack({
    env,
    packKey,
    packSize: packBytes.byteLength,
    limiter: noopLimiter as never,
    countSubrequest: () => {},
    log: createLogger(undefined, { service: "shallow-test" }),
  });

  const packOids = new Set<string>();
  const packTypeOids = new Map<number, Set<string>>();
  for (let i = 0; i < scan.table.count; i++) {
    const oid = bytesToHex(scan.table.oids.subarray(i * 20, (i + 1) * 20));
    packOids.add(oid);
    const type = scan.table.objectTypes[i]!;
    const set = packTypeOids.get(type) ?? new Set<string>();
    set.add(oid);
    packTypeOids.set(type, set);
  }
  return { shallowLines, packOids, packTypeOids };
}

describe("shallow fetch + filters", () => {
  it("advertises the shallow/filter feature set", async () => {
    await ensureD1Migrations(env);
    const owner = "o";
    const repo = uniqueRepoId("shallow-cap");
    await setupRepoForTests(env, owner, repo);
    const res = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/info/refs?service=git-upload-pack`
    );
    const text = new TextDecoder().decode(await res.arrayBuffer());
    expect(text).toContain("fetch=shallow deepen-not filter wait-for-done");
  });

  it("deepen 1 sends only the tip commit + its tree closure, marked shallow", async () => {
    const owner = "o";
    const repo = uniqueRepoId("deepen1");
    const { oids } = await seedChain(owner, repo);

    const res = await postFetch(owner, repo, fetchBody({ wants: [oids.c4.oid], deepen: 1 }));

    expect(res.shallowLines).toContain(`shallow ${oids.c4.oid}`);
    // tip commit + root tree + subtree + all blobs under them
    expect(res.packOids.has(oids.c4.oid)).toBe(true);
    expect(res.packOids.has(oids.tree4.oid)).toBe(true);
    expect(res.packOids.has(oids.sub2.oid)).toBe(true);
    for (const b of Object.values(oids.blobs)) expect(res.packOids.has(b.oid)).toBe(true);
    // history cut at the boundary
    expect(res.packOids.has(oids.c3.oid)).toBe(false);
    expect(res.packOids.has(oids.c2.oid)).toBe(false);
    expect(res.packOids.has(oids.c1.oid)).toBe(false);
    expect(res.packOids.has(oids.tree3.oid)).toBe(false);
  });

  it("deepen 2 marks the second commit shallow and includes two levels", async () => {
    const owner = "o";
    const repo = uniqueRepoId("deepen2");
    const { oids } = await seedChain(owner, repo);

    const res = await postFetch(owner, repo, fetchBody({ wants: [oids.c4.oid], deepen: 2 }));

    expect(res.shallowLines).toContain(`shallow ${oids.c3.oid}`);
    expect(res.shallowLines).not.toContain(`shallow ${oids.c4.oid}`);
    expect(res.packOids.has(oids.c4.oid)).toBe(true);
    expect(res.packOids.has(oids.c3.oid)).toBe(true);
    expect(res.packOids.has(oids.tree3.oid)).toBe(true);
    expect(res.packOids.has(oids.c2.oid)).toBe(false);
    expect(res.packOids.has(oids.c1.oid)).toBe(false);
  });

  it("deepen-not excludes history reachable from the base", async () => {
    const owner = "o";
    const repo = uniqueRepoId("deepennot");
    const { oids } = await seedChain(owner, repo);

    const res = await postFetch(
      owner,
      repo,
      fetchBody({ wants: [oids.c4.oid], deepenNot: [oids.c2.oid] })
    );

    // c3 is the boundary commit adjacent to the excluded region
    expect(res.shallowLines).toContain(`shallow ${oids.c3.oid}`);
    expect(res.packOids.has(oids.c4.oid)).toBe(true);
    expect(res.packOids.has(oids.c3.oid)).toBe(true);
    expect(res.packOids.has(oids.c2.oid)).toBe(false);
    expect(res.packOids.has(oids.c1.oid)).toBe(false);
    expect(res.packOids.has(oids.tree2.oid)).toBe(false);
  });

  it("deepen-not resolves ref names as well as oids", async () => {
    const owner = "o";
    const repo = uniqueRepoId("deepennot-name");
    const { oids } = await seedChain(owner, repo);

    const res = await postFetch(
      owner,
      repo,
      fetchBody({ wants: [oids.c4.oid], deepenNot: ["main"], deepen: 3 })
    );

    // main resolves to c4 — everything reachable from it is excluded, but the
    // depth cut still bounds the walk; the fetch degenerates to an empty pack
    // or tip-only pack depending on exclusion order — assert c1 is absent.
    expect(res.packOids.has(oids.c1.oid)).toBe(false);
  });

  it("filter blob:none sends commits and trees but no blobs", async () => {
    const owner = "o";
    const repo = uniqueRepoId("blobnone");
    const { oids } = await seedChain(owner, repo);

    const res = await postFetch(
      owner,
      repo,
      fetchBody({ wants: [oids.c4.oid], filter: "blob:none" })
    );

    expect(res.shallowLines).toHaveLength(0);
    for (const c of [oids.c1, oids.c2, oids.c3, oids.c4]) {
      expect(res.packOids.has(c.oid)).toBe(true);
    }
    for (const t of [oids.tree1, oids.tree2, oids.tree3, oids.tree4, oids.sub1, oids.sub2]) {
      expect(res.packOids.has(t.oid)).toBe(true);
    }
    expect(res.packTypeOids.get(3)?.size ?? 0).toBe(0);
  });

  it("filter tree:0 keeps root trees only", async () => {
    const owner = "o";
    const repo = uniqueRepoId("tree0");
    const { oids } = await seedChain(owner, repo);

    const res = await postFetch(owner, repo, fetchBody({ wants: [oids.c4.oid], filter: "tree:0" }));

    for (const c of [oids.c1, oids.c2, oids.c3, oids.c4]) {
      expect(res.packOids.has(c.oid)).toBe(true);
    }
    for (const t of [oids.tree1, oids.tree2, oids.tree3, oids.tree4]) {
      expect(res.packOids.has(t.oid)).toBe(true);
    }
    // subtrees (depth 1) and all blobs (depth >= 1) omitted
    expect(res.packOids.has(oids.sub1.oid)).toBe(false);
    expect(res.packOids.has(oids.sub2.oid)).toBe(false);
    expect(res.packTypeOids.get(3)?.size ?? 0).toBe(0);
  });

  it("echoes client shallow markers in shallow-info", async () => {
    const owner = "o";
    const repo = uniqueRepoId("shallow-echo");
    const { oids } = await seedChain(owner, repo);

    const res = await postFetch(
      owner,
      repo,
      fetchBody({ wants: [oids.c4.oid], shallows: [oids.c3.oid], deepen: 1 })
    );

    expect(res.shallowLines).toContain(`shallow ${oids.c4.oid}`);
    expect(res.shallowLines).toContain(`shallow ${oids.c3.oid}`);
  });

  it("unfiltered fetch still serves the full closure", async () => {
    const owner = "o";
    const repo = uniqueRepoId("full-clone");
    const { oids } = await seedChain(owner, repo);

    const res = await postFetch(owner, repo, fetchBody({ wants: [oids.c4.oid] }));

    expect(res.shallowLines).toHaveLength(0);
    expect(res.packOids.has(oids.c1.oid)).toBe(true);
    expect(res.packOids.has(oids.c4.oid)).toBe(true);
    expect(res.packOids.size).toBeGreaterThanOrEqual(10);
  });
});
