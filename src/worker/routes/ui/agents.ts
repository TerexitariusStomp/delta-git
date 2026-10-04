import { getRepoStub } from "@/worker/common";
import {
  getDefaultBranchFromHead,
  loadHeadAndRefsCached,
  loadUiRepoActivity,
  resolveUiRepoAccess,
} from "./helpers";
import { handleError } from "@/client/server/error";
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
