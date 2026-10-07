// Eval-corpus DAL — adjudication samples recorded for the self-improvement
// harness. Writes are fire-and-forget from the adjudication path; reads are
// for the offline evaluator and (eventually) a repo-facing quality surface.

import { desc, eq } from "drizzle-orm";

import type { Db } from "../client";
import { evalCorpus, type EvalOutcome, type NewEvalCorpusRow } from "../schema";

export async function insertEvalSample(db: Db, row: NewEvalCorpusRow): Promise<void> {
  await db.insert(evalCorpus).values(row).run();
}

export async function listEvalSamples(db: Db, repositoryId: string, limit = 100) {
  return db
    .select()
    .from(evalCorpus)
    .where(eq(evalCorpus.repositoryId, repositoryId))
    .orderBy(desc(evalCorpus.createdAt))
    .limit(limit);
}

/** Backfill the outcome once the intent resolves — corpus rows are written
 *  at adjudication time, before the merge vote settles. */
export async function markEvalOutcome(
  db: Db,
  intentId: string,
  outcome: EvalOutcome
): Promise<void> {
  await db.update(evalCorpus).set({ outcome }).where(eq(evalCorpus.intentId, intentId)).run();
}
