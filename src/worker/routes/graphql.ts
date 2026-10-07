import type { AppRouter } from "./hono";

import { getRepoStub } from "@/worker/common";
import { countForks, findRepositoryByDoName, starCount } from "@/worker/db/d1/dal";
import type { Db } from "@/worker/db/d1/client";
import type { RepositoryRow } from "@/worker/db/d1/schema/repositories";
import type { RepositoryRoute } from "@/worker/repositories/route";
import { loadViewer } from "@/worker/auth/session";
import { resolveRef, readPath } from "@/worker/git/operations/read";
import { readPrMeta } from "@/worker/api/gitness/prmeta";
import { resolveGitnessRepo, viewerCanWrite } from "@/worker/api/gitness/shared";
import type { CacheContext } from "@/worker/cache";

// GraphQL v4-shaped subset — the same curated coverage as the REST v3 shim:
// viewer, repository, and its issues/pullRequests/releases/refs/object
// connections. Schema is declared with graphql-js SDL; resolvers ride the
// default field resolver (function-valued properties are invoked lazily
// with (args, ctx, info)), so connections resolve per-query rather than
// eagerly. Private repos resolve to null — indistinguishable absent like
// everywhere else. The `graphql` package lazy-imports so ungraphed
// requests never pay its parse cost.

const SCHEMA = /* GraphQL */ `
  type Query {
    viewer: User
    repository(owner: String!, name: String!): Repository
  }

  type User {
    login: String!
  }

  type RepositoryOwner {
    id: ID!
    login: String!
  }

  type Repository {
    id: ID!
    name: String!
    nameWithOwner: String!
    owner: RepositoryOwner!
    description: String
    isPrivate: Boolean!
    url: String!
    stargazerCount: Int!
    forkCount: Int!
    createdAt: String!
    updatedAt: String!
    pushedAt: String
    defaultBranchRef: Ref
    latestRelease: Release
    issues(first: Int, states: [IssueState!]): IssueConnection!
    pullRequests(first: Int, states: [PullRequestState!]): PullRequestConnection!
    releases(first: Int): ReleaseConnection!
    refs(refPrefix: String!, first: Int): RefConnection!
    object(expression: String!): GitObject
  }

  type Ref {
    name: String!
    target: GitObject
  }

  type GitObject {
    oid: String!
    abbreviatedOid: String!
    text: String
  }

  type Issue {
    number: Int!
    title: String!
    body: String
    state: IssueState!
    stateReason: String
    authorLogin: String!
    createdAt: String!
    updatedAt: String!
    closedAt: String
    labels: [String!]!
  }

  enum IssueState {
    OPEN
    CLOSED
  }

  type IssueConnection {
    totalCount: Int!
    nodes: [Issue!]!
  }

  type PullRequest {
    number: Int!
    title: String!
    body: String
    state: PullRequestState!
    isDraft: Boolean!
    authorLogin: String!
    sourceBranch: String!
    targetBranch: String!
    createdAt: String!
    mergedAt: String
  }

  enum PullRequestState {
    OPEN
    CLOSED
    MERGED
  }

  type PullRequestConnection {
    totalCount: Int!
    nodes: [PullRequest!]!
  }

  type Release {
    tagName: String!
    name: String
    body: String
    isDraft: Boolean!
    isPrerelease: Boolean!
    createdAt: String!
  }

  type ReleaseConnection {
    totalCount: Int!
    nodes: [Release!]!
  }

  type RefConnection {
    totalCount: Int!
    nodes: [Ref!]!
  }
`;

type Ctx = { env: Env; viewer: { userId: string; primaryNamespaceSlug?: string } | null };

type RepoCtx = {
  env: Env;
  db: Db;
  route: RepositoryRoute;
  cacheCtx: CacheContext | undefined;
  canWrite: boolean;
};

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

