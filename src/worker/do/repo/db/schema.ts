import { sql, desc } from "drizzle-orm";
import { sqliteTable, text, primaryKey, index, check, integer } from "drizzle-orm/sqlite-core";

export const packCatalog = sqliteTable(
  "pack_catalog",
  {
    packKey: text("pack_key").notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    tier: integer("tier").notNull(),
    seqLo: integer("seq_lo").notNull(),
    seqHi: integer("seq_hi").notNull(),
    objectCount: integer("object_count").notNull(),
    packBytes: integer("pack_bytes").notNull(),
    idxBytes: integer("idx_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
    supersededBy: text("superseded_by"),
  },
  (t) => [
    primaryKey({ columns: [t.packKey], name: "pack_catalog_pk" }),
    index("idx_pack_catalog_state_seqhi").on(t.state, desc(t.seqHi)),
    index("idx_pack_catalog_state_tier_seqlo").on(t.state, t.tier, t.seqLo),
    check("chk_pack_catalog_kind", sql`"kind" IN ('receive','compact','legacy')`),
    check("chk_pack_catalog_state", sql`"state" IN ('active','superseded')`),
    check("chk_pack_catalog_tier", sql`"tier" >= 0`),
    check("chk_pack_catalog_seq", sql`"seq_lo" <= "seq_hi"`),
    check("chk_pack_catalog_object_count", sql`"object_count" >= 0`),
    check("chk_pack_catalog_pack_bytes", sql`"pack_bytes" >= 0`),
    check("chk_pack_catalog_idx_bytes", sql`"idx_bytes" >= 0`),
  ]
);

export type PackCatalogRow = typeof packCatalog.$inferSelect;

// ---------------------------------------------------------------------------
// delta-git agent layer
// ---------------------------------------------------------------------------
// These tables are per-repository state: they live in this repo's Durable
// Object SQLite so merge/adjudication rows are strongly consistent with the
// refs that produced them. Global cross-repo identity (agents, reputation)
// lives in the worker D1 database instead.

export const mergeIntents = sqliteTable(
  "merge_intents",
  {
    id: text("id").notNull(),
    // Ref the pushed commits diverged from (e.g. refs/heads/main).
    targetRef: text("target_ref").notNull(),
    // Commit currently at targetRef when the intent was minted.
    baseOid: text("base_oid").notNull(),
    // The delta ref that captured the pushed work (refs/delta/<id>).
    deltaRef: text("delta_ref").notNull(),
    deltaOid: text("delta_oid").notNull(),
    // Agent DID (or PAT subject) that pushed the divergent work.
    actor: text("actor").notNull(),
    status: text("status").notNull(),
    // Comma-joined conflicted paths once a merge attempt ran.
    conflicts: text("conflicts"),
    resultOid: text("result_oid"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "merge_intents_pk" }),
    index("idx_merge_intents_status_expiry").on(t.status, t.expiresAt),
    index("idx_merge_intents_target_status").on(t.targetRef, t.status),
    check(
      "chk_merge_intents_status",
      sql`"status" IN ('open','merging','adjudicating','merged','conflict','expired','rejected')`
    ),
  ]
);

export type MergeIntentRow = typeof mergeIntents.$inferSelect;

export const mergeVotes = sqliteTable(
  "merge_votes",
  {
    intentId: text("intent_id").notNull(),
    // Which quorum seat this vote occupies (1..k).
    seat: integer("seat").notNull(),
    voterDid: text("voter_did").notNull(),
    // Canonical JSON digest of the resolution the voter proposes.
    resolutionDigest: text("resolution_digest").notNull(),
    rationale: text("rationale"),
    signature: text("signature").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.intentId, t.seat], name: "merge_votes_pk" }),
    index("idx_merge_votes_intent_digest").on(t.intentId, t.resolutionDigest),
    check("chk_merge_votes_seat", sql`"seat" >= 1`),
  ]
);

export type MergeVoteRow = typeof mergeVotes.$inferSelect;

// Append-only, hash-chained operation log. Every mutation the agent layer
// performs (push accepted as delta, merge attempt, adjudication verdict,
// rep change, status write) lands one row here so external observers can
// replay the repository's full history of coordination events.
export const opLog = sqliteTable(
  "op_log",
  {
    seq: integer("seq").notNull(),
    // sha256(prev_hash || canonical payload) — the chain link.
    hash: text("hash").notNull(),
    prevHash: text("prev_hash").notNull(),
    kind: text("kind").notNull(),
    actor: text("actor"),
    // Canonical JSON payload for the event.
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seq], name: "op_log_pk" }),
    index("idx_op_log_kind_created").on(t.kind, t.createdAt),
    check("chk_op_log_seq", sql`"seq" >= 0`),
  ]
);

export type OpLogRow = typeof opLog.$inferSelect;

export const workIntents = sqliteTable(
  "work_intents",
  {
    id: text("id").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    createdBy: text("created_by").notNull(),
    // "work" (default claimable task) | "idea" (free-text proposal) |
    // "issue" (bug report surfaced via XRPC) | "verify" (verification ask).
    kind: text("kind").notNull().default("work"),
    // Optional at:// URI or URL the intent was imported from.
    sourceUri: text("source_uri"),
    // Free-form outcome record (spec text, verdict, landed sha) written by
    // the actor that processed the intent.
    result: text("result"),
    status: text("status").notNull(),
    claimedBy: text("claimed_by"),
    claimExpiresAt: integer("claim_expires_at"),
    createdAt: integer("created_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "work_intents_pk" }),
    index("idx_work_intents_status").on(t.status),
    index("idx_work_intents_kind_status").on(t.kind, t.status),
    check("chk_work_intents_status", sql`"status" IN ('open','claimed','closed','verified')`),
    check("chk_work_intents_kind", sql`"kind" IN ('work','idea','issue','verify')`),
  ]
);

export type WorkIntentRow = typeof workIntents.$inferSelect;

export const commitStatus = sqliteTable(
  "commit_status",
  {
    sha: text("sha").notNull(),
    context: text("context").notNull(),
    state: text("state").notNull(),
    description: text("description"),
    targetUrl: text("target_url"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sha, t.context], name: "commit_status_pk" }),
    check("chk_commit_status_state", sql`"state" IN ('pending','success','failure','error')`),
  ]
);

export type CommitStatusRow = typeof commitStatus.$inferSelect;

export const webhookSubs = sqliteTable(
  "webhook_subs",
  {
    id: text("id").notNull(),
    url: text("url").notNull(),
    // Comma-joined event kinds, e.g. "push,merge,adjudication".
    events: text("events").notNull(),
    secret: text("secret"),
    createdBy: text("created_by").notNull(),
    active: integer("active").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "webhook_subs_pk" }),
    index("idx_webhook_subs_active").on(t.active),
    check("chk_webhook_subs_active", sql`"active" IN (0,1)`),
  ]
);

export type WebhookSubRow = typeof webhookSubs.$inferSelect;

// Repository secrets follow the Cloudflare `wrangler secret` contract:
// write-only over the API, never readable back, injected as secret_text
// bindings at deploy time. Only the AES-GCM ciphertext is stored here;
// the KEK lives in the worker secret DG_KEK.
export const repoSecrets = sqliteTable(
  "repo_secrets",
  {
    name: text("name").notNull(),
    // base64(nonce || ciphertext) of the AES-GCM encrypted value.
    ciphertext: text("ciphertext").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.name], name: "repo_secrets_pk" })]
);

export type RepoSecretRow = typeof repoSecrets.$inferSelect;
