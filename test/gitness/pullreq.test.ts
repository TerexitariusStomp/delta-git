import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mergeIntentToPullReq } from "@/worker/api/gitness/pullreq";
import type { MergeIntentRow } from "@/worker/do/repo/db/schema";

// zod mirror of the client's `TypesPullReq` fields we populate — proves our
// translator output satisfies the gitness contract.
const PullReqSchema = z.object({
  number: z.number(),
  title: z.string(),
  description: z.string(),
  state: z.enum(["closed", "merged", "open"]),
  is_draft: z.boolean(),
  author: z.object({ uid: z.string(), display_name: z.string() }),
  source_branch: z.string(),
  source_sha: z.string(),
  target_branch: z.string(),
  merge_base_sha: z.string(),
  merge_check_status: z.string(),
  merge_conflicts: z.array(z.string()).nullable(),
  stats: z.object({
    additions: z.number().nullable(),
    deletions: z.number().nullable(),
    files_changed: z.number().nullable(),
    commits: z.number().nullable(),
    conversations: z.number(),
    unresolved_count: z.number(),
  }),
  created: z.number(),
  edited: z.number(),
  closed: z.number().nullable(),
  merged: z.number().nullable(),
});

const baseIntent: MergeIntentRow = {
  id: "mi-abc123",
  targetRef: "refs/heads/main",
  baseOid: "a".repeat(40),
  deltaRef: "refs/delta/mi-abc123",
  deltaOid: "b".repeat(40),
  actor: "did:dg:agent:xyz",
  status: "conflict",
  conflicts: "src/a.ts,src/b.ts",
  resultOid: null,
  createdAt: 1700000000000,
  expiresAt: 1700086400000,
  resolvedAt: null,
};

describe("mergeIntentToPullReq", () => {
  it("maps a conflicted intent to an open pullreq with conflict state", () => {
    const pr = mergeIntentToPullReq({ intent: baseIntent, number: 7 });
    const parsed = PullReqSchema.safeParse(pr);
    expect(parsed.success).toBe(true);
    expect(pr.state).toBe("open");
    expect(pr.merge_check_status).toBe("conflict");
    expect(pr.merge_conflicts).toEqual(["src/a.ts", "src/b.ts"]);
    expect(pr.source_branch).toBe("delta/mi-abc123");
    expect(pr.target_branch).toBe("main");
  });

  it("maps terminal statuses to merged/closed", () => {
    const merged = mergeIntentToPullReq({
      intent: { ...baseIntent, status: "merged", resolvedAt: 1700001000000, conflicts: null },
      number: 1,
    });
    expect(merged.state).toBe("merged");
    expect(merged.merged).toBe(1700001000000);
    const rejected = mergeIntentToPullReq({
      intent: { ...baseIntent, status: "rejected", resolvedAt: 1700001000000 },
      number: 2,
    });
    expect(rejected.state).toBe("closed");
    expect(rejected.closed).toBe(1700001000000);
  });
});
