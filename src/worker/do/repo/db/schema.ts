import { sql, desc } from "drizzle-orm";
import {
  sqliteTable,
  text,
  primaryKey,
  index,
  uniqueIndex,
  check,
  integer,
} from "drizzle-orm/sqlite-core";

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

// ---------------------------------------------------------------------------
// Artifacts workspaces + competitive arena
// ---------------------------------------------------------------------------
// A workspace is an Artifacts fork used as an agent sandbox ("one repo per
// unit of autonomous work"). Rows live in the *canonical* repo's DO so they
// are consistent with the merge intents they produce. The fork name encodes
// the canonical Artifacts name (`ws-<dg-name>-<rand>`) so push events routed
// by repo name can find their home repo without a global index.

export const workspaces = sqliteTable(
  "workspaces",
  {
    artifactsName: text("artifacts_name").notNull(),
    // "task" = free work-intent workspace, "arena" = match entry.
    kind: text("kind").notNull(),
    ownerDid: text("owner_did").notNull(),
    workIntentId: text("work_intent_id"),
    matchId: text("match_id"),
    // Last observed head commit of the fork's default branch.
    headOid: text("head_oid"),
    pushCount: integer("push_count").notNull().default(0),
    firstPushAt: integer("first_push_at"),
    lastPushAt: integer("last_push_at"),
    // open | merged | expired | deleted
    status: text("status").notNull().default("open"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactsName], name: "workspaces_pk" }),
    index("idx_workspaces_match").on(t.matchId),
    index("idx_workspaces_status").on(t.status),
    check("chk_workspaces_kind", sql`"kind" IN ('task','arena')`),
    check("chk_workspaces_status", sql`"status" IN ('open','merged','expired','deleted')`),
  ]
);

export type WorkspaceRow = typeof workspaces.$inferSelect;

// Time-boxed competitive match: same brief → one workspace fork per entrant
// → composite judging (auto-signals + blind votes) → winner merged into the
// canonical repo.
export const matches = sqliteTable(
  "matches",
  {
    id: text("id").notNull(),
    // The owning repo's DO *name* — the alarm path emits resolve queue
    // messages that need it for `idFromName`-based object reads.
    doName: text("do_name").notNull(),
    title: text("title").notNull(),
    // Markdown brief shared by every entrant.
    spec: text("spec").notNull(),
    // open (recruiting) → building (time-boxed) → judging → resolved | expired
    status: text("status").notNull().default("open"),
    windowMinutes: integer("window_minutes").notNull(),
    judgeMinutes: integer("judge_minutes").notNull(),
    maxEntrants: integer("max_entrants").notNull(),
    prizeRep: integer("prize_rep").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    endsAt: integer("ends_at"),
    judgeEndsAt: integer("judge_ends_at"),
    winnerEntryId: text("winner_entry_id"),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "matches_pk" }),
    index("idx_matches_status").on(t.status, t.endsAt),
    check(
      "chk_matches_status",
      sql`"status" IN ('open','building','judging','resolved','expired')`
    ),
  ]
);

export type MatchRow = typeof matches.$inferSelect;

export const matchEntries = sqliteTable(
  "match_entries",
  {
    id: text("id").notNull(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    entrantDid: text("entrant_did").notNull(),
    // Artifacts fork name for this entry's sandbox.
    workspaceName: text("workspace_name").notNull(),
    headOid: text("head_oid"),
    pushCount: integer("push_count").notNull().default(0),
    firstPushAt: integer("first_push_at"),
    lastPushAt: integer("last_push_at"),
    // Composite auto-score in milli-points (0..1000): preview reachable,
    // wall-clock, commit signal. Filled at judging.
    autoScore: integer("auto_score").notNull().default(0),
    voteCount: integer("vote_count").notNull().default(0),
    won: integer("won").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "match_entries_pk" }),
    index("idx_match_entries_match").on(t.matchId),
    index("idx_match_entries_did").on(t.entrantDid),
    // One entry per entrant per match.
    uniqueIndex("uq_match_entries_match_did").on(t.matchId, t.entrantDid),
  ]
);

export type MatchEntryRow = typeof matchEntries.$inferSelect;

export const matchVotes = sqliteTable(
  "match_votes",
  {
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    voterDid: text("voter_did").notNull(),
    entryId: text("entry_id").notNull(),
    // Rep escrowed at vote time (Confetti-style stake-to-vote). Settled by
    // the arena-resolve task: winner-side voters get stake back plus a
    // pro-rata pool share; loser-side voters forfeit a fraction. The DO
    // records the stake; rep actually moves in D1 via the route/task.
    stake: integer("stake").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.voterDid], name: "match_votes_pk" }),
    index("idx_match_votes_entry").on(t.entryId),
  ]
);

export type MatchVoteRow = typeof matchVotes.$inferSelect;

