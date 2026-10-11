/**
 * Clef — Cloudflare's structured decision models on Workers AI.
 *
 * Clef-flash (`@cf/cloudflare/clef-flash`) is a 9B decision model: input =
 * a `state` (text/JSON/media) + a map of typed questions; output = a
 * probability for every allowed answer. Unlike the text-generation models
 * used for merge synthesis, Clef answers *decisions* — which makes it the
 * right seat for verdict and judging signals:
 *
 *   - adjudicate.ts: a second quorum seat that evaluates whether a
 *     candidate resolution preserves both sides' intent (approve → casts
 *     its seat vote for the digest; unconvinced → abstains, leaving the
 *     seat open rather than voting blind).
 *   - arena.ts: a machine judge that scores each entrant's diff against
 *     the match spec → a quality term in the composite.
 *
 * Everything here degrades gracefully: missing AI binding (tests), model
 * unavailability, or a malformed answer all resolve to `undefined`, and
 * callers treat that as "no signal" — never a hard failure.
 */

export const CLEF_MODEL = "@cf/cloudflare/clef-flash";

/** Typed question shapes from the Clef/Jev API. */
export type ClefQuestion =
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export type ClefAnswers = Record<string, unknown>;

interface ClefRunResponse {
  answers?: ClefAnswers;
}

/**
 * Run one Clef decision round. Returns the answers map, or `undefined`
 * when the model can't be reached — callers degrade to "no signal".
 */
export async function runClef(
  env: Env,
  state: unknown,
  questions: Record<string, ClefQuestion>
): Promise<ClefAnswers | undefined> {
  const ai = env.AI as Ai | undefined;
  if (typeof ai?.run !== "function") return undefined;
  try {
    const res = (await ai.run(CLEF_MODEL, {
      model: "clef-flash",
      state,
      questions,
    })) as ClefRunResponse;
    return res?.answers;
  } catch {
    return undefined;
  }
}

/**
 * Extract a 0..1 probability from a `noul` answer. The API returns a bare
 * number for noul questions, but the parser is deliberately tolerant —
 * a structured `{ probability }` or `{ answer, probability }` shape also
 * resolves, and anything unrecognized yields `undefined` (abstain).
 */
export function clefProbability(answers: ClefAnswers | undefined, id: string): number | undefined {
  const value = answers?.[id];
  if (typeof value === "number" && value >= 0 && value <= 1) return value;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const key of ["probability", "p", "score", "value"]) {
      const candidate = rec[key];
      if (typeof candidate === "number" && candidate >= 0 && candidate <= 1) return candidate;
    }
  }
  return undefined;
}

/**
 * Extract a normalized 0..1 score from a `score` answer. Clef returns a
 * probability-weighted index into the criteria list (0 = lowest level);
 * the caller passes criteria.length so the raw index maps to 0..1.
 */
export function clefScore(
  answers: ClefAnswers | undefined,
  id: string,
  levels: number
): number | undefined {
  if (levels <= 1) return undefined;
  const value = answers?.[id];
  const raw =
    typeof value === "number"
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>).score
        : undefined;
  if (typeof raw !== "number" || raw < 0) return undefined;
  return Math.min(raw / (levels - 1), 1);
}
