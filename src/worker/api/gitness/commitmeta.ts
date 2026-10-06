// Commit-level conversation — GitHub's "comment on a commit" feature.
// One KV record per commit oid, same shape as PR comments so the two
// surfaces can share rendering. Keyed by oid (commits are immutable), so
// no intent lookup is needed.

import type { PrComment } from "./prmeta";

const COMMIT_META_TTL_S = 60 * 60 * 24 * 365;

export interface CommitMeta {
  comments: PrComment[];
}

function commitMetaKey(doName: string, oid: string): string {
  return `gcm:${doName}:${oid}`;
}

export async function readCommitMeta(env: Env, doName: string, oid: string): Promise<CommitMeta> {
  const raw = await env.ROUTES.get(commitMetaKey(doName, oid), "json").catch(() => null);
  const meta = raw as Partial<CommitMeta> | null;
  return { comments: meta?.comments ?? [] };
}

export async function writeCommitMeta(env: Env, doName: string, oid: string, meta: CommitMeta) {
  await env.ROUTES.put(commitMetaKey(doName, oid), JSON.stringify(meta), {
    expirationTtl: COMMIT_META_TTL_S,
  });
}
