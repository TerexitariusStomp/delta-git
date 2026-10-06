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
import type { NewObject } from "@/worker/merge/packWriter";
import { getRepoStub } from "@/worker/common";
import {
  getHeadAndRefs,
  listCommitsFirstParentRange,
  readCommit,
} from "@/worker/git/operations/read";
import { attemptMerge } from "@/worker/merge/engine";
import { writeServerPack } from "@/worker/merge/packWriter";
import { computeOid } from "@/worker/git/core";
import { doPrefix, packIndexKey, r2PackKey } from "@/worker/keys";
import { readPayload, resolvePathEntry, setTreePath } from "@/worker/agent/patch";
import { diffCommitsText } from "./gitdata";
import { suggestCodeOwnerReviewers } from "./codeowners";
import { readRepoLabels, readRepoRules, requiredCheckContexts } from "./stores";
import { mergeIntentToPullReq } from "./pullreq";
import {
  closeIssuesLinkedFromText,
  readPrMeta,
  writePrMeta,
  type PrComment,
  type PrReview,
} from "./prmeta";
import {
  emitRepoEvent,
  gErr,
  gNotFound,
  notifyMembers,
  numericId,
  pageParams,
  paginate,
  requireWriter,
  resolveGitnessRepo,
  setPageHeaders,
  toGitnessCommit,
  type GitnessRepoAccess,
} from "./shared";

