import { it, expect } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { asBufferSource } from "@/worker/common";
import { bytesToHex } from "@/worker/common/hex";
import { concatChunks, decodePktLines, flushPkt, pktLine } from "@/worker/git";
import { runFederateTask, __test as federateTest } from "@/worker/tasks/federate";

import { postReceivePack, uniqueRepoId, buildPack, zero40 } from "./util/test-helpers";
import { setupRepoForTests } from "./util/repoSeed";

const te = new TextEncoder();

type LooseObject = {
  type: "commit" | "tree" | "blob";
  oid: string;
  payload: Uint8Array;
};

// Object builders — real loose-object payloads hashed git-style.
async function makeBlob(content: string): Promise<LooseObject> {
  const payload = te.encode(content);
  return { type: "blob", oid: await hashObject("blob", payload), payload };
}

async function makeTree(
  entries: { mode: string; name: string; oid: string }[]
): Promise<LooseObject> {
  const parts: Uint8Array[] = [];
  for (const e of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const head = te.encode(`${e.mode} ${e.name}\0`);
    const oidBytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) oidBytes[i] = parseInt(e.oid.slice(i * 2, i * 2 + 2), 16);
    parts.push(head, oidBytes);
  }
  const payload = concatChunks(parts);
  return { type: "tree", oid: await hashObject("tree", payload), payload };
}

async function makeCommit(treeOid: string, parents: string[], msg: string): Promise<LooseObject> {
  const author = `You <you@example.com> 0 +0000`;
  const parentLines = parents.map((p) => `parent ${p}\n`).join("");
  const payload = te.encode(
    `tree ${treeOid}\n` + parentLines + `author ${author}\n` + `committer ${author}\n\n${msg}`
  );
  return { type: "commit", oid: await hashObject("commit", payload), payload };
}

async function hashObject(type: string, payload: Uint8Array): Promise<string> {
  const head = te.encode(`${type} ${payload.byteLength}\0`);
  const raw = concatChunks([head, payload]);
  const hash = await crypto.subtle.digest("SHA-1", asBufferSource(raw));
  return bytesToHex(new Uint8Array(hash));
}

// Push a full object set to `owner/repo` for `refs/heads/main`. Relies on
// postReceivePack attaching the PAT seeded by setupRepoForTests.
async function pushCommit(
  owner: string,
  repo: string,
  oldOid: string,
  objects: LooseObject[],
  newOid: string
): Promise<void> {
  const url = `https://example.com/${owner}/${repo}/git-receive-pack`;
  const pack = await buildPack(objects.map((o) => ({ type: o.type, payload: o.payload })));
  const cmd = `${oldOid} ${newOid} refs/heads/main\0 report-status ofs-delta agent=test\n`;
  const body = concatChunks([pktLine(cmd), flushPkt(), pack]);
  const res = await postReceivePack(url, body);
  expect(res.status).toBe(200);
  const items = decodePktLines(new Uint8Array(await res.arrayBuffer()));
  const lines = items.filter((i) => i.type === "line").map((i) => (i.text as string).trim());
  expect(lines.some((l) => l.startsWith("unpack ok"))).toBe(true);
  expect(lines.some((l) => l.startsWith("ok refs/heads/main"))).toBe(true);
}

// Route federation's outbound HTTP through the worker under test — lets the
// mirror target be another seeded repo in the same test environment.
const selfFetch: typeof fetch = (input, init) =>
  workerExports.default.fetch(input as RequestInfo, init as RequestInit);

async function advertisedMain(owner: string, repo: string, pat: string): Promise<string | null> {
  const res = await workerExports.default.fetch(
    `https://example.com/${owner}/${repo}/info/refs?service=git-receive-pack`,
    { headers: { Authorization: `Basic ${btoa(`${owner}:${pat}`)}` } }
  );
  expect(res.status).toBe(200);
  const refs = federateTest.parseAdvertisedRefs(new Uint8Array(await res.arrayBuffer()));
  return refs.get("refs/heads/main") ?? null;
}

