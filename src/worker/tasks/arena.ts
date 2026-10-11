import type { RepoQueueMessageHandle, ArenaResolveQueueMessage } from "./types";

import { createLogger, getRepoStubByDoId } from "@/worker/common";
import { createDb } from "@/worker/db/d1/client";
import { findRepositoryByDoName } from "@/worker/db/d1/dal";
import { findArenaMatchIndex, markArenaMatchResolved } from "@/worker/db/d1/dal/arena";
import { adjustRep } from "@/worker/db/d1/dal";
import { metric } from "@/worker/agent/abuse";
import { pushRefToRemote } from "@/worker/git/remote/push";
import { VOTER_FORFEIT_PCT, VOTER_POOL_SHARE, voteWeight } from "@/shared/arena";
import { CLEF_MODEL, clefProbability, clefScore, runClef } from "@/worker/agent/clef";
import { diffCommitsText } from "@/worker/api/gitness/gitdata";
import { poolAwardAndRecord, repoPoolProject } from "@/worker/compute/pool";

// Arena match resolution.
//
// Triggered when a match's judging window expires (the repo DO alarm sends
// `arena-resolve`). Computes composite scores, records the winner in the DO
// (transactional with match state), settles vote stakes, applies
// reputation deltas, and pushes the winning head to the canonical remote
// when the repo is Artifacts-backed.
//
// Composite = autoScore (0..1000) + clefQuality (0..300) + weightedVoteShare*1000.
//   autoScore: submitted (500 for a pushed head) + speed (≤300, earlier
//   last-push inside the window scores higher) + activity (≤200, saturates
//   at 4 pushes). Tie-break: higher vote share → earliest final push.
//   clefQuality: the Clef-flash judge seat — the entrant's diff is scored
//   against the match spec (spec-fit on a 4-level score + a coherence
//   probability). Missing model signal scores 0 for every entry equally,
//   so model downtime never skews a match.
//
// Stake settlement (Confetti-shaped, rep instead of money): each vote
// escrowed `stake` rep at vote time with weight stake·(1+bonus·remaining/
// window) — earlier convictions count more. Winner-side voters recover
// their stake plus a pro-rata share of the pool (loser forfeits + a slice
// of match.prizeRep); loser-side voters forfeit FORFEIT_PCT of stake.
// No winner → all stakes refund.

const SCORE_SUBMITTED = 500;
const SCORE_SPEED_MAX = 300;
const SCORE_ACTIVITY_MAX = 200;
const SCORE_QUALITY_MAX = 300;
// Judged entries per match — the diff call is one object-tree walk each.
const JUDGE_MAX_ENTRIES = 8;
const JUDGE_DIFF_MAX_CHARS = 8000;
const ENTRANT_PARTICIPATION_REP = 5;
const VOTER_PARTICIPATION_REP = 1;

interface EntryScore {
  entryId: string;
  entrantDid: string;
  autoScore: number;
  qualityScore: number;
  voteCount: number;
  voteWeight: number;
  composite: number;
  lastPushAt: number;
}

/**
 * Clef judge seat: scores each submitted entry against the match spec.
 * The state is the spec plus the entrant's full diff (empty-tree base —
 * arena entries are whole submissions, and the total is what satisfies a
 * spec like "build a landing page with X"). Returns entryId → 0..1 fit,
 * with absent/errored entries simply missing from the map.
 */
async function judgeEntries(
  env: Env,
  match: { spec: string },
  doName: string,
  entries: { id: string; headOid: string | null }[]
): Promise<Map<string, number>> {
  const fits = new Map<string, number>();
  const submitted = entries.filter((e) => e.headOid).slice(0, JUDGE_MAX_ENTRIES);
  for (const entry of submitted) {
    const diff = await diffCommitsText(env, doName, undefined, entry.headOid!).catch(
      () => undefined
    );
    if (!diff) continue;
    const answers = await runClef(
      env,
      {
        spec: match.spec.slice(0, 4000),
        submission_diff: diff.slice(0, JUDGE_DIFF_MAX_CHARS),
      },
      {
        spec_fit: {
          type: "score",
          instructions: "How well does the submission satisfy the match spec?",
          criteria: [
            "Off-spec or no relevant change",
            "Partially addresses the spec",
            "Mostly satisfies the spec",
            "Fully satisfies the spec",
          ],
        },
        coherent: {
          type: "noul",
          instructions:
            "The submission is coherent, well-formed, and free of placeholder or broken content.",
        },
      }
    );
    const specFit = clefScore(answers, "spec_fit", 4);
    const coherent = clefProbability(answers, "coherent");
    if (specFit !== undefined || coherent !== undefined) {
      fits.set(entry.id, 0.7 * (specFit ?? 0) + 0.3 * (coherent ?? 0));
    }
  }
  return fits;
}

