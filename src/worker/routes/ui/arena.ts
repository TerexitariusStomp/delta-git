import type { AppContext } from "../hono";
import type { MatchEntryRow, MatchRow } from "@/worker/do/repo/db/schema";

import { handleError } from "@/client/server/error";
import { getRepoStub } from "@/worker/common";
import { loadViewer } from "@/worker/auth/session";
import {
  arenaShuffleKey,
  clampStake,
  voteGateError,
  VOTE_MAX_STAKE,
  VOTE_MIN_REP,
  VOTE_MIN_STAKE,
} from "@/shared/arena";
import { sameOriginViolation } from "@/worker/auth/origin";
import { listArenaMatchIndex } from "@/worker/db/d1/dal/arena";
import { findRepTargetByUserId } from "@/worker/db/d1/dal/reputation";
import { adjustRep } from "@/worker/db/d1/dal/reputation";
import { findRepositoryByDoName } from "@/worker/db/d1/dal";
import { renderUiDocumentResponse } from "../uiResponse";
import { notFound, resolveUiRepoAccess, type UiRepoAccess } from "./helpers";

// /arena — global match feed + per-repo match detail pages. The feed reads
// the D1 `arena_matches` index (authoritative state lives in each repo's
// DO); the detail page reads the DO directly so it's always current.

type ArenaPhase = "building" | "judging" | "resolved";

function derivePhase(match: {
  status: string;
  endsAt: number | null;
  judgeEndsAt: number | null;
  winnerEntryId: string | null;
}): ArenaPhase {
  if (match.status === "resolved" || match.status === "expired") return "resolved";
  if (match.status === "judging" || (match.endsAt ?? Infinity) <= Date.now()) {
    return "judging";
  }
  return "building";
}

/** GET /arena — cross-repo feed of live and recent matches. */
export async function handleArenaFeed(c: AppContext<"/arena">) {
  const env = c.env;
  try {
    const [rows, viewer] = await Promise.all([listArenaMatchIndex(c.var.db, 50), loadViewer(c)]);
    const matches = rows.map((row) => ({
      id: row.id,
      title: row.title,
      ownerSlug: row.ownerSlug,
      repoSlug: row.repoSlug,
      phase: derivePhase(row),
      entryCount: row.entryCount,
      endsAt: row.endsAt,
      judgeEndsAt: row.judgeEndsAt,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    }));
    return renderUiDocumentResponse(
      env,
      "arena",
      { title: "Arena · delta-git", matches },
      { cacheControl: "no-store", failureBody: "Failed to render view", viewer }
    );
  } catch (e) {
    return handleError(env, e, "Error · delta-git", {});
  }
}

type MatchAccess = Extract<UiRepoAccess, { kind: "ok" }>;

async function resolveMatchAccess(
  c: AppContext
): Promise<{ access: MatchAccess; stub: ReturnType<typeof getRepoStub> } | Response> {
  const access = await resolveUiRepoAccess(c, c.req.param("owner")!, c.req.param("repo")!);
  if (access.kind === "response") return access.response;
  return { access, stub: getRepoStub(c.env, access.route.doName) };
}

function entryView(
  entry: MatchEntryRow,
  blind: boolean,
  viewerKey: string
): Record<string, unknown> {
  return {
    id: entry.id,
    slot: arenaShuffleKey(viewerKey, entry.matchId, entry.id) % 0xffff,
    entrantDid: blind ? null : entry.entrantDid,
    workspace: entry.workspaceName,
    headOid: entry.headOid,
    pushCount: entry.pushCount,
    firstPushAt: entry.firstPushAt,
    lastPushAt: entry.lastPushAt,
    autoScore: entry.autoScore,
    voteCount: entry.voteCount,
    won: entry.won === 1,
  };
}

function matchView(match: MatchRow): Record<string, unknown> {
  return {
    id: match.id,
    title: match.title,
    spec: match.spec,
    status: match.status,
    endsAt: match.endsAt,
    judgeEndsAt: match.judgeEndsAt,
    maxEntrants: match.maxEntrants,
    prizeRep: match.prizeRep,
    createdBy: match.createdBy,
    winnerEntryId: match.status === "resolved" ? match.winnerEntryId : null,
  };
}

