import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { encodeGitObject, listPathsLastChange } from "@/worker/git";
import { uniqueRepoId, runDOWithRetry, type RepoDOStubFactory } from "./util/test-helpers";
import { setupRepoForTests } from "./util/repoSeed";
import { registerTestPack } from "./util/packed-repo";

type TreeSpec = {
  mode: string;
  name: string;
  oid: string;
};

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

type GitObject = {
  oid: string;
  zdata: Uint8Array;
  type: "commit" | "tree" | "blob" | "tag";
  payload: Uint8Array;
};

async function createBlob(content: string): Promise<GitObject> {
  const payload = new TextEncoder().encode(content);
  const result = await encodeGitObject("blob", payload);
  return { ...result, type: "blob", payload };
}

async function createTree(entries: TreeSpec[]): Promise<GitObject> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const head = encoder.encode(`${entry.mode} ${entry.name}\0`);
    const oidBytes = hexToBytes(entry.oid);
    const chunk = new Uint8Array(head.length + oidBytes.length);
    chunk.set(head, 0);
    chunk.set(oidBytes, head.length);
    chunks.push(chunk);
    total += chunk.length;
  }
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.length;
  }
  const result = await encodeGitObject("tree", payload);
  return { ...result, type: "tree", payload };
}

async function createCommit(args: {
  treeOid: string;
  parents?: string[];
  message: string;
}): Promise<GitObject> {
  const author = "You <you@example.com> 0 +0000";
  const parentLines = (args.parents || []).map((parent) => `parent ${parent}\n`).join("");
  const payload = new TextEncoder().encode(
    `tree ${args.treeOid}\n${parentLines}author ${author}\ncommitter ${author}\n\n${args.message}\n`
  );
  const result = await encodeGitObject("commit", payload);
  return { ...result, type: "commit", payload };
}

async function packAll(
  repoId: string,
  getStub: RepoDOStubFactory,
  objects: GitObject[]
): Promise<void> {
  await registerTestPack({
    env,
    repoId,
    getStub,
    packName: `pack-lastchange-${Date.now()}.pack`,
    objects: objects.map((o) => ({ type: o.type, payload: o.payload })),
  });
}

async function setMainRef(getStub: RepoDOStubFactory, oid: string): Promise<void> {
  await runDOWithRetry(getStub, async (instance) => {
    await instance.setRefs([{ name: "refs/heads/main", oid }]);
    await instance.setHead({ target: "refs/heads/main" });
  });
}

async function makeRepo(prefix: string) {
  const owner = "o";
  const repo = uniqueRepoId(prefix);
  await setupRepoForTests(env, owner, repo);
  const repoId = `${owner}/${repo}`;
  const id = env.REPO_DO.idFromName(repoId);
  const getStub = () => env.REPO_DO.get(id);
  return { repoId, getStub };
}

