import { z } from "zod";

export { z };

export type RepoQueueMessageHandle<Body> = MessageBatch<Body>["messages"][number];

export const CompactionQueueMessageSchema = z.object({
  kind: z.literal("compaction"),
  doId: z.string(),
  repoId: z.string().optional(),
});

export type CompactionQueueMessage = z.infer<typeof CompactionQueueMessageSchema>;

export const CompactionDeleteQueueMessageSchema = z.object({
  kind: z.literal("compaction-delete"),
  doId: z.string(),
  repoId: z.string().optional(),
  packKeys: z.array(z.string()),
});

export type CompactionDeleteQueueMessage = z.infer<typeof CompactionDeleteQueueMessageSchema>;

export const PackRefBackfillQueueMessageSchema = z.object({
  kind: z.literal("pack-ref-backfill"),
  doId: z.string(),
  repoId: z.string().optional(),
  packKey: z.string(),
});

export type PackRefBackfillQueueMessage = z.infer<typeof PackRefBackfillQueueMessageSchema>;

export const RouteCacheSyncMessageSchema = z.object({
  kind: z.literal("route-cache-sync"),
  repositoryId: z.string(),
  namespaceSlug: z.string(),
  repoSlug: z.string(),
  enqueuedAt: z.number(),
});

export type RouteCacheSyncMessage = z.infer<typeof RouteCacheSyncMessageSchema>;

export const RepositoryDeleteMessageSchema = z.object({
  kind: z.literal("repository-delete"),
  repositoryId: z.string(),
  namespaceId: z.string(),
  namespaceSlug: z.string(),
  repoSlug: z.string(),
  doName: z.string(),
  actor: z.string(),
  requestedAt: z.number(),
});

export type RepositoryDeleteMessage = z.infer<typeof RepositoryDeleteMessageSchema>;

export const WebhookQueueMessageSchema = z.object({
  kind: z.literal("webhook"),
  doId: z.string(),
  repoId: z.string().optional(),
  url: z.string(),
  secret: z.string().nullable().optional(),
  event: z.object({
    kind: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }),
});

export type WebhookQueueMessage = z.infer<typeof WebhookQueueMessageSchema>;

export const DeployQueueMessageSchema = z.object({
  kind: z.literal("deploy"),
  doId: z.string(),
  repoId: z.string().optional(),
  ref: z.string(),
  sha: z.string(),
  actor: z.string().optional(),
});

export type DeployQueueMessage = z.infer<typeof DeployQueueMessageSchema>;

export const AdjudicateQueueMessageSchema = z.object({
  kind: z.literal("adjudicate"),
  doId: z.string(),
  repoId: z.string().optional(),
  intentId: z.string(),
  seatDid: z.string(),
});

export type AdjudicateQueueMessage = z.infer<typeof AdjudicateQueueMessageSchema>;

// Federation mirror-out: a public ref advanced → push the delta to
// configured mirror targets (Tangled, Radicle, or a signed webhook relay).
export const FederateQueueMessageSchema = z.object({
  kind: z.literal("federate"),
  doId: z.string(),
  repoId: z.string().optional(),
  // The public ref that moved.
  ref: z.string(),
  sha: z.string(),
  // Named mirror targets (see docs/federation.md). Empty = all configured.
  targets: z.array(z.string()).optional(),
});

export type FederateQueueMessage = z.infer<typeof FederateQueueMessageSchema>;

// Overnight self-improvement pass: pick open idea work-intents and drive
// idea → spec → patch → verify → merge → attest through the normal lanes.
export const OvernightQueueMessageSchema = z.object({
  kind: z.literal("overnight"),
  doId: z.string(),
  repoId: z.string().optional(),
  // Optional work-intent id to process; absent = sweep all open ideas.
  workIntentId: z.string().optional(),
});

export type OvernightQueueMessage = z.infer<typeof OvernightQueueMessageSchema>;

// Arena resolution: a match's judging window expired → the task computes
// composite scores (auto-signals + votes), marks the winner, applies rep
// deltas, and pushes the winning head to the canonical remote.
export const ArenaResolveQueueMessageSchema = z.object({
  kind: z.literal("arena-resolve"),
  // Repo DO id (hex) — the canonical repo that owns the match.
  doId: z.string(),
  // Repo DO *name* — required for object reads (idFromName routing).
  repoId: z.string().optional(),
  matchId: z.string(),
});

export type ArenaResolveQueueMessage = z.infer<typeof ArenaResolveQueueMessageSchema>;

// Site-smith build: the work intent's body is a natural-language site
// description; the seat generates a WordPress Playground blueprint + block
// theme + static mirror and lands it via the normal merge lanes.
export const SiteBuildQueueMessageSchema = z.object({
  kind: z.literal("site-build"),
  doId: z.string(),
  repoId: z.string().optional(),
  workIntentId: z.string(),
});

export type SiteBuildQueueMessage = z.infer<typeof SiteBuildQueueMessageSchema>;

export const RepoTaskQueueMessageSchema = z.discriminatedUnion("kind", [
  CompactionQueueMessageSchema,
  CompactionDeleteQueueMessageSchema,
  PackRefBackfillQueueMessageSchema,
  RouteCacheSyncMessageSchema,
  RepositoryDeleteMessageSchema,
  WebhookQueueMessageSchema,
  DeployQueueMessageSchema,
  AdjudicateQueueMessageSchema,
  FederateQueueMessageSchema,
  OvernightQueueMessageSchema,
  ArenaResolveQueueMessageSchema,
  SiteBuildQueueMessageSchema,
]);

export type RepoTaskQueueMessage = z.infer<typeof RepoTaskQueueMessageSchema>;
