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

export const RepoTaskQueueMessageSchema = z.discriminatedUnion("kind", [
  CompactionQueueMessageSchema,
  CompactionDeleteQueueMessageSchema,
  PackRefBackfillQueueMessageSchema,
  RouteCacheSyncMessageSchema,
  RepositoryDeleteMessageSchema,
  WebhookQueueMessageSchema,
  DeployQueueMessageSchema,
  AdjudicateQueueMessageSchema,
]);

export type RepoTaskQueueMessage = z.infer<typeof RepoTaskQueueMessageSchema>;
