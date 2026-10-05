// Gitness facade: pull-request endpoints backed by merge intents.
//
// delta-git has no hand-authored PRs — divergence from concurrent pushes is
// captured as merge intents (see S0.5 in pullreq.ts). Numbering: gitness PRs
// are addressed by ordinal; intents are addressed by id. We derive a stable
// number as the intent's position in createdAt order across all statuses —
// deterministic for a given repo state, good enough for URL stability during
// a session. A per-repo PR sequence can replace this later without changing
// the route surface.
//
// Write endpoints map where they can:
//   - POST /pullreq/{n}/merge      → merge engine `attemptMerge`
//   - PUT /pullreq/{n}/file-views  → ROUTES KV marker per (repo, intent, user)
//   - POST /pullreq, /state, PATCH → 501: intents are minted by divergent
//     pushes, not by a form; closing an intent has no user verb today.

import type { AppRouter } from "@/worker/routes/hono";
import type { MergeIntentRow } from "@/worker/do/repo/db/schema";
import { getRepoStub } from "@/worker/common";
import { getHeadAndRefs, listCommitsFirstParentRange } from "@/worker/git/operations/read";
import { attemptMerge } from "@/worker/merge/engine";
import { mergeIntentToPullReq } from "./pullreq";
import {
  gErr,
  gNotFound,
  gStub,
  numericId,
  pageParams,
  paginate,
  resolveGitnessRepo,
  setPageHeaders,
  toGitnessCommit,
  type GitnessRepoAccess,
} from "./shared";

const ALL_STATUSES = [
  "open",
  "merging",
  "adjudicating",
  "conflict",
  "merged",
  "rejected",
  "expired",
];
const STATUS_BY_GITNESS: Record<string, string[]> = {
  open: ["open", "merging", "adjudicating", "conflict"],
  merged: ["merged"],
  closed: ["rejected", "expired"],
};
const FILE_VIEW_TTL_S = 60 * 60 * 24 * 30;

type ResolvedRepo = Extract<GitnessRepoAccess, { kind: "ok" }>;

