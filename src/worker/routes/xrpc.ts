import type { AppContext, AppRouter } from "./hono";

import { and, eq } from "drizzle-orm";
import { namespaces, repositories, type RepositoryRow } from "@/worker/db/d1/schema";
import { getRepoStub } from "@/worker/common";
import { repoDidFor } from "@/worker/agent/dids";
import { findNamespaceBySlug, findRepositoryByNamespaceAndSlug } from "@/worker/db/d1/dal";

// Read-only Tangled-compatible XRPC surface.
//
// Implements the `sh.tangled.*` read methods against delta-git state so any
// atproto client that speaks Tangled's lexicons can enumerate and inspect
// public repos here. `repoDid` params accept either the federation DID
// (`did:dg:repo:<hash>`) or the `owner/repo` shorthand — only public repos
// are visible; private repos return the same not-found as missing ones.
//
// Pinned to the sh.tangled.repo v0 shape used by knot1 clients:
//   describeRepo → {repo:{did,name,owner,knot,createdAt}}
//   issue.list   → {issues:[{id,title,body,state,owner,createdAt}]}
//   pull.list    → {pulls:[{id,state,targetBranch,sourceBranch,author,createdAt}]}
//   list         → {repos:[{did,name,owner}]}  (non-standard but useful)

function bad(c: AppContext, reason: string, status = 400): Response {
  return c.json({ error: reason } as never, status as never);
}

interface RepoRef {
  row: RepositoryRow;
  namespaceSlug: string;
  did: string;
}

async function resolveRepoDid(c: AppContext): Promise<RepoRef | null> {
  const repoDid = c.req.query("repoDid") ?? c.req.query("repo") ?? "";
  const db = c.var.db;
  if (repoDid.startsWith("did:dg:repo:")) {
    const rows = await db.select().from(repositories).where(eq(repositories.did, repoDid)).limit(1);
    const row = rows[0];
    if (!row || row.visibility !== "public") return null;
    const ns = await db
      .select()
      .from(namespaces)
      .where(eq(namespaces.id, row.namespaceId))
      .limit(1);
    if (!ns[0]) return null;
    return { row, namespaceSlug: ns[0].slug, did: repoDid };
  }
  const [owner, repo] = repoDid.split("/");
  if (!owner || !repo) return null;
  const namespace = await findNamespaceBySlug(db, owner);
  if (!namespace) return null;
  const row = await findRepositoryByNamespaceAndSlug(db, namespace.id, repo);
  if (!row || row.visibility !== "public") return null;
  return { row, namespaceSlug: namespace.slug, did: row.did ?? (await repoDidFor(owner, repo)) };
}

export function registerXrpcRoutes(router: AppRouter): void {
  router.get("/xrpc/sh.tangled.repo.describeRepo", async (c) => {
    const ref = await resolveRepoDid(c);
    if (!ref) return bad(c, "repo-not-found", 404);
    return c.json({
      repo: {
        did: ref.did,
        name: ref.row.slug,
        owner: ref.namespaceSlug,
        knot: "delta-git",
        visibility: ref.row.visibility,
        createdAt: new Date(ref.row.createdAt).toISOString(),
      },
    });
  });

  router.get("/xrpc/sh.tangled.repo.issue.list", async (c) => {
    const ref = await resolveRepoDid(c);
    if (!ref) return bad(c, "repo-not-found", 404);
    const stub = getRepoStub(c.env, ref.row.doName);
    const rows = await stub.listWorkIntentsByKind("issue");
    return c.json({
      issues: rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body ?? "",
        state: row.status === "open" || row.status === "claimed" ? "open" : "closed",
        owner: row.createdBy,
        createdAt: new Date(row.createdAt).toISOString(),
      })),
    });
  });

  router.get("/xrpc/sh.tangled.repo.pull.list", async (c) => {
    const ref = await resolveRepoDid(c);
    if (!ref) return bad(c, "repo-not-found", 404);
    const stub = getRepoStub(c.env, ref.row.doName);
    const intents = await stub.listMergeIntents([
      "open",
      "merging",
      "adjudicating",
      "conflict",
      "merged",
      "rejected",
    ]);
    return c.json({
      pulls: intents.map((intent) => ({
        id: intent.id,
        state:
          intent.status === "merged"
            ? "merged"
            : intent.status === "rejected" || intent.status === "expired"
              ? "closed"
              : "open",
        targetBranch: intent.targetRef.replace(/^refs\/heads\//, ""),
        sourceRef: intent.deltaRef,
        deltaOid: intent.deltaOid,
        resultOid: intent.resultOid ?? null,
        conflicts: intent.conflicts ? JSON.parse(intent.conflicts) : [],
        author: intent.actor,
        createdAt: new Date(intent.createdAt).toISOString(),
      })),
    });
  });

  router.get("/xrpc/sh.tangled.repo.list", async (c) => {
    const owner = c.req.query("owner") ?? c.req.query("did") ?? "";
    const db = c.var.db;
    const namespace = await findNamespaceBySlug(db, owner);
    if (!namespace) return bad(c, "owner-not-found", 404);
    const rows = await db
      .select()
      .from(repositories)
      .where(
        and(eq(repositories.namespaceId, namespace.id), eq(repositories.visibility, "public"))
      );
    const repos = await Promise.all(
      rows.map(async (row) => ({
        did: row.did ?? (await repoDidFor(namespace.slug, row.slug)),
        name: row.slug,
        owner: namespace.slug,
        knot: "delta-git",
      }))
    );
    return c.json({ repos });
  });
}