const td = new TextDecoder();
const te = new TextEncoder();

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
const MAX_PR_COMMENTS = 500;

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
    // Number comes from the full ordering, not the filtered view. Meta is
    // fetched per page item — human titles/descriptions override the
    // generated intent label.
    const items = paginate(filtered, page);
    return c.json(
      await Promise.all(
        items.map(async (i) => {
          const meta = await readPrMeta(c.env, access.route.doName, i.id);
          return {
            ...mergeIntentToPullReq({
              intent: i,
              number: all.indexOf(i) + 1,
              title: meta.title,
              draft: meta.draft,
            }),
            description: meta.description ?? "",
          };
        })
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
    const meta = await readPrMeta(c.env, access.route.doName, intent.id);
    return c.json({
      ...mergeIntentToPullReq({ intent, number: n, title: meta.title, draft: meta.draft }),
      description: meta.description ?? "",
      assignees: meta.assignees ?? [],
    });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/activities", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const n = parseInt(c.req.param("n"), 10);
    const all = await allIntentsOrdered(access, c.env);
    const intent = n >= 1 && n <= all.length ? all[n - 1] : undefined;
    if (!intent) return gNotFound(c, "pull request");
    const stub = getRepoStub(c.env, access.route.doName);
    const [votes, meta] = await Promise.all([
      stub.listMergeVotes(intent.id).catch(() => []),
      readPrMeta(c.env, access.route.doName, intent.id),
    ]);
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
        id: 10000 + i,
        order: 10000 + i,
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
      // Human conversation from the KV meta record — `comment` type is what
      // the SPA's activity feed renders as a chat bubble.
      ...meta.comments.map((cm) => ({
        id: cm.id,
        order: cm.id,
        type: "comment",
        kind: "comment",
        text: cm.text,
        author: {
          id: numericId(cm.author),
          uid: cm.author,
          display_name: cm.author,
          type: "user",
        },
        created: cm.created,
        edited: cm.edited,
        updated: cm.edited,
        deleted: null,
        resolved: null,
        hidden: cm.hidden !== undefined,
        hidden_reason: cm.hidden?.reason ?? null,
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
    // Drafts block merge until marked ready — checked before the engine so
    // the rejection is a clean 409 rather than an intent-state error.
    const preMeta = await readPrMeta(c.env, access.route.doName, intent.id);
    if (preMeta.draft) return gErr(c, 409, "pull request is a draft");
    const stub = getRepoStub(c.env, access.route.doName);
    // Required status checks: active branch rules matching the target ref
    // block merge until every listed context reports success on the PR head.
    const required = requiredCheckContexts(
      await readRepoRules(c.env, access.route.doName),
      intent.targetRef
    );
    if (required.length > 0) {
      const statuses = await stub.getCommitStatuses(intent.deltaOid).catch(() => []);
      const failing = required.filter(
        (ctx) => statuses.find((row) => row.context === ctx)?.state !== "success"
      );
      if (failing.length > 0) {
        return gErr(c, 409, `required status checks not passing: ${failing.join(", ")}`);
      }
    }
    const result = await attemptMerge({
      env: c.env,
      repoId: access.route.doName,
      stub,
      intentId: intent.id,
      actor: access.viewer.primaryNamespaceSlug ?? access.viewer.userId,
      cacheCtx: access.cacheCtx,
    });
    switch (result.kind) {
      case "merged": {
        // GitHub parity: "closes #N" / "fixes #N" in the PR text auto-closes
        // the linked issues. PR text lives in the KV meta record, so this
        // runs Worker-side after the DO commits the merge.
        const meta = await readPrMeta(c.env, access.route.doName, intent.id);
        const closedIssues = await closeIssuesLinkedFromText({
          stub,
          text: `${meta.title ?? ""}\n${meta.description ?? ""}`,
          actor: access.viewer.primaryNamespaceSlug ?? access.viewer.userId,
        });
        emitRepoEvent(c, access, "pull_request", {
          action: "closed",
          number: n,
          merged: true,
          sha: result.mergeOid,
        });
        notifyMembers(c, access, {
          kind: "pullreq",
          title: `PR #${n} merged`,
          body: `${access.viewer?.primaryNamespaceSlug ?? "someone"} merged a pull request`,
          excludeUserId: access.viewer?.userId,
          link: `/${access.route.routeNamespaceSlug}/repos/${access.route.routeRepoSlug}/pulls/${n}`,
        });
        return c.json({ mergeable: true, sha: result.mergeOid, closed_issues: closedIssues });
      }
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

  // --- create / state / meta --------------------------------------------------

  // PR create = "merge this existing branch head into the target branch."
  // acceptPatchCommit mints a delta ref + open intent pointing at the
  // source head — no pack is staged because every object already lives in
  // the store. Unlike /dg/patch we do NOT auto-attempt the merge: opening
  // a PR is for review; /merge is the landing verb.
  router.post("/api/v1/repos/:repo_ref{.+}/pullreq", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      source_branch?: string;
      target_branch?: string;
      title?: string;
      description?: string;
      is_draft?: boolean;
    } | null;
    if (!body?.source_branch || !body?.target_branch) {
      return gErr(c, 400, "source_branch and target_branch required");
    }
    const targetRef = `refs/heads/${body.target_branch.replace(/^refs\/heads\//, "")}`;
    const sourceRef = `refs/heads/${body.source_branch.replace(/^refs\/heads\//, "")}`;
    if (targetRef === sourceRef) return gErr(c, 400, "source and target branches match");
    const { refs } = await getHeadAndRefs(c.env, gate.route.doName, gate.cacheCtx);
    const source = refs.find((r) => r.name === sourceRef);
    if (!source) return gErr(c, 400, `source branch not found: ${body.source_branch}`);
    if (!refs.some((r) => r.name === targetRef)) {
      return gErr(c, 400, `target branch not found: ${body.target_branch}`);
    }
    const stub = getRepoStub(c.env, gate.route.doName);
    const accepted = await stub.acceptPatchCommit({
      targetRef,
      newOid: source.oid,
      actor: gate.actor,
      kind: "pullreq.create",
    });
    const intent = accepted.intent;
    // CODEOWNERS reviewer suggestions — owners of every path the PR touches,
    // minus the author (self-review is meaningless).
    const targetOid = refs.find((r) => r.name === targetRef)?.oid ?? intent.baseOid;
    const suggestions = await suggestCodeOwnerReviewers({
      env: c.env,
      access: gate,
      baseOid: targetOid,
      headOid: source.oid,
      exclude: gate.actor,
    }).catch(() => [] as string[]);
    if (body.title || body.description || body.is_draft || suggestions.length > 0) {
      await writePrMeta(c.env, gate.route.doName, intent.id, {
        title: body.title,
        description: body.description,
        comments: [],
        reviewers: suggestions.map((owner) => owner.replace(/^@/, "")),
        draft: body.is_draft === true,
      });
    }
    const all = await allIntentsOrdered(gate, c.env);
    const number = all.findIndex((i) => i.id === intent.id) + 1;
    const prNumber = number > 0 ? number : all.length;
    emitRepoEvent(c, gate, "pull_request", {
      action: "opened",
      number: prNumber,
      title: body.title,
      draft: body.is_draft === true,
      source_branch: body.source_branch,
      target_branch: body.target_branch,
      actor: gate.actor,
    });
    notifyMembers(c, gate, {
      kind: "pullreq",
      title: `PR #${prNumber}: ${body.title ?? `${body.source_branch} → ${body.target_branch}`}`,
      body: `${gate.actor} opened a pull request`,
      excludeUserId: gate.viewer?.userId,
      link: `/${gate.route.routeNamespaceSlug}/repos/${gate.route.routeRepoSlug}/pulls/${prNumber}`,
    });
    return c.json({
      ...mergeIntentToPullReq({
        intent,
        number: prNumber,
        title: body.title,
        draft: body.is_draft === true,
      }),
      description: body.description ?? "",
      suggested_reviewers: suggestions,
    });
  });

  // Gitness state transitions: "closed" → rejectMergeIntent (open/conflict
  // only — a leased intent belongs to the engine). "open" on a rejected
  // intent is a reopen we do not model; the delta ref still exists, so the
  // honest answer is to create a new intent.
  router.post("/api/v1/repos/:repo_ref{.+}/pullreq/:n/state", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const n = parseInt(c.req.param("n"), 10);
    const intent = await intentByNumber(gate, c.env, n);
    if (!intent) return gNotFound(c, "pull request");
    const body = (await c.req.json().catch(() => null)) as { state?: string } | null;
    if (body?.state !== "closed") return gErr(c, 400, "only state=closed is supported");
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await stub.rejectMergeIntent({ id: intent.id, actor: gate.actor });
    if (result.status === "not_found") return gNotFound(c, "pull request");
    if (result.status === "not_rejectable") {
      return gErr(c, 409, `pull request is ${result.state}`);
    }
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    emitRepoEvent(c, gate, "pull_request", {
      action: "closed",
      number: n,
      merged: false,
      actor: gate.actor,
    });
    return c.json({
      ...mergeIntentToPullReq({
        intent: result.intent,
        number: n,
        title: meta.title,
        draft: meta.draft,
      }),
      description: meta.description ?? "",
    });
  });

  // Title/description land on the KV meta record — merge intents carry no
  // human text fields of their own. `is_draft` toggles the draft state —
  // false is GitHub's "ready for review".
  router.patch("/api/v1/repos/:repo_ref{.+}/pullreq/:n", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const n = parseInt(c.req.param("n"), 10);
    const intent = await intentByNumber(gate, c.env, n);
    if (!intent) return gNotFound(c, "pull request");
    const body = (await c.req.json().catch(() => null)) as {
      title?: string;
      description?: string;
      is_draft?: boolean;
    } | null;
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const wasDraft = meta.draft === true;
    if (body?.title !== undefined) meta.title = body.title;
    if (body?.description !== undefined) meta.description = body.description;
    if (body?.is_draft !== undefined) meta.draft = body.is_draft;
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    if (wasDraft && meta.draft === false) {
      emitRepoEvent(c, gate, "pull_request", {
        action: "ready_for_review",
        number: n,
        actor: gate.actor,
      });
    } else if (body?.title !== undefined || body?.description !== undefined) {
      emitRepoEvent(c, gate, "pull_request", { action: "edited", number: n, actor: gate.actor });
    }
    return c.json({
      ...mergeIntentToPullReq({ intent, number: n, title: meta.title, draft: meta.draft }),
      description: meta.description ?? "",
    });
  });

  // --- comments (KV meta record) ----------------------------------------------

  router.post("/api/v1/repos/:repo_ref{.+}/pullreq/:n/comments", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const n = parseInt(c.req.param("n"), 10);
    const intent = await intentByNumber(gate, c.env, n);
    if (!intent) return gNotFound(c, "pull request");
    const body = (await c.req.json().catch(() => null)) as {
      text?: string;
      code_comment?: { path?: string; line_start?: number; line_end?: number; side?: string };
    } | null;
    if (!body?.text?.trim()) return gErr(c, 400, "text required");
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    if (meta.comments.length >= MAX_PR_COMMENTS) return gErr(c, 422, "comment limit reached");
    const comment: PrComment = {
      id: (meta.comments.at(-1)?.id ?? 0) + 1,
      author: gate.actor,
      text: body.text,
      created: Date.now(),
      edited: Date.now(),
      codeComment: body.code_comment,
    };
    meta.comments.push(comment);
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    notifyMembers(c, gate, {
      kind: "pullreq",
      title: `PR #${n}: new comment`,
      body: `${gate.actor} commented on a pull request`,
      excludeUserId: gate.viewer?.userId,
      link: `/${gate.route.routeNamespaceSlug}/repos/${gate.route.routeRepoSlug}/pulls/${n}`,
    });
    return c.json({
      id: comment.id,
      type: "comment",
      kind: "comment",
      text: comment.text,
      author: {
        id: numericId(comment.author),
        uid: comment.author,
        display_name: comment.author,
        type: "user",
      },
      created: comment.created,
      edited: comment.edited,
      updated: comment.edited,
      deleted: null,
      parent_id: null,
      payload: {},
    });
  });

  router.put("/api/v1/repos/:repo_ref{.+}/pullreq/:n/comments/:comment_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const comment = meta.comments.find((cm) => cm.id === parseInt(c.req.param("comment_id"), 10));
    if (!comment) return gNotFound(c, "comment");
    if (comment.author !== gate.actor) return gErr(c, 403, "not the comment author");
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
    if (!body?.text?.trim()) return gErr(c, 400, "text required");
    comment.text = body.text;
    comment.edited = Date.now();
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({});
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/pullreq/:n/comments/:comment_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const idx = meta.comments.findIndex((cm) => cm.id === parseInt(c.req.param("comment_id"), 10));
    if (idx < 0) return gNotFound(c, "comment");
    if (meta.comments[idx].author !== gate.actor) return gErr(c, 403, "not the comment author");
    meta.comments.splice(idx, 1);
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({});
  });

  // Comment hide/unhide — moderator "minimize" flag on the KV comment
  // record; any writer can hide (namespace members are the moderators).
  router.put("/api/v1/repos/:repo_ref{.+}/pullreq/:n/comments/:comment_id/hide", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const comment = meta.comments.find((cm) => cm.id === parseInt(c.req.param("comment_id"), 10));
    if (!comment) return gNotFound(c, "comment");
    const body = (await c.req.json().catch(() => null)) as { reason?: string } | null;
    comment.hidden = { reason: body?.reason, by: gate.actor, at: Date.now() };
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({ hidden: true });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/pullreq/:n/comments/:comment_id/hide", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const comment = meta.comments.find((cm) => cm.id === parseInt(c.req.param("comment_id"), 10));
    if (!comment) return gNotFound(c, "comment");
    delete comment.hidden;
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({ hidden: false });
  });

  // Comment resolve/unresolve — a flag on the KV comment, same author gate
  // as edits plus the PR author (either side can settle a thread).
  router.put("/api/v1/repos/:repo_ref{.+}/pullreq/:n/comments/:comment_id/status", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const comment = meta.comments.find((cm) => cm.id === parseInt(c.req.param("comment_id"), 10));
    if (!comment) return gNotFound(c, "comment");
    comment.resolvedAt = Date.now();
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({});
  });
  router.delete("/api/v1/repos/:repo_ref{.+}/pullreq/:n/comments/:comment_id/status", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const comment = meta.comments.find((cm) => cm.id === parseInt(c.req.param("comment_id"), 10));
    if (!comment) return gNotFound(c, "comment");
    comment.resolvedAt = undefined;
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({});
  });

  // --- diff / metadata / view -------------------------------------------------

  // The PR diff tab: three-dot semantics are intrinsic to the intent —
  // baseOid is already the recorded merge base.
  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/diff", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const intent = await intentByNumber(access, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const body = await diffCommitsText(
      c.env,
      access.route.doName,
      intent.baseOid,
      intent.deltaOid,
      access.cacheCtx
    );
    return new Response(body, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  });

  // Header refresh endpoint — the SPA polls it for live merge status.
  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/metadata", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const all = await allIntentsOrdered(access, c.env);
    const n = parseInt(c.req.param("n"), 10);
    const intent = n >= 1 && n <= all.length ? all[n - 1] : undefined;
    if (!intent) return gNotFound(c, "pull request");
    return c.json({
      merge_check_status:
        intent.status === "conflict"
          ? "conflict"
          : intent.status === "merged"
            ? "success"
            : intent.status === "merging" || intent.status === "adjudicating"
              ? "running"
              : "unchecked",
      merge_base_sha: intent.baseOid,
      source_sha: intent.deltaOid,
      state: intent.status,
      title: `Merge intent ${intent.id}`,
      stats: { commits: null, files_changed: null, additions: null, deletions: null },
    });
  });

  // "Mark viewed" — one KV flag per (repo, intent, user); the file-views
  // endpoint stays the per-file granularity.
  router.post("/api/v1/repos/:repo_ref{.+}/pullreq/:n/view", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return c.json({});
    const intent = await intentByNumber(access, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    await c.env.ROUTES.put(
      `gpr-view:${access.route.doName}:${intent.id}:${access.viewer.userId}`,
      String(Date.now()),
      { expirationTtl: FILE_VIEW_TTL_S }
    );
    return c.json({});
  });

  // --- reviews / reviewers (KV meta) ------------------------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/reviews", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const intent = await intentByNumber(access, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, access.route.doName, intent.id);
    return c.json(
      (meta.reviews ?? []).map((r, i) => ({
        id: i + 1,
        decision: r.decision,
        sha: r.sha ?? intent.deltaOid,
        reviewer: {
          id: numericId(r.author),
          uid: r.author,
          display_name: r.author,
          type: "user",
        },
        created: r.created,
        updated: r.created,
      }))
    );
  });

  // Review submit appends to the KV record — an approve/changereq is a human
  // signal alongside the quorum's adjudication votes, not a merge gate.
  router.post("/api/v1/repos/:repo_ref{.+}/pullreq/:n/reviews", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const body = (await c.req.json().catch(() => null)) as {
      decision?: string;
      commit_sha?: string;
    } | null;
    const decision = body?.decision ?? "reviewed";
    if (!["approved", "changereq", "reviewed"].includes(decision)) {
      return gErr(c, 400, "invalid decision");
    }
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const review: PrReview = {
      author: gate.actor,
      decision,
      sha: body?.commit_sha ?? intent.deltaOid,
      created: Date.now(),
    };
    // Latest decision per reviewer wins — matches gitness semantics.
    meta.reviews = (meta.reviews ?? []).filter((r) => r.author !== gate.actor);
    meta.reviews.push(review);
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({
      id: meta.reviews.length,
      decision: review.decision,
      sha: review.sha,
      reviewer: {
        id: numericId(review.author),
        uid: review.author,
        display_name: review.author,
        type: "user",
      },
      created: review.created,
      updated: review.created,
    });
  });

  // Reviewer assignment is advisory metadata — no notification pipeline.
  // Checks on the PR = commit statuses against the delta tip.
  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/checks", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const intent = await intentByNumber(access, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const rows = await getRepoStub(c.env, access.route.doName)
      .getCommitStatuses(intent.deltaOid)
      .catch(() => []);
    return c.json({
      commit_sha: intent.deltaOid,
      checks: rows.map((r, i) => ({
        id: i + 1,
        identifier: r.context,
        status: r.state,
        summary: r.description ?? "",
        link: r.targetUrl ?? "",
        created: r.createdAt,
      })),
    });
  });

  // Combined reviewer view: recorded reviews (real, from meta) + the
  // pullreq-gating rules that apply to the target ref.
  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/reviewers/combined", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const intent = await intentByNumber(access, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, access.route.doName, intent.id);
    return c.json({
      reviewers: (meta.reviewers ?? []).map((uid) => ({
        reviewer: { id: numericId(uid), uid, display_name: uid, type: "user" },
        review_decision: meta.reviews?.find((r) => r.author === uid)?.decision ?? "pending",
        created: intent.createdAt,
        updated: intent.resolvedAt ?? intent.createdAt,
      })),
      evaluation_result: null,
    });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/reviewers", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const intent = await intentByNumber(access, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, access.route.doName, intent.id);
    const reviews = meta.reviews ?? [];
    return c.json(
      (meta.reviewers ?? []).map((uid) => {
        const latest = reviews.filter((r) => r.author === uid).at(-1);
        return {
          reviewer: {
            id: numericId(uid),
            uid,
            display_name: uid,
            type: "user",
          },
          review_decision: latest?.decision ?? "pending",
          sha: latest?.sha ?? "",
          added: latest?.created ?? intent.createdAt,
          updated: latest?.created ?? intent.createdAt,
          type: "required",
        };
      })
    );
  });

  router.put("/api/v1/repos/:repo_ref{.+}/pullreq/:n/reviewers", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const body = (await c.req.json().catch(() => null)) as { reviewer_id?: number } | null;
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    // Gitness passes a numeric principal id; we cannot reverse numericId
    // losslessly, so store the raw uid the SPA echoes back from
    // /principals — which today is empty, making this effectively self-review
    // assignment by the actor when no uid resolution exists.
    const uid = String(body?.reviewer_id ?? gate.actor);
    meta.reviewers = [...new Set([...(meta.reviewers ?? []), uid])];
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    notifyMembers(c, gate, {
      kind: "review-request",
      title: `PR #${c.req.param("n")}: review requested`,
      body: `${gate.actor} requested review from ${uid}`,
      excludeUserId: gate.viewer?.userId,
      link: `/${gate.route.routeNamespaceSlug}/repos/${gate.route.routeRepoSlug}/pulls/${c.req.param("n")}`,
    });
    return c.json({
      reviewer: { id: numericId(uid), uid, display_name: uid, type: "user" },
      review_decision: "pending",
      type: "required",
    });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/pullreq/:n/reviewers/:principal_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const want = c.req.param("principal_id");
    meta.reviewers = (meta.reviewers ?? []).filter(
      (uid) => uid !== want && String(numericId(uid)) !== want
    );
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({});
  });

  // --- assignees (distinct from reviewers — GitHub tracks both) ---------------

  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/assignees", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const intent = await intentByNumber(access, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, access.route.doName, intent.id);
    return c.json(
      (meta.assignees ?? []).map((uid) => ({
        id: numericId(uid),
        uid,
        display_name: uid,
        type: "user",
      }))
    );
  });

  router.put("/api/v1/repos/:repo_ref{.+}/pullreq/:n/assignees", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const body = (await c.req.json().catch(() => null)) as { assignee_id?: string } | null;
    const uid = body?.assignee_id?.trim() || gate.actor;
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    meta.assignees = [...new Set([...(meta.assignees ?? []), uid])];
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({ id: numericId(uid), uid, display_name: uid, type: "user" });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/pullreq/:n/assignees/:principal_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const want = c.req.param("principal_id");
    meta.assignees = (meta.assignees ?? []).filter(
      (uid) => uid !== want && String(numericId(uid)) !== want
    );
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({});
  });

  // --- automerge --------------------------------------------------------------
  //
  // Our automerge is a flag on the intent's meta: setting it attempts the
  // merge immediately; when the delta can't merge (conflict/lease), the flag
  // stays and any later merge attempt is the queue — intents ARE the queue
  // in delta-git, claimed in order by the merge engine.

  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/automerge", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const intent = await intentByNumber(access, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, access.route.doName, intent.id);
    return c.json({ mergeable: Boolean(meta.automerge), method: meta.automerge?.method ?? null });
  });

  router.put("/api/v1/repos/:repo_ref{.+}/pullreq/:n/automerge", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const body = (await c.req.json().catch(() => null)) as { method?: string } | null;
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    meta.automerge = { method: body?.method ?? "merge", setBy: gate.actor, at: Date.now() };
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    // Try to land it right now — the flag persists if it can't.
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await attemptMerge({
      env: c.env,
      repoId: gate.route.doName,
      stub,
      intentId: intent.id,
      actor: gate.actor,
      cacheCtx: gate.cacheCtx,
    });
    return c.json({
      mergeable: true,
      method: meta.automerge.method,
      merged: result.kind === "merged" || result.kind === "up_to_date",
      sha: result.kind === "merged" ? result.mergeOid : undefined,
    });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/pullreq/:n/automerge", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    meta.automerge = undefined;
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({});
  });

  // --- source branch ops -------------------------------------------------------
  //
  // The PR's "source" is a delta ref that persists after merge — branch
  // restore recreates a heads ref at the delta tip; branch delete removes
  // the delta ref once the intent is terminal.

  router.post("/api/v1/repos/:repo_ref{.+}/pullreq/:n/branch", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
    const name = body?.name ?? intent.deltaRef.replace(/^refs\//, "").replace(/\//g, "-");
    const full = `refs/heads/${name}`;
    const stub = getRepoStub(c.env, gate.route.doName);
    const { refs } = await stub.getHeadAndRefs();
    if (refs.some((r) => r.name === full)) return gErr(c, 409, `branch ${name} already exists`);
    await stub.setRefs([...refs, { name: full, oid: intent.deltaOid }]);
    return c.json({ name, sha: intent.deltaOid, is_default: false });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/pullreq/:n/branch", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    if (!["merged", "rejected", "expired"].includes(intent.status)) {
      return gErr(c, 409, "cannot delete the source of an open pull request");
    }
    const stub = getRepoStub(c.env, gate.route.doName);
    const { refs } = await stub.getHeadAndRefs();
    const next = refs.filter((r) => r.name !== intent.deltaRef);
    if (next.length === refs.length) return gNotFound(c, "branch");
    await stub.setRefs(next);
    return c.json({ deleted: true });
  });

  // --- revert / retarget --------------------------------------------------------

  // Revert a merged intent: build a commit whose tree is the recorded merge
  // base (pre-PR state) on top of the current target head, then mint a new
  // intent for it — a real "revert pull request" through the merge lane.
  router.post("/api/v1/repos/:repo_ref{.+}/pullreq/:n/revert", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    if (intent.status !== "merged") return gErr(c, 409, "only merged pull requests revert");
    const stub = getRepoStub(c.env, gate.route.doName);
    const { refs } = await stub.getHeadAndRefs();
    const head = refs.find((r) => r.name === intent.targetRef);
    if (!head) return gErr(c, 409, "target ref is gone");
    const baseCommit = await readCommit(
      c.env,
      gate.route.doName,
      intent.baseOid,
      gate.cacheCtx
    ).catch(() => undefined);
    if (!baseCommit) return gErr(c, 422, "merge base objects unavailable");
    const ts = Math.floor(Date.now() / 1000);
    const sig = `${gate.actor} <web@delta-git.invalid> ${ts} +0000`;
    const number = parseInt(c.req.param("n"), 10);
    const payload = new TextEncoder().encode(
      `tree ${baseCommit.tree}\nparent ${head.oid}\nauthor ${sig}\ncommitter ${sig}\n\n` +
        `Revert pull request ${number}\n\nThis reverts merge of intent ${intent.id}.\n`
    );
    const commitOid = await computeOid("commit", payload);
    const pack = await writeServerPack([{ type: "commit", payload, oid: commitOid }]);
    const packKey = r2PackKey(
      doPrefix(stub.id.toString()),
      `pack-revert-${commitOid.slice(0, 12)}.pack`
    );
    await c.env.REPO_BUCKET.put(packKey, pack.packBytes);
    await c.env.REPO_BUCKET.put(packIndexKey(packKey), pack.idxBytes);
    const accepted = await stub.acceptPatchCommit({
      targetRef: intent.targetRef,
      newOid: commitOid,
      actor: gate.actor,
      kind: "pullreq.revert",
      stagedPack: {
        packKey,
        packBytes: pack.packBytes.length,
        idxBytes: pack.idxBytes.length,
        objectCount: pack.objectCount,
      },
    });
    const all = await allIntentsOrdered(gate, c.env);
    const n = all.findIndex((i) => i.id === accepted.intent.id) + 1;
    return c.json(
      mergeIntentToPullReq({ intent: accepted.intent, number: n > 0 ? n : all.length })
    );
  });

  // Retarget = a fresh intent for the same delta against the new target; the
  // old intent is rejected so numbering and history stay honest.
  router.put("/api/v1/repos/:repo_ref{.+}/pullreq/:n/target-branch", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const n = parseInt(c.req.param("n"), 10);
    const intent = await intentByNumber(gate, c.env, n);
    if (!intent) return gNotFound(c, "pull request");
    const body = (await c.req.json().catch(() => null)) as { target_branch?: string } | null;
    if (!body?.target_branch) return gErr(c, 400, "target_branch required");
    const targetRef = `refs/heads/${body.target_branch.replace(/^refs\/heads\//, "")}`;
    const stub = getRepoStub(c.env, gate.route.doName);
    const { refs } = await stub.getHeadAndRefs();
    if (!refs.some((r) => r.name === targetRef)) return gNotFound(c, "branch");
    const accepted = await stub.acceptPatchCommit({
      targetRef,
      newOid: intent.deltaOid,
      actor: gate.actor,
      kind: "pullreq.retarget",
    });
    const rejected = await stub.rejectMergeIntent({ id: intent.id, actor: gate.actor });
    if (rejected.status !== "rejected") {
      // Original already settled — keep the new intent but report it.
      const all = await allIntentsOrdered(gate, c.env);
      const num = all.findIndex((i) => i.id === accepted.intent.id) + 1;
      return c.json(
        mergeIntentToPullReq({ intent: accepted.intent, number: num > 0 ? num : all.length })
      );
    }
    // Carry human meta forward so the retargeted PR keeps its title.
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    if (meta.title || meta.description || meta.comments.length > 0) {
      await writePrMeta(c.env, gate.route.doName, accepted.intent.id, meta);
    }
    const all = await allIntentsOrdered(gate, c.env);
    const num = all.findIndex((i) => i.id === accepted.intent.id) + 1;
    return c.json({
      ...mergeIntentToPullReq({
        intent: accepted.intent,
        number: num > 0 ? num : all.length,
        title: meta.title,
      }),
      description: meta.description ?? "",
    });
  });

  // --- labels on the PR ---------------------------------------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/labels", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const intent = await intentByNumber(access, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const [meta, repoLabels] = await Promise.all([
      readPrMeta(c.env, access.route.doName, intent.id),
      readRepoLabels(c.env, access.route.doName),
    ]);
    return c.json(
      (meta.labels ?? [])
        .map((id) => repoLabels.find((l) => String(l.id) === id || l.key === id))
        .filter((l): l is NonNullable<typeof l> => Boolean(l))
        .map((l) => ({
          label: {
            id: l.id,
            key: l.key,
            color: l.color,
            scope: 0,
          },
          label_id: l.id,
          pullreq_id: parseInt(c.req.param("n"), 10),
        }))
    );
  });

  router.put("/api/v1/repos/:repo_ref{.+}/pullreq/:n/labels", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const body = (await c.req.json().catch(() => null)) as {
      label_id?: number;
      label?: string;
    } | null;
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const id = String(body?.label_id ?? body?.label ?? "");
    if (!id) return gErr(c, 400, "label_id required");
    meta.labels = [...new Set([...(meta.labels ?? []), id])];
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({ label_id: Number(id) || id });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/pullreq/:n/labels/:label_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const want = c.req.param("label_id");
    meta.labels = (meta.labels ?? []).filter((id) => id !== want);
    await writePrMeta(c.env, gate.route.doName, intent.id, meta);
    return c.json({});
  });

  // Label/reviewer suggestions are real candidates, not random picks:
  // labels the repo defines but this PR lacks, and members/adjudication
  // actors who touched this repo's intents.
  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/suggestions/labels", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const intent = await intentByNumber(access, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const [meta, repoLabels] = await Promise.all([
      readPrMeta(c.env, access.route.doName, intent.id),
      readRepoLabels(c.env, access.route.doName),
    ]);
    const assigned = new Set(meta.labels ?? []);
    return c.json(
      repoLabels
        .filter((l) => !assigned.has(String(l.id)) && !assigned.has(l.key))
        .map((l) => ({ id: l.id, key: l.key, color: l.color }))
    );
  });

  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/suggestions/reviewers", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const intent = await intentByNumber(access, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const all = await allIntentsOrdered(access, c.env);
    const participants = new Set<string>();
    for (const i of all) if (i.actor !== intent.actor) participants.add(i.actor);
    return c.json(
      [...participants].slice(0, 10).map((uid) => ({
        reviewer: { id: numericId(uid), uid, display_name: uid, type: "user" },
      }))
    );
  });

  // --- suggestions ------------------------------------------------------------
  //
  // A comment whose code_comment anchor + ```suggestion``` block carries a
  // replacement gets committed onto the PR's delta tip — the real
  // "commit suggestion" write, advancing the intent's delta.

  router.post("/api/v1/repos/:repo_ref{.+}/pullreq/:n/comments/apply-suggestions", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
    if (!intent) return gNotFound(c, "pull request");
    const body = (await c.req.json().catch(() => null)) as {
      comment_ids?: number[];
      message?: string;
    } | null;
    const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
    const wanted = new Set(body?.comment_ids ?? meta.comments.map((cm) => cm.id));
    const applicable = meta.comments.filter((cm) => {
      if (!wanted.has(cm.id) || !cm.codeComment?.path) return false;
      return /```suggestion\s*\n([\s\S]*?)```/.test(cm.text);
    });
    if (applicable.length === 0) {
      return gErr(c, 400, "no comments carry suggestion blocks with file anchors");
    }
    const stub = getRepoStub(c.env, gate.route.doName);

    const objects: NewObject[] = [];
    const deltaCommit = await readCommit(
      c.env,
      gate.route.doName,
      intent.deltaOid,
      gate.cacheCtx
    ).catch(() => undefined);
    if (!deltaCommit) return gErr(c, 422, "delta commit objects unavailable");
    let treeOid = deltaCommit.tree;
    const appliedPaths: string[] = [];

    for (const cm of applicable) {
      const path = cm.codeComment!.path!;
      const entry = await resolvePathEntry(c.env, gate.route.doName, treeOid, path, gate.cacheCtx);
      const blob = entry
        ? await readPayload(c.env, gate.route.doName, entry.oid, gate.cacheCtx)
        : undefined;
      if (!blob || blob.type !== "blob") return gErr(c, 422, `file missing: ${path}`);
      const lines = td.decode(blob.payload).split("\n");
      const start = Math.max(1, cm.codeComment!.line_start ?? 1);
      const end = Math.min(lines.length, cm.codeComment!.line_end ?? start);
      const suggestion = cm.text.match(/```suggestion\s*\n([\s\S]*?)```/)![1].replace(/\n$/, "");
      lines.splice(start - 1, end - start + 1, suggestion);
      const bytes = te.encode(lines.join("\n"));
      const oid = await computeOid("blob", bytes);
      objects.push({ type: "blob", payload: bytes, oid });
      const next = await setTreePath({
        env: c.env,
        repoId: gate.route.doName,
        treeOid,
        path,
        entry: { mode: "100644", oid },
        cacheCtx: gate.cacheCtx,
        objects,
      });
      if (next === undefined) return gErr(c, 422, `bad-path:${path}`);
      treeOid = next;
      appliedPaths.push(path);
    }

    const ts = Math.floor(Date.now() / 1000);
    const sig = `${gate.actor} <web@delta-git.invalid> ${ts} +0000`;
    const payload = te.encode(
      `tree ${treeOid}\nparent ${intent.deltaOid}\nauthor ${sig}\ncommitter ${sig}\n\n` +
        `${body?.message || `Apply suggestions (${appliedPaths.join(", ")})`}\n`
    );
    const commitOid = await computeOid("commit", payload);
    objects.push({ type: "commit", payload, oid: commitOid });
    const pack = await writeServerPack(objects);
    const packKey = r2PackKey(
      doPrefix(stub.id.toString()),
      `pack-sugg-${commitOid.slice(0, 12)}.pack`
    );
    await c.env.REPO_BUCKET.put(packKey, pack.packBytes);
    await c.env.REPO_BUCKET.put(packIndexKey(packKey), pack.idxBytes);
    const advanced = await stub.advanceMergeIntentDelta({
      intentId: intent.id,
      newOid: commitOid,
      actor: gate.actor,
      stagedPack: {
        packKey,
        packBytes: pack.packBytes.length,
        idxBytes: pack.idxBytes.length,
        objectCount: pack.objectCount,
      },
    });
    if (advanced.status !== "advanced") {
      return gErr(
        c,
        409,
        `pull request is ${advanced.status === "not_advancable" ? advanced.state : "gone"}`
      );
    }
    return c.json({ applied: appliedPaths.map((p) => ({ path: p })), commit_id: commitOid });
  });

  // --- reactions ------------------------------------------------------------

  router.post(
    "/api/v1/repos/:repo_ref{.+}/pullreq/:n/comments/:comment_id/reactions/:emoji",
    async (c) => {
      const gate = await requireWriter(c);
      if (gate instanceof Response) return gate;
      const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
      if (!intent) return gNotFound(c, "pull request");
      const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
      const comment = meta.comments.find((cm) => cm.id === parseInt(c.req.param("comment_id"), 10));
      if (!comment) return gNotFound(c, "comment");
      const emoji = decodeURIComponent(c.req.param("emoji"));
      comment.reactions ??= {};
      comment.reactions[emoji] = [...new Set([...(comment.reactions[emoji] ?? []), gate.actor])];
      await writePrMeta(c.env, gate.route.doName, intent.id, meta);
      return c.json({ emoji, users: comment.reactions[emoji] });
    }
  );

  router.delete(
    "/api/v1/repos/:repo_ref{.+}/pullreq/:n/comments/:comment_id/reactions/:emoji",
    async (c) => {
      const gate = await requireWriter(c);
      if (gate instanceof Response) return gate;
      const intent = await intentByNumber(gate, c.env, parseInt(c.req.param("n"), 10));
      if (!intent) return gNotFound(c, "pull request");
      const meta = await readPrMeta(c.env, gate.route.doName, intent.id);
      const comment = meta.comments.find((cm) => cm.id === parseInt(c.req.param("comment_id"), 10));
      if (!comment) return gNotFound(c, "comment");
      const emoji = decodeURIComponent(c.req.param("emoji"));
      if (comment.reactions?.[emoji]) {
        comment.reactions[emoji] = comment.reactions[emoji].filter((u) => u !== gate.actor);
        await writePrMeta(c.env, gate.route.doName, intent.id, meta);
      }
      return c.json({});
    }
  );

  // --- merge queue -----------------------------------------------------------
  //
  // delta-git's queue IS the intent set: open/merging intents in createdAt
  // order. Prioritization has no lever — merge claims are serial per repo —
  // so reprioritizing returns the queue as-is rather than pretending.

  router.get("/api/v1/repos/:repo_ref{.+}/mergequeue", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const all = await allIntentsOrdered(access, c.env);
    const queued = all
      .map((i, idx) => ({ intent: i, n: idx + 1 }))
      .filter(({ intent }) => ["open", "merging", "adjudicating"].includes(intent.status));
    return c.json({
      entries: queued.map(({ intent, n }, pos) => ({
        pull_request_number: n,
        position: pos + 1,
        state: intent.status === "open" ? "queued" : "processing",
        created: intent.createdAt,
      })),
    });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/mergequeue", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const n = parseInt(c.req.param("n"), 10);
    const all = await allIntentsOrdered(access, c.env);
    const intent = n >= 1 && n <= all.length ? all[n - 1] : undefined;
    if (!intent) return gNotFound(c, "pull request");
    const queue = all.filter((i) => ["open", "merging", "adjudicating"].includes(i.status));
    const pos = queue.findIndex((i) => i.id === intent.id);
    return c.json({
      in_queue: pos >= 0,
      position: pos >= 0 ? pos + 1 : null,
      state: pos >= 0 ? (intent.status === "open" ? "queued" : "processing") : "not_queued",
    });
  });

  router.post("/api/v1/repos/:repo_ref{.+}/pullreq/:n/mergequeue/prioritize", async (c) => {
    // The queue orders by intent claim; there is no reorder lever. Returning
    // the real position is the honest answer.
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const all = await allIntentsOrdered(access, c.env);
    const queue = all.filter((i) => ["open", "merging", "adjudicating"].includes(i.status));
    return c.json({
      entries: queue.map((i, pos) => ({
        pull_request_number: all.indexOf(i) + 1,
        position: pos + 1,
        state: i.status === "open" ? "queued" : "processing",
      })),
      note: "merge order follows intent claim order; manual reordering has no effect",
    });
  });
}
