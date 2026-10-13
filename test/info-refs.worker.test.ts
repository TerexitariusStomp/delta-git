import { it, expect } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { uniqueRepoId } from "./util/test-helpers";
import { setupRepoForTests } from "./util/repoSeed";
import { decodePktLinePayloads } from "./util/fetch-protocol";

it("advertises upload-pack v2 over info/refs", async () => {
  const owner = "o";
  const repo = uniqueRepoId("r-info-refs");
  await setupRepoForTests(env, owner, repo);

  const url = new URL(`https://example.com/${owner}/${repo}/info/refs`);
  url.searchParams.set("service", "git-upload-pack");
  const res = await workerExports.default.fetch(new Request(url, { method: "GET" }));
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("git-upload-pack-advertisement");
  const bytes = new Uint8Array(await res.arrayBuffer());
  // The v2 prelude should start with an announcement and a flush, then version/agent lines
  const textLines = decodePktLinePayloads(bytes);
  // Look for "version 2" and the "fetch" command advertised with its
  // protocol-v2 features (shallow/deepen-not/filter/wait-for-done).
  expect(textLines.some((l) => l === "version 2\n")).toBe(true);
  expect(textLines.some((l) => l.startsWith("fetch="))).toBe(true);
  // And the features we advertise
  expect(textLines.some((l) => l === "ofs-delta\n")).toBe(true);
  expect(textLines.some((l) => l === "side-band-64k\n")).toBe(true);
});

it("anonymous clone of a public artifacts repo redirects with a read token", async () => {
  const owner = "o";
  const repo = uniqueRepoId("r-artifacts-anon");
  const seeded = await setupRepoForTests(env, owner, repo);

  // Opt the seeded repo into the artifacts backend — production sets these
  // at create time through the ARTIFACTS binding; the row is the authority
  // the route resolver reads.
  const { createDb } = await import("../src/worker/db/d1");
  const { repositories } = await import("../src/worker/db/d1/schema");
  const { eq } = await import("drizzle-orm");
  const db = createDb(env.DB);
  await db
    .update(repositories)
    .set({
      backend: "artifacts",
      artifactsName: `dg-${seeded.repositoryId.slice("repo_".length)}`,
      artifactsRemote: "https://acct.artifacts.cloudflare.net/git/delta-git/x.git",
    })
    .where(eq(repositories.id, seeded.repositoryId))
    .run();
  const check = await db
    .select({ backend: repositories.backend, remote: repositories.artifactsRemote })
    .from(repositories)
    .where(eq(repositories.id, seeded.repositoryId))
    .get();
  expect(check?.backend).toBe("artifacts");

  const { resolveRepositoryRoute } = await import("../src/worker/repositories/route");
  const direct = await resolveRepositoryRoute(env, owner, repo);
  expect(direct?.backend).toBe("artifacts");

  const url = new URL(`https://example.com/${owner}/${repo}/info/refs`);
  url.searchParams.set("service", "git-upload-pack");
  const res = await workerExports.default.fetch(
    new Request(url, { method: "GET", redirect: "manual" })
  );
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("Location")!);
  expect(location.pathname).toBe("/git/delta-git/x.git/info/refs");
  // Anonymous read → short-lived token embedded in the redirect userinfo
  // when the ARTIFACTS binding can mint; absent binding → bare redirect.
  if (location.username) {
    expect(location.username).toBe("x-access-token");
    expect(location.password.length).toBeGreaterThan(0);
  }

  // Push discovery never embeds a token — write scope is never granted anon.
  url.searchParams.set("service", "git-receive-pack");
  const push = await workerExports.default.fetch(
    new Request(url, { method: "GET", redirect: "manual" })
  );
  // Anonymous pushes are challenged before the redirect is reached.
  expect(push.status).toBe(401);
});

it("advertises upload-pack v2 over .git info/refs", async () => {
  const owner = "o";
  const repo = uniqueRepoId("r-info-refs-dotgit");
  await setupRepoForTests(env, owner, repo);

  const url = new URL(`https://example.com/${owner}/${repo}.git/info/refs`);
  url.searchParams.set("service", "git-upload-pack");
  const res = await workerExports.default.fetch(new Request(url, { method: "GET" }));
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("git-upload-pack-advertisement");
});
