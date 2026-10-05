// S0.5 spike: merge-intent → gitness `TypesPullReq` translator.
//
// Proves the semantic bridge the whole facade hinges on: our divergent-push
// merge intents map onto gitness's pull-request model. Field-level gaps and
// their resolutions are documented per-field.

import type { MergeIntentRow } from "@/worker/do/repo/db/schema";

/** Gitness `EnumPullReqState` — a collapsed view of our richer status set. */
export type GitnessPullReqState = "closed" | "merged" | "open";

/** Subset of `TypesPullReq` we can honestly populate today. */
export interface GitnessPullReq {
  number: number;
  title: string;
  description: string;
  state: GitnessPullReqState;
  is_draft: boolean;
  author: { uid: string; display_name: string; email?: string };
  source_branch: string;
  source_sha: string;
  target_branch: string;
  merge_base_sha: string;
  merge_check_status: string;
  merge_conflicts: string[] | null;
  stats: {
    additions: number | null;
    deletions: number | null;
    files_changed: number | null;
    commits: number | null;
    conversations: number;
    unresolved_count: number;
  };
  created: number;
  edited: number;
  closed: number | null;
  merged: number | null;
}

const STATUS_MAP: Record<string, GitnessPullReqState> = {
  open: "open",
  merging: "open",
  adjudicating: "open",
  conflict: "open",
  merged: "merged",
  rejected: "closed",
  expired: "closed",
};

const CHECK_MAP: Record<string, string> = {
  open: "unchecked",
  merging: "running",
  adjudicating: "running",
  conflict: "conflict",
  merged: "success",
  rejected: "failure",
  expired: "failure",
};

/**
 * `ref` → display branch name (strips `refs/heads/`; delta refs become
 * `delta/<id>`). `number` is supplied by the caller from a per-repo PR
 * sequence — merge_intents has no ordinal today (see plan: new DO counter
 * or D1 pullreq mirror row).
 */
export function mergeIntentToPullReq(args: {
  intent: MergeIntentRow;
  number: number;
  title?: string;
  stats?: Partial<GitnessPullReq["stats"]>;
  unresolved?: number;
}): GitnessPullReq {
  const { intent, number, title, stats, unresolved } = args;
  const branch = (ref: string) =>
    ref.replace(/^refs\/heads\//, "").replace(/^refs\//, "");
  const isTerminal = intent.status === "merged" || intent.status === "rejected" || intent.status === "expired";
  return {
    number,
    title: title ?? `Merge intent ${intent.id} (${branch(intent.deltaRef)} → ${branch(intent.targetRef)})`,
    // Intents carry no body text; provenance lives in the op-log, exposed
    // via the delta tab. Kept honest-empty rather than fabricated.
    description: "",
    state: STATUS_MAP[intent.status] ?? "open",
    is_draft: false,
    author: { uid: intent.actor, display_name: intent.actor },
    source_branch: branch(intent.deltaRef),
    source_sha: intent.deltaOid,
    target_branch: branch(intent.targetRef),
    merge_base_sha: intent.baseOid,
    merge_check_status: CHECK_MAP[intent.status] ?? "unchecked",
    merge_conflicts: intent.conflicts ? intent.conflicts.split(",").filter(Boolean) : null,
    stats: {
      additions: stats?.additions ?? null,
      deletions: stats?.deletions ?? null,
      files_changed: stats?.files_changed ?? null,
      commits: stats?.commits ?? null,
      conversations: unresolved ?? 0,
      unresolved_count: unresolved ?? 0,
    },
    created: intent.createdAt,
    edited: intent.resolvedAt ?? intent.createdAt,
    closed: isTerminal ? intent.resolvedAt : null,
    merged: intent.status === "merged" ? intent.resolvedAt : null,
  };
}