function repoResolvers(rc: RepoCtx, row: RepositoryRow) {
  const stub = getRepoStub(rc.env, rc.route.doName);
  return {
    id: String(row.id),
    name: row.slug,
    nameWithOwner: `${rc.route.routeNamespaceSlug}/${rc.route.routeRepoSlug}`,
    owner: { id: rc.route.namespaceId, login: rc.route.routeNamespaceSlug },
    description: row.description ?? null,
    isPrivate: rc.route.visibility !== "public",
    url: `/${rc.route.routeNamespaceSlug}/${rc.route.routeRepoSlug}`,
    stargazerCount: () => starCount(rc.db, row.id),
    forkCount: () => countForks(rc.db, row.id),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    pushedAt: iso(row.updatedAt),
    defaultBranchRef: async () => {
      const { head, refs } = await stub.getHeadAndRefs();
      const name = (head?.target ?? "refs/heads/main").replace(/^refs\/heads\//, "");
      const oid = refs.find((r) => r.name === `refs/heads/${name}`)?.oid ?? "";
      return { name, target: { oid, abbreviatedOid: oid.slice(0, 7), text: null } };
    },
    latestRelease: async () => {
      const r = await stub.getLatestRelease();
      if (r.status !== "ok") return null;
      const rel = r.release;
      return {
        tagName: rel.tagName,
        name: rel.name,
        body: rel.body ?? null,
        isDraft: rel.draft === 1,
        isPrerelease: rel.prerelease === 1,
        createdAt: iso(rel.createdAt),
      };
    },
    issues: async (args: { first?: number; states?: string[] }) => {
      // GraphQL enums arrive as upper-case literals (OPEN/CLOSED).
      const states = args.states?.map((s) => s.toLowerCase());
      const wantOpen = !states || states.includes("open");
      const wantClosed = !states || states.includes("closed");
      const rows = await stub.listIssues({
        state: wantOpen && !wantClosed ? "open" : !wantOpen && wantClosed ? "closed" : undefined,
        limit: args.first ?? 30,
      });
      const nodes = rows.map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? null,
        state: i.state.toUpperCase(),
        stateReason: i.stateReason ?? null,
        authorLogin: i.author,
        createdAt: iso(i.createdAt),
        updatedAt: iso(i.updatedAt),
        closedAt: iso(i.closedAt),
        labels: i.labels.map((l) => l.name),
      }));
      return { totalCount: nodes.length, nodes };
    },
    pullRequests: async (args: { first?: number; states?: string[] }) => {
      const intents = await stub.listMergeIntents([
        "open",
        "merging",
        "adjudicating",
        "conflict",
        "merged",
        "rejected",
        "expired",
      ]);
      const sorted = intents.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      const mapped = [] as {
        number: number;
        title: string;
        body: string | null;
        state: string;
        isDraft: boolean;
        authorLogin: string;
        sourceBranch: string;
        targetBranch: string;
        createdAt: string | null;
        mergedAt: string | null;
      }[];
      for (const [i, intent] of sorted.entries()) {
        const meta = await readPrMeta(rc.env, rc.route.doName, intent.id).catch(() => null);
        const state =
          intent.status === "merged"
            ? "MERGED"
            : intent.status === "open" ||
                intent.status === "merging" ||
                intent.status === "adjudicating" ||
                intent.status === "conflict"
              ? "OPEN"
              : "CLOSED";
        if (args.states && !args.states.includes(state)) continue;
        mapped.push({
          number: i + 1,
          title: meta?.title ?? `Intent ${intent.id}`,
          body: meta?.description ?? null,
          state,
          isDraft: meta?.draft === true,
          authorLogin: intent.actor,
          sourceBranch: intent.deltaRef.replace(/^refs\/(heads|delta)\//, ""),
          targetBranch: intent.targetRef.replace(/^refs\/heads\//, ""),
          createdAt: iso(intent.createdAt),
          mergedAt: intent.status === "merged" ? iso(intent.resolvedAt) : null,
        });
      }
      const nodes = mapped.slice(0, args.first ?? 30);
      return { totalCount: nodes.length, nodes };
    },
    releases: async (args: { first?: number }) => {
      const rows = await stub.listReleases({ includeDrafts: rc.canWrite });
      const nodes = rows.slice(0, args.first ?? 30).map((r) => ({
        tagName: r.tagName,
        name: r.name,
        body: r.body ?? null,
        isDraft: r.draft === 1,
        isPrerelease: r.prerelease === 1,
        createdAt: iso(r.createdAt),
      }));
      return { totalCount: nodes.length, nodes };
    },
    refs: async (args: { refPrefix: string; first?: number }) => {
      const { refs } = await stub.getHeadAndRefs();
      const prefix = args.refPrefix.startsWith("refs/") ? args.refPrefix : `refs/${args.refPrefix}`;
      const nodes = refs
        .filter((r) => r.name.startsWith(prefix))
        .slice(0, args.first ?? 30)
        .map((r) => ({
          name: r.name.replace(/^refs\//, ""),
          target: { oid: r.oid, abbreviatedOid: r.oid.slice(0, 7), text: null },
        }));
      return { totalCount: nodes.length, nodes };
    },
    // GitHub `object(expression:)`: "ref:path" or "ref" (commit oid) or
    // ":path" (default ref). Blob → text when UTF-8-decodable, else null.
    object: async (args: { expression: string }) => {
      const m = /^([^:]*)(?::(.*))?$/.exec(args.expression);
      if (!m) return null;
      const refPart = m[1] || "HEAD";
      const path = m[2];
      const oid = await resolveRef(rc.env, rc.route.doName, refPart, rc.cacheCtx);
      if (!oid) return null;
      if (!path) return { oid, abbreviatedOid: oid.slice(0, 7), text: null };
      const hit = await readPath(rc.env, rc.route.doName, refPart, path, rc.cacheCtx).catch(
        () => null
      );
      if (!hit) return null;
      // Tree results don't expose their own oid — report the resolved commit.
      if (hit.type === "tree") return { oid, abbreviatedOid: oid.slice(0, 7), text: null };
      if (hit.type !== "blob") return null;
      let text: string | null = null;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(hit.content);
      } catch {
        text = null; // binary blob — GitHub returns null text too
      }
      return { oid: hit.oid, abbreviatedOid: hit.oid.slice(0, 7), text };
    },
  };
}