/** GET /:owner/:repo/arena — repo-scoped match list. */
export async function handleRepoArena(c: AppContext<"/:owner/:repo/arena">) {
  const env = c.env;
  try {
    const resolved = await resolveMatchAccess(c);
    if (resolved instanceof Response) return resolved;
    const { access, stub } = resolved;
    const matches = await stub.listMatches(["open", "building", "judging", "resolved"]);
    return renderUiDocumentResponse(
      env,
      "arena",
      {
        title: `Arena · ${access.route.routeNamespaceSlug}/${access.route.routeRepoSlug}`,
        matches: matches.map((m) => ({
          id: m.id,
          title: m.title,
          ownerSlug: access.route.routeNamespaceSlug,
          repoSlug: access.route.routeRepoSlug,
          phase: derivePhase(m),
          entryCount: 0,
          endsAt: m.endsAt,
          judgeEndsAt: m.judgeEndsAt,
          createdBy: m.createdBy,
          createdAt: m.createdAt,
        })),
      },
      { cacheControl: "no-store", failureBody: "Failed to render view", viewer: access.viewer }
    );
  } catch (e) {
    return handleError(env, e, "Error · delta-git", {});
  }
}

/** GET /:owner/:repo/arena/:id — match detail with blind-judging masking. */
export async function handleArenaMatch(c: AppContext<"/:owner/:repo/arena/:id">) {
  const env = c.env;
  try {
    const resolved = await resolveMatchAccess(c);
    if (resolved instanceof Response) return resolved;
    const { access, stub } = resolved;
    const detail = await stub.getMatch(c.req.param("id"));
    if (!detail) return notFound(c);
    const { match, entries, votes } = detail;
    const repoRow = await findRepositoryByDoName(c.var.db, access.route.doName);

    // Browser session userId is the voter key for UI votes; agents/PATs
    // voting via the API appear with their own actor keys.
    const viewerKey = access.viewer?.userId ?? "anon";
    const voterVoted = votes.some((v) => v.voterDid === viewerKey);
    const blind = match.status !== "resolved" && !voterVoted;
    const ordered = [...entries].sort(
      (a, b) =>
        arenaShuffleKey(viewerKey, match.id, a.id) - arenaShuffleKey(viewerKey, match.id, b.id)
    );
    // Voting needs earned rep + an escrowed stake; surface the viewer's
    // balance so the page can render the stake UI or the earn-rep prompt.
    const viewerTarget = access.viewer
      ? await findRepTargetByUserId(c.var.db, access.viewer.userId)
      : undefined;
    const viewerRep = viewerTarget?.rep ?? 0;
    // Same substantive gate as the API route: rep floor + stake + age.
    const gate = voteGateError(viewerTarget ?? null);
    return renderUiDocumentResponse(
      env,
      "arena-match",
      {
        title: `${match.title} · Arena`,
        owner: access.route.routeNamespaceSlug,
        repo: access.route.routeRepoSlug,
        visibility: access.route.visibility,
        description: repoRow?.description ?? "",
        match: matchView(match),
        blind,
        voted: voterVoted,
        viewerSignedIn: access.viewer !== null,
        viewerRep,
        voteEligible: gate === null,
        minStake: VOTE_MIN_STAKE,
        maxStake: VOTE_MAX_STAKE,
        minVoteRep: VOTE_MIN_REP,
        entries: ordered.map((e) => entryView(e, blind, viewerKey)),
      },
      { cacheControl: "no-store", failureBody: "Failed to render view", viewer: access.viewer }
    );
  } catch (e) {
    return handleError(env, e, "Error · delta-git", {});
  }
}

/** POST /:owner/:repo/arena/:id/vote — session-only form vote (PRG). */
export async function handleArenaVote(c: AppContext<"/:owner/:repo/arena/:id">) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const matchId = c.req.param("id");
  const back = `/${owner}/${repo}/arena/${matchId}`;
  // CSRF: form posts are same-origin only.
  const violation = sameOriginViolation(c);
  if (violation) return violation;
  const resolved = await resolveMatchAccess(c);
  if (resolved instanceof Response) return resolved;
  const { access, stub } = resolved;
  if (!access.viewer) {
    return c.redirect(`/auth?next=${encodeURIComponent(back)}`, 302);
  }
  const form = await c.req.raw.formData().catch(() => null);
  const entryId = form?.get("entry_id");
  if (typeof entryId === "string" && entryId) {
    const stake = clampStake(Number(form?.get("stake")));
    const target = await findRepTargetByUserId(c.var.db, access.viewer.userId);
    if (target && voteGateError(target, stake) === null) {
      const result = await stub
        .castMatchVote({ matchId, voterDid: access.viewer.userId, entryId, stake })
        .catch(() => ({ status: "error" as const }));
      if (result.status === "voted") {
        await adjustRep(c.var.db, target.did, -stake).catch(() => {});
      }
    }
  }
  return c.redirect(back, 303);
}
