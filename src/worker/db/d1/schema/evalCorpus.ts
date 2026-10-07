import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { repositories } from "./repositories";

// Evaluation corpus — the self-improvement loop's raw material. Every
// adjudication that ran on a public repo can contribute a sample: the
// conflict inputs, which engine produced the merged content (worker pool vs
// Workers AI), and how the vote resolved. An offline harness then replays
// these samples against routing/prompt/policy changes to measure quality
// and throughput drift — regression gates, not vibes.
//
// Rows are only written for public repos. Private/E2E content never leaves
// the repo DO, so corpus writes are visibility-gated the same way pool
// dispatch is.

export type EvalEngine = "compute-pool" | "workers-ai" | "mixed";
export type EvalOutcome = "merged" | "conflict" | "rejected" | "expired";

export const evalCorpus = sqliteTable(
  "eval_corpus",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    // The merge intent this sample came from (nullable — corpus rows can
    // outlive intent GC for longer eval windows).
    intentId: text("intent_id"),
    // Which engine produced the merge content — pool, workers-ai, or a
    // per-file mix.
    engine: text("engine").notNull().$type<EvalEngine>(),
    // Canonical JSON of {path, ours, theirs} pairs used as the prompt —
    // truncated per-file so one row stays bounded.
    input: text("input").notNull(),
    // Canonical JSON of {path: merged} pairs produced.
    output: text("output"),
    // Final intent resolution once known.
    outcome: text("outcome").$type<EvalOutcome>(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_eval_corpus_repo").on(t.repositoryId, t.createdAt),
    index("idx_eval_corpus_intent").on(t.intentId),
  ]
);

export type EvalCorpusRow = typeof evalCorpus.$inferSelect;
export type NewEvalCorpusRow = typeof evalCorpus.$inferInsert;