// Idempotency for at-least-once queue deliveries (Artifacts lifecycle
// events). Event ids are Cloudflare-assigned and globally unique.
export const processedEvents = sqliteTable(
  "processed_events",
  {
    eventId: text("event_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId], name: "processed_events_pk" })]
);

export type ProcessedEventRow = typeof processedEvents.$inferSelect;

// ---------------------------------------------------------------------------
// Issues — GitHub-shaped tracker backed by this repo's DO
// ---------------------------------------------------------------------------
// Every issue materializes a `work_intents` row (kind='issue') so the
// GitHub-familiar UX and the agent-native claim lane stay one source of
// truth. `number` is a per-repo sequence (this SQLite db is scoped to one
// repo, so a plain unique constraint is a global unique issue number).

export const issues = sqliteTable(
  "issues",
  {
    id: text("id").notNull(),
    // Per-repo monotonic issue number — the GitHub `#42` people reference.
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    // open | closed — state_reason refines a close (completed|not_planned)
    // and records "reopened" when a closed issue is reopened.
    state: text("state").notNull().default("open"),
    stateReason: text("state_reason"),
    author: text("author").notNull(),
    // Materialized work_intents.id — agents claim/close through this row.
    workIntentId: text("work_intent_id"),
    milestoneId: text("milestone_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    closedAt: integer("closed_at"),
    closedBy: text("closed_by"),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "issues_pk" }),
    uniqueIndex("uq_issues_number").on(t.number),
    index("idx_issues_state_number").on(t.state, desc(t.number)),
    index("idx_issues_milestone").on(t.milestoneId),
    index("idx_issues_work_intent").on(t.workIntentId),
    check("chk_issues_state", sql`"state" IN ('open','closed')`),
    check(
      "chk_issues_state_reason",
      sql`"state_reason" IS NULL OR "state_reason" IN ('completed','not_planned','reopened')`
    ),
    check("chk_issues_number", sql`"number" > 0`),
  ]
);

export type IssueRow = typeof issues.$inferSelect;

export const issueComments = sqliteTable(
  "issue_comments",
  {
    id: text("id").notNull(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    author: text("author").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "issue_comments_pk" }),
    index("idx_issue_comments_issue").on(t.issueId, t.createdAt),
  ]
);

export type IssueCommentRow = typeof issueComments.$inferSelect;

export const issueAssignees = sqliteTable(
  "issue_assignees",
  {
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    assignee: text("assignee").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.assignee], name: "issue_assignees_pk" }),
    index("idx_issue_assignees_user").on(t.assignee),
  ]
);

export type IssueAssigneeRow = typeof issueAssignees.$inferSelect;

// Repo-scoped label registry. `name` is unique per repo (this db IS the
// repo); color is a bare hex string like GitHub's label model.
export const labels = sqliteTable(
  "labels",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    description: text("description"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "labels_pk" }),
    uniqueIndex("uq_labels_name").on(t.name),
  ]
);

export type LabelRow = typeof labels.$inferSelect;

export const issueLabels = sqliteTable(
  "issue_labels",
  {
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.labelId], name: "issue_labels_pk" }),
    index("idx_issue_labels_label").on(t.labelId),
  ]
);

export type IssueLabelRow = typeof issueLabels.$inferSelect;

// Milestones are numbered like issues so URLs read `/milestones/2`.
export const milestones = sqliteTable(
  "milestones",
  {
    id: text("id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    state: text("state").notNull().default("open"),
    dueOn: integer("due_on"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "milestones_pk" }),
    uniqueIndex("uq_milestones_number").on(t.number),
    index("idx_milestones_state").on(t.state),
    check("chk_milestones_state", sql`"state" IN ('open','closed')`),
    check("chk_milestones_number", sql`"number" > 0`),
  ]
);

export type MilestoneRow = typeof milestones.$inferSelect;

// Emoji reactions keyed by (target, reaction, actor) so a toggle is a plain
// insert/delete and aggregation is a group-by. target_type is extensible —
// issue comments today; discussions/PRs reuse the same table later.
export const reactions = sqliteTable(
  "reactions",
  {
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    // GitHub's eight: +1 -1 laugh hooray confused heart rocket eyes
    reaction: text("reaction").notNull(),
    actor: text("actor").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.targetType, t.targetId, t.reaction, t.actor],
      name: "reactions_pk",
    }),
    index("idx_reactions_target").on(t.targetType, t.targetId),
    check(
      "chk_reactions_type",
      sql`"target_type" IN ('issue','issue_comment','merge_intent','work_intent','discussion','discussion_comment')`
    ),
    check(
      "chk_reactions_kind",
      sql`"reaction" IN ('+1','-1','laugh','hooray','confused','heart','rocket','eyes')`
    ),
  ]
);

export type ReactionRow = typeof reactions.$inferSelect;

// Discussions — GitHub's threaded community surface. Unlike issues they
// carry no open/closed state (GitHub discussions aren't closed, they're
// answered); `answer_comment_id` marks the accepted reply for Q&A topics.
// Numbering is its own sequence (GitHub numbers discussions separately
// from issues).
export const discussions = sqliteTable(
  "discussions",
  {
    id: text("id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    // GitHub's default category set; repo-defined categories are a later
    // extension (needs a categories table).
    category: text("category").notNull().default("general"),
    author: text("author").notNull(),
    answerCommentId: text("answer_comment_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "discussions_pk" }),
    uniqueIndex("uq_discussions_number").on(t.number),
    index("idx_discussions_category").on(t.category, desc(t.number)),
    index("idx_discussions_created").on(desc(t.createdAt)),
    check(
      "chk_discussions_category",
      sql`"category" IN ('general','announcements','ideas','q-a','show-and-tell','polls')`
    ),
    check("chk_discussions_number", sql`"number" > 0`),
  ]
);

export type DiscussionRow = typeof discussions.$inferSelect;

export const discussionComments = sqliteTable(
  "discussion_comments",
  {
    id: text("id").notNull(),
    discussionId: text("discussion_id")
      .notNull()
      .references(() => discussions.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    author: text("author").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "discussion_comments_pk" }),
    index("idx_discussion_comments_discussion").on(t.discussionId, t.createdAt),
  ]
);

export type DiscussionCommentRow = typeof discussionComments.$inferSelect;
