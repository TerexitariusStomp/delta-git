// Shared arena helpers — used by both the JSON API (routes/agent.ts) and
// the SSR pages (routes/ui/arena.ts) so blind-judging behavior is identical
// on both surfaces.

/**
 * FNV-1a hash → deterministic per-viewer entrant ordering. Stable across
 * polls, unbiased across viewers (position-bias mitigation for voting).
 */
export function arenaShuffleKey(viewer: string, matchId: string, entryId: string): number {
  const s = `${viewer}:${matchId}:${entryId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Stake-to-vote economics (shared so the API, the SSR form, and the settle
// task all agree): contribution is permissionless but a vote requires
// earned rep (VOTE_MIN_REP) plus an escrowed stake. Winner-side voters
// recover their stake plus a pro-rata share of the pool; losers forfeit
// FORFEIT_PCT of theirs. Earlier votes weigh more (CONVICTION_BONUS_MAX
// decays linearly to zero at judgeEndsAt) and earn a larger pool share.
export const VOTE_MIN_REP = 5;
export const VOTE_MIN_STAKE = 1;
/** A rep-bearing account must be this old before it can vote — fresh
 * sockpuppets can't stake what they never earned. Accounts holding
 * VOTE_AGE_BYPASS_REP skip the wait: rep that high was demonstrably
 * earned, not minted. */
export const VOTE_MIN_ACCOUNT_AGE_MS = 60 * 60 * 1000; // 1 hour
// A match winner banks participation + prize rep ≥ this — so a first-match
// winner can judge the next match without waiting out the account-age
// gate, while a fresh sockpuppet still can't reach it cheaply.
export const VOTE_AGE_BYPASS_REP = 20;

/** Shared gate decision: rep floor + stake escrow + account age. */
export function voteGateError(
  target: { rep: number; createdAt: number } | null | undefined,
  stake = VOTE_MIN_STAKE
): "insufficient-rep" | "account-too-new" | "no-identity" | null {
  if (!target) return "no-identity";
  if (target.rep < VOTE_MIN_REP + stake) return "insufficient-rep";
  if (target.rep < VOTE_AGE_BYPASS_REP && Date.now() - target.createdAt < VOTE_MIN_ACCOUNT_AGE_MS) {
    return "account-too-new";
  }
  return null;
}
export const VOTE_MAX_STAKE = 25;
export const VOTER_FORFEIT_PCT = 50;
export const VOTER_POOL_SHARE = 0.2; // slice of match.prizeRep reserved for voters
export const CONVICTION_BONUS_MAX = 1.0;

/** Clamp a client-supplied stake request into the allowed range. */
export function clampStake(raw: number | undefined | null): number {
  const n = Number.isFinite(raw) ? Math.floor(raw as number) : VOTE_MIN_STAKE;
  return Math.min(VOTE_MAX_STAKE, Math.max(VOTE_MIN_STAKE, n));
}

/**
 * Conviction weight for a vote cast at `votedAt` inside a judging window
 * ending at `judgeEndsAt`: stake × (1 + bonus·remaining/window). Earlier
 * votes earn more — Confetti's price-curve analog without money.
 */
export function voteWeight(args: {
  stake: number;
  votedAt: number;
  judgeEndsAt: number;
  judgeWindowMs: number;
}): number {
  const remaining = Math.max(0, args.judgeEndsAt - args.votedAt);
  const frac = args.judgeWindowMs > 0 ? Math.min(1, remaining / args.judgeWindowMs) : 0;
  return args.stake * (1 + CONVICTION_BONUS_MAX * frac);
}
