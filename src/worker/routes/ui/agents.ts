import { getRepoStub } from "@/worker/common";
import {
  getDefaultBranchFromHead,
  loadHeadAndRefsCached,
  loadUiRepoActivity,
  resolveUiRepoAccess,
} from "./helpers";
import { handleError } from "@/client/server/error";
import { sameOriginViolation } from "@/worker/auth/origin";
import { LIMITS, rateLimit } from "@/worker/agent/abuse";
import type { AppContext } from "../hono";
import { renderUiDocumentResponse } from "../uiResponse";

const ALL_INTENT_STATUSES = [
  "open",
  "merging",
  "adjudicating",
  "conflict",
  "merged",
  "rejected",
  "expired",
];

/**
 * GET /:owner/:repo/agents — SSR page for the agent-coordination layer:
 * merge intents, adjudication votes, work intents, and the op-log tail.
 * Reads come straight from the repo DO (single hop: Worker -> DO), so the
 * page always reflects the authoritative coordination state.
 */
export async function handleAgentsPage(c: AppContext<"/:owner/:repo/agents">) {
  const env = c.env;
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const access = await resolveUiRepoAccess(c, owner, repo);
  if (access.kind === "response") return access.response;
  const { route, cacheCtx } = access;
  const repoId = route.doName;
  const stub = getRepoStub(env, repoId);
  try {
    const [intents, opLogRows, workIntents, refsData, progress] = await Promise.all([
      stub.listMergeIntents(ALL_INTENT_STATUSES),
      stub.listOpLog(0),
      stub.listWorkIntents(),
      loadHeadAndRefsCached(env, cacheCtx, repoId),
      loadUiRepoActivity(env, access),
    ]);
    const head = refsData?.head || undefined;
    const defaultBranch = getDefaultBranchFromHead(head);
    const refEnc = encodeURIComponent(defaultBranch);

    // Attach votes to non-terminal intents so the page can show live quorum state.
    const intentsView = await Promise.all(
      intents.map(async (i) => ({
        id: i.id,
        targetRef: i.targetRef,
        baseOid: i.baseOid,
        deltaRef: i.deltaRef,
        deltaOid: i.deltaOid,
        status: i.status,
        actor: i.actor,
        // conflicts is stored as a JSON array string in the DO.
        conflicts: i.conflicts ? (JSON.parse(i.conflicts) as string[]) : [],
        resultOid: i.resultOid,
        createdAt: i.createdAt,
        resolvedAt: i.resolvedAt,
        votes:
          i.status === "adjudicating" || i.status === "conflict"
            ? (await stub.listMergeVotes(i.id)).map((v) => ({
                seat: v.seat,
                voterDid: v.voterDid,
                resolutionDigest: v.resolutionDigest,
                createdAt: v.createdAt,
              }))
            : [],
      }))
    );

    return renderUiDocumentResponse(
      env,
      "agents",
      {
        title: `Agents · ${owner}/${repo}`,
        owner,
        repo,
        refEnc,
        intents: intentsView,
        // Keep the most recent 50 entries for display; the full chain stays in the DO.
        opLog: opLogRows.slice(-50).map((e) => ({
          seq: e.seq,
          kind: e.kind,
          actor: e.actor,
          createdAt: e.createdAt,
          hash: e.hash,
        })),
        workIntents: workIntents.map((w) => ({
          id: w.id,
          title: w.title,
          body: w.body,
          status: w.status,
          createdBy: w.createdBy,
          claimedBy: w.claimedBy,
        })),
        progress,
        arena: route.backend === "artifacts",
      },
      {
        // Coordination state changes continuously; never cache this page.
        cacheControl: "no-store",
        failureBody: "Failed to render view",
        viewer: access.viewer,
      }
    );
  } catch (e) {
    return handleError(env, e, `Error · ${owner}/${repo}`, {
      owner,
      repo,
      refEnc: "",
    });
  }
}

/**
 * POST /:owner/:repo/ideas/site — session-authed site-builder trigger.
 * Describe a WordPress site; the site-smith seat generates it and lands the
 * result through the normal merge lanes. Contribution is permissionless —
 * no rep gate (voting is what's gated), just the rate limiter.
 */
export async function handleIdeasSiteBuild(c: AppContext<"/:owner/:repo/ideas">) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const back = `/${owner}/${repo}/ideas`;
  const violation = sameOriginViolation(c);
  if (violation) return violation;
  const access = await resolveUiRepoAccess(c, owner, repo);
  if (access.kind === "response") return access.response;
  if (!access.viewer) {
    return c.redirect(`/auth?next=${encodeURIComponent(back)}`, 302);
  }
  const limited = await rateLimit(c.env.ROUTES, LIMITS.siteBuild, access.viewer.userId);
  if (!limited.ok) return c.redirect(`${back}?error=rate-limited`, 303);

  const form = await c.req.raw.formData().catch(() => null);
  const description = String(form?.get("description") ?? "").trim();
  if (!description || description.length > 8000) return c.redirect(back, 303);

  const stub = getRepoStub(c.env, access.route.doName);
  const row = await stub.createWorkIntent({
    row: {
      id: `idea-${crypto.randomUUID().slice(0, 8)}`,
      title: `site: ${description.split("\n")[0].slice(0, 150)}`,
      body: description.slice(0, 8000),
      createdBy: access.viewer.userId,
      kind: "idea",
      sourceUri: null,
      result: null,
      status: "open",
      claimedBy: null,
      claimExpiresAt: null,
      createdAt: Date.now(),
      closedAt: null,
    },
    actor: access.viewer.userId,
  });
  await c.env.REPO_TASKS_QUEUE.send({
    kind: "site-build",
    doId: stub.id.toString(),
    repoId: access.route.doName,
    workIntentId: row.id,
  });
  return c.redirect(back, 303);
}

/**
 * GET /:owner/:repo/ideas — idea-first UX surface: open ideas, claimed
 * work, and quorum-verified results rendered for non-coders. Same DO read
 * path as the agents page.
 */
export async function handleIdeasPage(c: AppContext<"/:owner/:repo/ideas">) {
  const env = c.env;
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const access = await resolveUiRepoAccess(c, owner, repo);
  if (access.kind === "response") return access.response;
  const { route, cacheCtx } = access;
  const stub = getRepoStub(env, route.doName);
  try {
    const [ideas, refsData] = await Promise.all([
      stub.listWorkIntentsByKind("idea"),
      loadHeadAndRefsCached(env, cacheCtx, route.doName),
    ]);
    const votes = await Promise.all(ideas.map((i) => stub.listWorkVotes(i.id)));
    const head = refsData?.head || undefined;
    const refEnc = encodeURIComponent(getDefaultBranchFromHead(head));

    return renderUiDocumentResponse(
      env,
      "ideas",
      {
        title: `Ideas · ${owner}/${repo}`,
        owner,
        repo,
        refEnc,
        ideas: ideas.map((row, i) => ({
          id: row.id,
          title: row.title,
          body: row.body,
          sourceUri: row.sourceUri,
          status: row.status,
          createdBy: row.createdBy,
          claimedBy: row.claimedBy,
          result: row.result,
          voteCount: votes[i].length,
          createdAt: row.createdAt,
        })),
        arena: route.backend === "artifacts",
        viewerSignedIn: access.viewer !== null,
      },
      {
        cacheControl: "no-store",
        failureBody: "Failed to render view",
        viewer: access.viewer,
      }
    );
  } catch (e) {
    return handleError(env, e, `Error · ${owner}/${repo}`, { owner, repo, refEnc: "" });
  }
}
