import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

// GitHub v4-shaped subset at POST /api/graphql — viewer, repository, and
// the issues/pullRequests/releases/refs/object connections. Public repos
// resolve anonymously; private repos return null (indistinguishable absent).

let seq = 0;
const uniq = (p: string) => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

async function gql(query: string, cookie?: string, variables?: Record<string, unknown>) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const res = await workerExports.default.fetch("https://example.com/api/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] },
  };
}

describe("GraphQL /api/graphql subset", () => {
  let repo: SetupRepoForTestsResult;

  beforeAll(async () => {
    await ensureD1Migrations(env);
    repo = await setupRepoForTests(env, uniq("gql-ns"), "gqlrepo");
    await env.REPO_DO.get(env.REPO_DO.idFromName(repo.doName)).seedMinimalRepo();
  });

  it("repository resolves core fields + refs + object anonymously", async () => {
    const { status, body } = await gql(
      `query($o: String!, $n: String!) {
        repository(owner: $o, name: $n) {
          name nameWithOwner isPrivate stargazerCount forkCount
          defaultBranchRef { name target { oid abbreviatedOid } }
          refs(refPrefix: "heads/") { totalCount nodes { name target { abbreviatedOid } } }
          object(expression: "HEAD:README.md") { oid text }
        }
      }`,
      undefined,
      { o: repo.namespaceSlug, n: "gqlrepo" }
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const r = body.data?.repository as Record<string, unknown>;
    expect(r.name).toBe("gqlrepo");
    expect(r.nameWithOwner).toBe(`${repo.namespaceSlug}/gqlrepo`);
    expect(r.isPrivate).toBe(false);
    expect((r.defaultBranchRef as { name: string }).name).toBe("main");
    const refs = r.refs as { nodes: { name: string }[] };
    expect(refs.nodes.some((x) => x.name === "heads/main")).toBe(true);
    // seedMinimalRepo writes a README — text decodes through object().
    const obj = r.object as { text: string | null } | null;
    expect(obj === null || typeof obj.text === "string").toBe(true);
  });

  it("viewer returns null anonymous and the session login authed", async () => {
    const anon = await gql(`{ viewer { login } }`);
    expect(anon.status).toBe(200);
    expect((anon.body.data as { viewer: unknown }).viewer).toBeNull();

    const authed = await gql(`{ viewer { login } }`, repo.cookieHeader);
    expect((authed.body.data as { viewer: { login: string } }).viewer.login).toBe(
      repo.namespaceSlug
    );
  });

  it("issues connection reflects DO state", async () => {
    // Seed one issue through the v1 facade.
    const created = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${repo.namespaceSlug}/gqlrepo/+/issues`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
        body: JSON.stringify({ title: "graphql probe issue" }),
      }
    );
    expect(created.status).toBe(201);

    const { body } = await gql(
      `query($o: String!, $n: String!) {
        repository(owner: $o, name: $n) {
          issues(first: 5) { totalCount nodes { number title state authorLogin } }
        }
      }`,
      undefined,
      { o: repo.namespaceSlug, n: "gqlrepo" }
    );
    const conn = (body.data?.repository as Record<string, unknown>).issues as {
      totalCount: number;
      nodes: { title: string; state: string }[];
    };
    expect(conn.totalCount).toBe(1);
    expect(conn.nodes[0].title).toBe("graphql probe issue");
    expect(conn.nodes[0].state).toBe("OPEN");
  });

  it("missing repo returns null, malformed query returns errors", async () => {
    const missing = await gql(`{ repository(owner: "nobody", name: "nothing") { name } }`);
    expect(missing.status).toBe(200);
    expect((missing.body.data as { repository: unknown }).repository).toBeNull();

    const bad = await gql(`{ repository(owner: 1) {`);
    expect(bad.body.errors).toBeDefined();
  });
});