// Seed a two-commit history on the source repo and return the objects.
async function seedTwoCommitHistory(owner: string, repo: string) {
  const b1 = await makeBlob("one\n");
  const t1 = await makeTree([{ mode: "100644", name: "a.txt", oid: b1.oid }]);
  const c1 = await makeCommit(t1.oid, [], "first\n");
  await pushCommit(owner, repo, zero40(), [c1, t1, b1], c1.oid);

  const b2 = await makeBlob("two\n");
  const t2 = await makeTree([
    { mode: "100644", name: "a.txt", oid: b1.oid },
    { mode: "100644", name: "b.txt", oid: b2.oid },
  ]);
  const c2 = await makeCommit(t2.oid, [c1.oid], "second\n");
  await pushCommit(owner, repo, c1.oid, [c2, t2, b2], c2.oid);
  return { c1, c2, b1, b2, t1, t2 };
}

async function oidsOf(objs: { type: string; payload: Uint8Array }[]): Promise<string[]> {
  return Promise.all(objs.map((o) => hashObject(o.type, o.payload)));
}

it("federate: collects complete object closure for a fresh remote", async () => {
  const owner = "o";
  const repo = uniqueRepoId("r-fed-collect");
  const seeded = await setupRepoForTests(env, owner, repo);
  const { c1, c2, b1, b2, t1, t2 } = await seedTwoCommitHistory(owner, repo);

  const objs = await federateTest.collectPushObjects(env, seeded.doName, c2.oid, new Set());
  expect(objs).toBeDefined();
  const oids = await oidsOf(objs!);
  for (const want of [c1.oid, c2.oid, t1.oid, t2.oid, b1.oid, b2.oid]) {
    expect(oids).toContain(want);
  }
});

it("federate: incremental walk excludes objects reachable from remote tips", async () => {
  const owner = "o";
  const repo = uniqueRepoId("r-fed-incremental");
  const seeded = await setupRepoForTests(env, owner, repo);
  const { c1, c2 } = await seedTwoCommitHistory(owner, repo);

  const objs = await federateTest.collectPushObjects(env, seeded.doName, c2.oid, new Set([c1.oid]));
  expect(objs).toBeDefined();
  const oids = await oidsOf(objs!);
  expect(oids).toContain(c2.oid);
  expect(oids).not.toContain(c1.oid);
});

it("federate: hex DO id is not a valid doName for object reads", async () => {
  const owner = "o";
  const repo = uniqueRepoId("r-fed-doid");
  const seeded = await setupRepoForTests(env, owner, repo);
  const { c2 } = await seedTwoCommitHistory(owner, repo);

  // Regression: callers that pass stub.id.toString() instead of the doName
  // must fail loudly (undefined) rather than silently produce an empty pack.
  const hexDoId = env.REPO_DO.idFromName(seeded.doName).toString();
  const objs = await federateTest.collectPushObjects(env, hexDoId, c2.oid, new Set());
  expect(objs).toBeUndefined();
});

it("federate: end-to-end mirror push lands on a second repo", async () => {
  const owner = "o";
  const srcRepo = uniqueRepoId("r-fed-src");
  const mirrorRepo = uniqueRepoId("r-fed-mirror");
  const src = await setupRepoForTests(env, owner, srcRepo);
  const mirror = await setupRepoForTests(env, owner, mirrorRepo);
  const { c2 } = await seedTwoCommitHistory(owner, srcRepo);

  expect(await advertisedMain(owner, mirrorRepo, mirror.patPlaintext)).toBeNull();

  const targetUrl = `https://${owner}:${encodeURIComponent(mirror.patPlaintext)}@example.com/${owner}/${mirrorRepo}`;
  const outcome = await runFederateTask(
    env,
    {
      kind: "federate",
      doId: env.REPO_DO.idFromName(src.doName).toString(),
      repoId: src.doName,
      ref: "refs/heads/main",
      sha: c2.oid,
      targets: [targetUrl],
    },
    { fetch: selfFetch }
  );

  expect(outcome.retry).toBe(false);
  expect(outcome.detail).toContain("ok");
  expect(await advertisedMain(owner, mirrorRepo, mirror.patPlaintext)).toBe(c2.oid);

  // A second run against the now-current mirror is a no-op.
  const again = await runFederateTask(
    env,
    {
      kind: "federate",
      doId: env.REPO_DO.idFromName(src.doName).toString(),
      repoId: src.doName,
      ref: "refs/heads/main",
      sha: c2.oid,
      targets: [targetUrl],
    },
    { fetch: selfFetch }
  );
  expect(again.detail).toContain("up-to-date");
});