/** Every intent ordered by createdAt — numbering is positional in this list. */
async function allIntentsOrdered(access: ResolvedRepo, env: Env): Promise<MergeIntentRow[]> {
  const stub = getRepoStub(env, access.route.doName);
  const intents = await stub.listMergeIntents(ALL_STATUSES);
  return intents.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

async function intentByNumber(
  access: ResolvedRepo,
  env: Env,
  n: number
): Promise<MergeIntentRow | undefined> {
  const all = await allIntentsOrdered(access, env);
  return n >= 1 && n <= all.length ? all[n - 1] : undefined;
}

function fileViewKey(repoId: string, intentId: string, userId: string): string {
  return `gfv:${repoId}:${intentId}:${userId}`;
}

export function registerGitnessPullreqs(router: AppRouter) {
  // `/pullreq/candidates` must precede `/pullreq/:n` (literal beats param only
  // if registered first under the greedy `:repo_ref{.+}` parent).
  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/candidates", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const { refs } = await getHeadAndRefs(c.env, access.route.doName, access.cacheCtx);
    // Delta refs are the PR-able branches on this forge.
    const candidates = refs
      .filter((r) => r.name.startsWith("refs/delta/"))
      .map((r) => ({
        name: r.name.slice("refs/".length),
        created: 0,
        updated: 0,
        created_by: 0,
        updated_by: 0,
        last_created_pull_req_id: null,
      }));
    return c.json(candidates);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/pullreq", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const all = await allIntentsOrdered(access, c.env);
    const wanted = c.req.queries("state") ?? c.req.queries("state[]") ?? ["open"];
    const wantedSet = new Set(wanted.flatMap((s) => STATUS_BY_GITNESS[s] ?? []));
    const filtered = all.filter((i) => wantedSet.has(i.status));
    const page = pageParams(c);
    setPageHeaders(c, page, filtered.length);
    // Number comes from the full ordering, not the filtered view.
    return c.json(
      paginate(filtered, page).map((i) =>
        mergeIntentToPullReq({ intent: i, number: all.indexOf(i) + 1 })
      )
    );
  });

  // Branch-pair lookup (`/pullreq/{target}...{source}`) and numeric lookup
  // share the `:pullreq_number` segment — dispatch on the `...` marker.
  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:pullreq_number", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const param = c.req.param("pullreq_number");
    if (param.includes("...")) {
      const [target, source] = param.split("...");
      const all = await allIntentsOrdered(access, c.env);
      const idx = all.findIndex(
        (i) => i.targetRef === `refs/heads/${target}` && i.deltaRef.endsWith(source)
      );
      if (idx < 0) return gNotFound(c, "pull request");
      return c.json(mergeIntentToPullReq({ intent: all[idx], number: idx + 1 }));
    }
    const n = parseInt(param, 10);
    if (!Number.isFinite(n)) return gNotFound(c, "pull request");
    const all = await allIntentsOrdered(access, c.env);
    const intent = n >= 1 && n <= all.length ? all[n - 1] : undefined;
    if (!intent) return gNotFound(c, "pull request");
    return c.json(mergeIntentToPullReq({ intent, number: n }));
  });

  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/activities", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const n = parseInt(c.req.param("n"), 10);
    const all = await allIntentsOrdered(access, c.env);
    const intent = n >= 1 && n <= all.length ? all[n - 1] : undefined;
    if (!intent) return gNotFound(c, "pull request");
    const stub = getRepoStub(c.env, access.route.doName);
    const votes = await stub.listMergeVotes(intent.id).catch(() => []);
    const activities = [
      {
        id: 1,
        order: 1,
        type: "state-change",
        kind: "system",
        text: "",
        author: {
          id: numericId(intent.actor),
          uid: intent.actor,
          display_name: intent.actor,
          type: "user",
        },
        created: intent.createdAt,
        edited: intent.createdAt,
        updated: intent.createdAt,
        deleted: null,
        resolved: null,
        parent_id: null,
        payload: { old: "", new: "open" },
      },
      ...votes.map((v, i) => ({
        id: 10 + i,
        order: 10 + i,
        type: "review-submit",
        kind: "system",
        text: `adjudication vote (seat ${v.seat})`,
        author: {
          id: numericId(v.voterDid),
          uid: v.voterDid,
          display_name: v.voterDid,
          type: "user",
        },
        created: v.createdAt ?? intent.createdAt,
        edited: v.createdAt ?? intent.createdAt,
        updated: v.createdAt ?? intent.createdAt,
        deleted: null,
        resolved: null,
        parent_id: null,
        payload: {},
      })),
      ...(intent.resolvedAt
        ? [
            {
              id: 2,
              order: 2,
              type: "state-change",
              kind: "system",
              text: "",
              author: {
                id: numericId(intent.actor),
                uid: intent.actor,
                display_name: intent.actor,
                type: "user",
              },
              created: intent.resolvedAt,
              edited: intent.resolvedAt,
              updated: intent.resolvedAt,
              deleted: null,
              resolved: null,
              parent_id: null,
              payload: { old: "open", new: intent.status },
            },
          ]
        : []),
    ].sort((a, b) => a.created - b.created || a.order - b.order);
    return c.json(activities);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/commits", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const n = parseInt(c.req.param("n"), 10);
    const intent = await intentByNumber(access, c.env, n);
    if (!intent) return gNotFound(c, "pull request");
    // Commits unique to the delta side: first-parent walk from deltaOid back
    // to baseOid, bounded — the delta itself is usually small.
    const commits = await listCommitsFirstParentRange(
      c.env,
      access.route.doName,
      intent.deltaOid,
      0,
      200,
      access.cacheCtx
    ).catch(() => []);
    const unique = commits.filter((cm) => {
      void cm;
      return true;
    });
    // Stop at the merge base if the walk overruns it.
    const cut = unique.findIndex((cm) => cm.oid === intent.baseOid);
    const scoped = cut >= 0 ? unique.slice(0, cut) : unique;
    return c.json(scoped.map(toGitnessCommit));
  });

  // --- merge -------------------------------------------------------------

  router.post("/api/v1/repos/:repo_ref{.+}/pullreq/:n/merge", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const n = parseInt(c.req.param("n"), 10);
    const intent = await intentByNumber(access, c.env, n);
    if (!intent) return gNotFound(c, "pull request");
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await attemptMerge({
      env: c.env,
      repoId: access.route.doName,
      stub,
      intentId: intent.id,
      actor: access.viewer.primaryNamespaceSlug ?? access.viewer.userId,
      cacheCtx: access.cacheCtx,
    });
    switch (result.kind) {
      case "merged":
        return c.json({ mergeable: true, sha: result.mergeOid });
      case "conflict":
        return c.json({ mergeable: false, conflict_files: result.conflicts });
      case "up_to_date":
        return c.json({ mergeable: true });
      case "base_moved":
        return gErr(c, 409, `target branch moved to ${result.currentOid}`);
      case "skipped":
        return gErr(c, 409, result.reason);
      default:
        return gErr(c, 422, `merge failed: ${result.kind}`);
    }
  });

  // --- file views (per-user read markers, KV-backed) ------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/file-views", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return c.json([]);
    const n = parseInt(c.req.param("n"), 10);
    const intent = await intentByNumber(access, c.env, n);
    if (!intent) return gNotFound(c, "pull request");
    const key = fileViewKey(access.route.doName, intent.id, access.viewer.userId);
    const listed = await c.env.ROUTES.list({ prefix: `${key}:` });
    return c.json(
      listed.keys.map((k) => ({
        path: k.name.slice(key.length + 1),
        sha: "",
        obsolete: false,
      }))
    );
  });

  router.put("/api/v1/repos/:repo_ref{.+}/pullreq/:n/file-views", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const n = parseInt(c.req.param("n"), 10);
    const intent = await intentByNumber(access, c.env, n);
    if (!intent) return gNotFound(c, "pull request");
    const body = (await c.req.json().catch(() => null)) as { path?: string; sha?: string } | null;
    if (!body?.path) return gErr(c, 400, "path required");
    const key = `${fileViewKey(access.route.doName, intent.id, access.viewer.userId)}:${body.path}`;
    await c.env.ROUTES.put(key, body.sha ?? "", {
      expirationTtl: FILE_VIEW_TTL_S,
    });
    return c.json({ path: body.path, sha: body.sha ?? "", obsolete: false });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/pullreq/:n/file-views/:file_path{.+}", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const n = parseInt(c.req.param("n"), 10);
    const intent = await intentByNumber(access, c.env, n);
    if (!intent) return gNotFound(c, "pull request");
    const key = `${fileViewKey(access.route.doName, intent.id, access.viewer.userId)}:${c.req.param("file_path")}`;
    await c.env.ROUTES.delete(key);
    return c.json({});
  });

  // --- honest stubs ---------------------------------------------------------

  // Intents are minted by pushes, not forms. State transitions ride the merge
  // engine and adjudication quorum — there is no user-level close/retitle.
  router.post("/api/v1/repos/:repo_ref{.+}/pullreq", async (c) =>
    gStub(c, "creating pull requests (push a delta ref instead)")
  );
  router.post("/api/v1/repos/:repo_ref{.+}/pullreq/:n/state", async (c) =>
    gStub(c, "pull request state change")
  );
  router.patch("/api/v1/repos/:repo_ref{.+}/pullreq/:n", async (c) =>
    gStub(c, "pull request update")
  );
  for (const [method, tail] of [
    ["put", "automerge"],
    ["delete", "automerge"],
    ["post", "branch"],
    ["delete", "branch"],
    ["post", "revert"],
    ["put", "target-branch"],
    ["put", "labels"],
    ["delete", "labels/:label_id"],
    ["post", "comments/apply-suggestions"],
    ["post", "comments/:comment_id/reactions/:emoji"],
    ["delete", "comments/:comment_id/reactions/:emoji"],
  ] as const) {
    router[method](`/api/v1/repos/:repo_ref{.+}/pullreq/:n/${tail}`, async (c) =>
      gStub(c, "this pull-request operation")
    );
  }
}
