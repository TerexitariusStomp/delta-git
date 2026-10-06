import type { RepoDurableObject } from "@/worker/do/repo/repoDO";

// PR metadata merge intents do not carry — human-authored title,
// description, conversation, reviewers, and review decisions. Stored as one
// KV record per intent; the intents themselves remain the canonical merge
// state. Shared by the /api/v1 pullreqs facade and the /api/v3 gh-compat
// surface so both read/write the same record.

const PR_META_TTL_S = 60 * 60 * 24 * 365;

export interface PrComment {
  id: number;
  author: string;
  text: string;
  created: number;
  edited: number;
  resolvedAt?: number;
  /** Code-review anchor the SPA sends on file comments. */
  codeComment?: { path?: string; line_start?: number; line_end?: number; side?: string };
  reactions?: Record<string, string[]>;
}
export interface PrReview {
  author: string;
  decision: string;
  sha?: string;
  created: number;
}
export interface PrMeta {
  title?: string;
  description?: string;
  comments: PrComment[];
  reviewers?: string[];
  /** Distinct from reviewers — GitHub tracks both on a PR. */
  assignees?: string[];
  reviews?: PrReview[];
  labels?: string[];
  /** Draft PRs block merge until flipped ready — GitHub's is_draft. */
  draft?: boolean;
  automerge?: { method?: string; setBy: string; at: number };
}

function prMetaKey(doName: string, intentId: string): string {
  return `gpr:${doName}:${intentId}`;
}

export async function readPrMeta(env: Env, doName: string, intentId: string): Promise<PrMeta> {
  const raw = await env.ROUTES.get(prMetaKey(doName, intentId), "json").catch(() => null);
  const meta = raw as Partial<PrMeta> | null;
  return {
    title: meta?.title,
    description: meta?.description,
    comments: meta?.comments ?? [],
    reviewers: meta?.reviewers ?? [],
    assignees: meta?.assignees ?? [],
    reviews: meta?.reviews ?? [],
    labels: meta?.labels ?? [],
    draft: meta?.draft,
    automerge: meta?.automerge,
  };
}

export async function writePrMeta(env: Env, doName: string, intentId: string, meta: PrMeta) {
  await env.ROUTES.put(prMetaKey(doName, intentId), JSON.stringify(meta), {
    expirationTtl: PR_META_TTL_S,
  });
}

// GitHub's auto-close vocabulary — "closes #12", "fixed #3", "resolves: #7".
const ISSUE_REF_RE = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[:\s]+#(\d+)/gi;

export function linkedIssueNumbers(text: string | undefined | null): number[] {
  if (!text) return [];
  const out = new Set<number>();
  for (const m of text.matchAll(ISSUE_REF_RE)) out.add(parseInt(m[1], 10));
  return [...out];
}

/**
 * Close every open issue the given text links with a closing keyword.
 * Best-effort side-channel of a merge: unknown numbers and already-closed
 * issues are skipped, failures on one issue never block the rest. Called
 * from the Worker merge paths (interactive and v3); the DO's automerge
 * engine can't reach the KV meta record, so intents merged there without
 * a Worker hop don't auto-close — a known limitation until intents carry
 * their own description text.
 */
export async function closeIssuesLinkedFromText(args: {
  stub: DurableObjectStub<RepoDurableObject>;
  text: string | undefined | null;
  actor: string;
}): Promise<number[]> {
  const closed: number[] = [];
  for (const number of linkedIssueNumbers(args.text)) {
    const existing = await args.stub.getIssue(number).catch(() => null);
    if (!existing || existing.status !== "ok" || existing.issue.state !== "open") continue;
    const result = await args.stub
      .updateIssue({
        number,
        patch: { state: "closed", stateReason: "completed" },
        actor: args.actor,
      })
      .catch(() => null);
    if (result?.status === "updated") closed.push(number);
  }
  return closed;
}