describe("listPathsLastChange", () => {
  it("credits every root entry to the root commit and reports an exact count", async () => {
    const { repoId, getStub } = await makeRepo("r-lc-root");

    const readme = await createBlob("hello\n");
    const app = await createBlob("app\n");
    // Non-empty dir: empty trees emit no diff paths and are legitimately
    // unattributable (git records no files under them).
    const srcDir = await createTree([{ mode: "100644", name: "app.ts", oid: app.oid }]);
    const tree = await createTree([
      { mode: "100644", name: "README.md", oid: readme.oid },
      { mode: "40000", name: "src", oid: srcDir.oid },
    ]);
    const commit = await createCommit({ treeOid: tree.oid, message: "root\n" });
    await setMainRef(getStub, commit.oid);
    await packAll(repoId, getStub, [readme, app, srcDir, tree, commit]);

    const result = await listPathsLastChange(env as Env, repoId, "main", "", [
      { name: "README.md", isDir: false },
      { name: "src", isDir: true },
    ]);

    expect(result).not.toBeNull();
    expect(result?.headOid).toBe(commit.oid);
    expect(result?.commitCount).toBe(1);
    expect(result?.entries["README.md"]?.oid).toBe(commit.oid);
    expect(result?.entries["README.md"]?.subject).toBe("root");
    expect(result?.entries["src"]?.oid).toBe(commit.oid);
    expect(result?.entries["src"]?.author).toBe("You");
  });

  it("attributes untouched files to older commits and directories via descendants", async () => {
    const { repoId, getStub } = await makeRepo("r-lc-dir");

    const readme = await createBlob("v1\n");
    const appV1 = await createBlob("app1\n");
    const srcTreeV1 = await createTree([{ mode: "100644", name: "app.ts", oid: appV1.oid }]);
    const rootTree = await createTree([
      { mode: "100644", name: "README.md", oid: readme.oid },
      { mode: "40000", name: "src", oid: srcTreeV1.oid },
    ]);
    const rootCommit = await createCommit({ treeOid: rootTree.oid, message: "root\n" });

    const appV2 = await createBlob("app2\n");
    const srcTreeV2 = await createTree([{ mode: "100644", name: "app.ts", oid: appV2.oid }]);
    const nextTree = await createTree([
      { mode: "100644", name: "README.md", oid: readme.oid },
      { mode: "40000", name: "src", oid: srcTreeV2.oid },
    ]);
    const nextCommit = await createCommit({
      treeOid: nextTree.oid,
      parents: [rootCommit.oid],
      message: "update app\n",
    });
    await setMainRef(getStub, nextCommit.oid);
    await packAll(repoId, getStub, [
      readme,
      appV1,
      srcTreeV1,
      rootTree,
      rootCommit,
      appV2,
      srcTreeV2,
      nextTree,
      nextCommit,
    ]);

    const result = await listPathsLastChange(env as Env, repoId, "main", "", [
      { name: "README.md", isDir: false },
      { name: "src", isDir: true },
    ]);

    expect(result?.commitCount).toBe(2);
    // Only `src/app.ts` changed in the head commit — the directory row picks it
    // up via descendant matching; the untouched README falls back to the root.
    expect(result?.entries["src"]?.oid).toBe(nextCommit.oid);
    expect(result?.entries["src"]?.subject).toBe("update app");
    expect(result?.entries["README.md"]?.oid).toBe(rootCommit.oid);
  });

  it("leaves uncovered entries absent when the commit budget is exhausted", async () => {
    const { repoId, getStub } = await makeRepo("r-lc-budget");

    const a1 = await createBlob("a1\n");
    const b1 = await createBlob("b1\n");
    const tree1 = await createTree([
      { mode: "100644", name: "a.txt", oid: a1.oid },
      { mode: "100644", name: "b.txt", oid: b1.oid },
    ]);
    const c1 = await createCommit({ treeOid: tree1.oid, message: "one\n" });

    const a2 = await createBlob("a2\n");
    const tree2 = await createTree([
      { mode: "100644", name: "a.txt", oid: a2.oid },
      { mode: "100644", name: "b.txt", oid: b1.oid },
    ]);
    const c2 = await createCommit({ treeOid: tree2.oid, parents: [c1.oid], message: "two\n" });
    await setMainRef(getStub, c2.oid);
    await packAll(repoId, getStub, [a1, b1, tree1, c1, a2, tree2, c2]);

    // maxCommits=1 only walks the head commit: a.txt is credited, b.txt is
    // left unresolved (the UI renders `—`) rather than guessing.
    const result = await listPathsLastChange(
      env as Env,
      repoId,
      "main",
      "",
      [
        { name: "a.txt", isDir: false },
        { name: "b.txt", isDir: false },
      ],
      undefined,
      { maxCommits: 1 }
    );

    expect(result?.entries["a.txt"]?.oid).toBe(c2.oid);
    expect(result?.entries["b.txt"]).toBeUndefined();
    // The walk was truncated, so no exact count is reported.
    expect(result?.commitCount).toBeUndefined();
  });

  it("resolves paths inside subdirectories", async () => {
    const { repoId, getStub } = await makeRepo("r-lc-subdir");

    const index = await createBlob("index\n");
    const nested = await createBlob("nested\n");
    const deepTree = await createTree([{ mode: "100644", name: "deep.txt", oid: nested.oid }]);
    const srcTree = await createTree([
      { mode: "100644", name: "index.ts", oid: index.oid },
      { mode: "40000", name: "deep", oid: deepTree.oid },
    ]);
    const rootTree = await createTree([{ mode: "40000", name: "src", oid: srcTree.oid }]);
    const c1 = await createCommit({ treeOid: rootTree.oid, message: "root\n" });
    await setMainRef(getStub, c1.oid);
    await packAll(repoId, getStub, [index, nested, deepTree, srcTree, rootTree, c1]);

    const result = await listPathsLastChange(env as Env, repoId, "main", "src", [
      { name: "index.ts", isDir: false },
      { name: "deep", isDir: true },
    ]);

    expect(result?.entries["index.ts"]?.oid).toBe(c1.oid);
    expect(result?.entries["deep"]?.oid).toBe(c1.oid);
  });

  it("returns null for an unresolvable ref", async () => {
    const { repoId, getStub } = await makeRepo("r-lc-noref");
    const blob = await createBlob("x\n");
    const tree = await createTree([{ mode: "100644", name: "x.txt", oid: blob.oid }]);
    const commit = await createCommit({ treeOid: tree.oid, message: "root\n" });
    await setMainRef(getStub, commit.oid);
    await packAll(repoId, getStub, [blob, tree, commit]);

    const result = await listPathsLastChange(env as Env, repoId, "no-such-branch", "", [
      { name: "x.txt", isDir: false },
    ]);
    expect(result).toBeNull();
  });
});