export async function handleArenaResolveMessage(
  message: Omit<RepoQueueMessageHandle<ArenaResolveQueueMessage>, "body">,
  body: ArenaResolveQueueMessage,
  env: Env
): Promise<void> {
  const log = createLogger(env.LOG_LEVEL, { service: "ArenaResolve" });
  const stub = getRepoStubByDoId(env, body.doId);
  const detail = await stub.getMatch(body.matchId);
  if (!detail) {
    log.warn("arena-resolve:match-missing", { matchId: body.matchId });
    message.ack();
    return;
  }
  const { match, entries, votes } = detail;

  // --- composite scoring ---------------------------------------------------
  // Votes carry weight: stake × conviction bonus (earlier votes weigh more
  // within the judging window). voteShare uses weighted sums so a small
  // early-staked minority can't be swamped by late pile-ons.
  const windowMs = Math.max(match.windowMinutes * 60 * 1000, 1);
  const endsAt = match.endsAt ?? Date.now();
  const judgeEndsAt = match.judgeEndsAt ?? endsAt;
  const judgeWindowMs = Math.max(judgeEndsAt - endsAt, 1);
  const weights = new Map<string, { weight: number; count: number }>();
  let totalWeight = 0;
  const weightOf = new Map<string, number>();
  for (const vote of votes) {
    const w = voteWeight({
      stake: Math.max(1, vote.stake),
      votedAt: vote.createdAt,
      judgeEndsAt,
      judgeWindowMs,
    });
    weightOf.set(vote.voterDid, w);
    totalWeight += w;
    const acc = weights.get(vote.entryId) ?? { weight: 0, count: 0 };
    acc.weight += w;
    acc.count += 1;
    weights.set(vote.entryId, acc);
  }

  // Clef judge seat — scored once per match against the entrant diffs.
  // `match.doName` is the object-store id the diff walker reads against.
  const judgeFits = await judgeEntries(env, match, match.doName, entries).catch(
    () => new Map<string, number>()
  );

  const scores: EntryScore[] = entries.map((entry) => {
    let auto = 0;
    if (entry.headOid) auto += SCORE_SUBMITTED;
    if (entry.lastPushAt && entry.firstPushAt) {
      // Earlier completion inside the window scores higher.
      const remaining = Math.max(0, endsAt - entry.lastPushAt);
      auto += Math.round((remaining / windowMs) * SCORE_SPEED_MAX);
    }
    auto += Math.min(entry.pushCount, 4) * (SCORE_ACTIVITY_MAX / 4);
    const quality = Math.round((judgeFits.get(entry.id) ?? 0) * SCORE_QUALITY_MAX);
    const agg = weights.get(entry.id) ?? { weight: 0, count: 0 };
    const voteShare = totalWeight > 0 ? agg.weight / totalWeight : 0;
    return {
      entryId: entry.id,
      entrantDid: entry.entrantDid,
      autoScore: Math.round(auto),
      qualityScore: quality,
      voteCount: agg.count,
      voteWeight: Math.round(agg.weight * 100) / 100,
      composite: Math.round(auto + quality + voteShare * 1000),
      lastPushAt: entry.lastPushAt ?? 0,
    };
  });
  if (judgeFits.size > 0) {
    log.info("arena-resolve:clef-judged", {
      matchId: body.matchId,
      model: CLEF_MODEL,
      judged: judgeFits.size,
    });
  }

  scores.sort((a, b) => {
    if (b.composite !== a.composite) return b.composite - a.composite;
    if (b.voteWeight !== a.voteWeight) return b.voteWeight - a.voteWeight;
    // Earliest final push wins ties.
    return (a.lastPushAt || Number.MAX_SAFE_INTEGER) - (b.lastPushAt || Number.MAX_SAFE_INTEGER);
  });
  const winner = scores.find((score) => score.autoScore > 0) ?? null;

  // --- stake settlement (computed pre-resolve so it lands in the op-log) --
  // Winner gets (1 − VOTER_POOL_SHARE) of prizeRep; the pool slice plus
  // loser-side forfeits distribute to winner-side voters pro-rata by vote
  // weight. Every voter still earns flat participation rep.
  const winnerPrize = Math.floor(match.prizeRep * (1 - VOTER_POOL_SHARE));
  const voterPoolSeed = match.prizeRep - winnerPrize;
  const winningVotes = winner ? votes.filter((v) => v.entryId === winner.entryId) : [];
  const losingVotes = winner ? votes.filter((v) => v.entryId !== winner.entryId) : [];
  const winningWeight = winningVotes.reduce((n, v) => n + (weightOf.get(v.voterDid) ?? v.stake), 0);
  // Pool = seeded slice + every forfeited rep.
  const forfeits = losingVotes.reduce(
    (n, v) => n + Math.floor((v.stake * VOTER_FORFEIT_PCT) / 100),
    0
  );
  const pool = voterPoolSeed + forfeits;
  const payouts: Record<string, number> = {};

  if (!winner) {
    // No submission survived scoring — return every escrowed stake.
    for (const vote of votes) payouts[vote.voterDid] = vote.stake;
  } else {
    for (const vote of winningVotes) {
      const w = weightOf.get(vote.voterDid) ?? vote.stake;
      const share = winningWeight > 0 ? Math.floor((w / winningWeight) * pool) : 0;
      payouts[vote.voterDid] = vote.stake + share;
    }
    for (const vote of losingVotes) {
      payouts[vote.voterDid] = vote.stake - Math.floor((vote.stake * VOTER_FORFEIT_PCT) / 100);
    }
  }

  const resolved = await stub.resolveMatch({
    matchId: body.matchId,
    winnerEntryId: winner?.entryId ?? null,
    scores: scores.map((s) => ({
      entryId: s.entryId,
      autoScore: s.autoScore,
      qualityScore: s.qualityScore,
      voteCount: s.voteCount,
      voteWeight: s.voteWeight,
    })),
    settlement: {
      pool,
      forfeits,
      winnerPrize,
      voterPoolSeed,
      payouts,
    },
    actor: "arena-resolve",
  });
  if (resolved.status === "already-resolved") {
    message.ack();
    return;
  }

  const db = createDb(env.DB);
  // Keep the /arena feed index current — the DO is authoritative; this row
  // is a read model for the global feed.
  await markArenaMatchResolved(db, body.matchId, winner?.entryId ?? null).catch(() => {});

  // --- apply reputation deltas ---------------------------------------------
  for (const score of scores) {
    const delta = ENTRANT_PARTICIPATION_REP + (score.entryId === winner?.entryId ? winnerPrize : 0);
    await adjustRep(db, score.entrantDid, delta).catch(() => false);
  }
  for (const [voter, payout] of Object.entries(payouts)) {
    await adjustRep(db, voter, payout + VOTER_PARTICIPATION_REP).catch(() => false);
  }

  // --- funded prize award (Slop-style "pay for what merges") ---------------
  // Matches may carry prizeWei — a USDC micro-unit pool funded through the
  // compute coordinator's patronage lane (fund:"award"). Split it across
  // every entry that actually submitted, weighted by composite score — the
  // coordinator's largest-remainder allocator keeps the total exact. The
  // ref `match:<id>` is idempotent so resolve retries never double-pay.
  // Unfunded pools record `unfunded` in the op-log instead of failing.
  // The feed index denormalizes the owner/repo slugs the pool project
  // name needs — cheaper than joining namespaces for the repo row here.
  const matchIndex = await findArenaMatchIndex(db, body.matchId).catch(() => undefined);
  if (winner && match.prizeWei && matchIndex) {
    const split = scores
      .filter((s) => s.autoScore > 0)
      .map((s) => ({ did: s.entrantDid, score: Math.max(1, s.composite) }));
    await poolAwardAndRecord(env, {
      project: repoPoolProject(matchIndex.ownerSlug, matchIndex.repoSlug),
      ref: `match:${body.matchId}`,
      split,
      amountWei: match.prizeWei,
      reason: "arena-winner",
      recordAward: (record) => stub.recordAward(record),
      actor: "arena-resolve",
    }).catch(() => null);
  }

  // --- merge-out: winner head → canonical remote ----------------------------
  // For Artifacts repos the winning workspace objects are already mirrored
  // into the DO (the push event fetched them); push the winner's head to
  // the canonical remote's default branch with a minted write token.
  let mergeOut = "skipped";
  const doName = body.repoId ?? match.doName;
  const repo = await findRepositoryByDoName(db, doName).catch(() => undefined);
  if (winner && repo?.backend === "artifacts" && repo.artifactsName && env.ARTIFACTS) {
    const winning = entries.find((e) => e.id === winner.entryId);
    if (winning?.headOid) {
      try {
        const artifactsRepo = await env.ARTIFACTS.get(repo.artifactsName);
        const token = await artifactsRepo.createToken("write", 300);
        // Push target = the canonical repo's stored head ref (the default
        // branch it was created with).
        const head = await stub.getHead();
        const targetRef = head?.target ?? "refs/heads/main";
        const result = await pushRefToRemote(
          env,
          doName,
          repo.artifactsRemote ?? artifactsRepo.remote,
          targetRef,
          winning.headOid,
          fetch,
          { Authorization: `Bearer ${token.plaintext}` }
        );
        mergeOut = result.ok ? "pushed" : `push-failed:${result.detail}`;
        if (!result.ok) {
          // Non-fast-forward or transient failure — mint a merge intent so
          // the adjudication lane resolves it like any other divergence.
          await stub.recordWorkspacePush({
            artifactsName: winning.workspaceName,
            headOid: winning.headOid,
            actor: "arena-resolve",
          });
          message.retry();
          return;
        }
      } catch (e) {
        mergeOut = `push-error:${String(e).slice(0, 80)}`;
        log.warn("arena-resolve:merge-out-failed", { error: String(e) });
        message.retry();
        return;
      }
    }
  }

  metric(env, "arena.resolve", { scope: repo?.slug ?? doName, index: body.matchId });
  log.info("arena-resolve:done", {
    matchId: body.matchId,
    winner: winner?.entryId ?? null,
    mergeOut,
    scores: scores.length,
  });
  message.ack();
}