export function registerGraphqlRoutes(router: AppRouter): void {
  router.post("/api/graphql", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      query?: string;
      variables?: Record<string, unknown>;
      operationName?: string;
    } | null;
    if (!body?.query || typeof body.query !== "string") {
      return c.json({ errors: [{ message: "query required" }] }, 400);
    }
    // Query size bound — deep/nested documents can amplify DO RPCs; the
    // subset schema keeps honest queries small.
    if (body.query.length > 32 * 1024) {
      return c.json({ errors: [{ message: "query too large" }] }, 413);
    }

    const viewer = await loadViewer(c);
    const ctx: Ctx = { env: c.env, viewer };

    const rootValue = {
      viewer: () =>
        ctx.viewer && ctx.viewer.primaryNamespaceSlug
          ? { login: ctx.viewer.primaryNamespaceSlug }
          : null,
      repository: async (args: { owner: string; name: string }) => {
        // resolveGitnessRepo owns visibility + membership rules — a private
        // repo the viewer can't read resolves to null (indistinguishable
        // absent), and authed members keep working.
        const access = await resolveGitnessRepo(c, `${args.owner}/${args.name}/+`).catch(
          () => null
        );
        if (!access || access.kind !== "ok") return null;
        const row = await findRepositoryByDoName(c.var.db, access.route.doName);
        if (!row) return null;
        const canWrite = await viewerCanWrite(c, access).catch(() => false);
        return repoResolvers(
          {
            env: c.env,
            db: c.var.db,
            route: access.route,
            cacheCtx: access.cacheCtx,
            canWrite,
          },
          row
        );
      },
    };

    const { graphql, buildSchema } = await import("graphql");
    const schema = buildSchema(SCHEMA);
    const result = await graphql({
      schema,
      source: body.query,
      rootValue,
      contextValue: ctx,
      variableValues: body.variables,
      operationName: body.operationName,
    });
    return c.json(result, 200);
  });
}
