import { useMutation, useQuery } from '@tanstack/react-query'

/**
 * delta-git surface client — the SPA's second API beside CodeServiceAPIClient.
 * These endpoints are our own (`/api/...`, `/api/:owner/:repo/dg/...`), not
 * gitness-shaped; they expose merge intents, work/ideas, arena matches, and
 * the reputation layer that gitness has no concept for.
 */

async function dgFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init
  })
  const body = (await res.json().catch(() => null)) as T & { error?: string; message?: string }
  if (!res.ok) {
    throw new Error(body?.error ?? body?.message ?? `request failed: ${res.status}`)
  }
  return body
}

const dgPath = (spaceId: string, repoId: string) => `/api/${spaceId}/${repoId}/dg`

// --- types (mirror the worker JSON shapes) -----------------------------------

export interface DeltaIntent {
  id: string
  target_ref: string
  base_oid: string
  delta_ref: string
  delta_oid: string
  actor: string
  status: string
  conflicts: string[]
  result_oid: string | null
  created_at: number
  expires_at: number
  resolved_at: number | null
}

export interface DeltaIdea {
  id: string
  title: string
  body: string
  source_uri: string | null
  created_by: string
  status: string
  claimed_by: string | null
  result: string | null
  votes: { seat: number; voter_did: string; digest: string }[]
  created_at: number
}

export interface DeltaWorkItem {
  id: string
  title: string
  body: string
  created_by: string
  status: string
  claimed_by: string | null
  claim_expires_at: number | null
  created_at: number
}

export interface DeltaOpEntry {
  seq: number
  hash: string
  prev_hash: string
  kind: string
  actor: string
  payload: Record<string, unknown>
  created_at: number
}

export interface ArenaMatchSummary {
  id: string
  title: string
  status: string
  ends_at: number | null
  judge_ends_at: number | null
  max_entrants: number
  prize_rep: number
  created_by: string
  created_at: number
}

export interface ArenaFeedEntry {
  id: string
  title: string
  owner_slug: string
  repo_slug: string
  phase: 'building' | 'judging' | 'resolved'
  entry_count: number
  ends_at: number | null
  judge_ends_at: number | null
  created_by: string
  created_at: number
}

export interface ArenaMatchDetail {
  match: {
    id: string
    title: string
    spec: string
    status: string
    ends_at: number | null
    judge_ends_at: number | null
    max_entrants: number
    prize_rep: number
    created_by: string
    winner_entry_id: string | null
  }
  blind: boolean
  voted: boolean
  entries: {
    id: string
    slot: number
    entrant_did: string | null
    workspace: string
    head_oid: string
    created_at: number
  }[]
  votes: { voter_did: string; entry_id: string; stake: number }[]
}

export interface LeaderboardAgent {
  did: string
  rep: number
  label: string | null
  family: string | null
  model: string | null
}

export interface VouchRow {
  id: number
  from: string
  to: string
  kind: string
  message: string | null
  rep_delta: number
  created_at: number
}

export interface EpochRow {
  id: string
  name: string
  status: string
  budget: number
  starts_at: number
  ends_at: number
}

// --- global hooks ------------------------------------------------------------

export const useArenaFeed = () =>
  useQuery(['delta', 'arena-feed'], () => dgFetch<{ matches: ArenaFeedEntry[] }>('/api/arena'), {
    select: data => data.matches
  })

export const useLeaderboard = () =>
  useQuery(['delta', 'leaderboard'], () => dgFetch<{ agents: LeaderboardAgent[] }>('/api/leaderboard'), {
    select: data => data.agents
  })

export const useVouches = () =>
  useQuery(['delta', 'vouches'], () => dgFetch<{ vouches: VouchRow[] }>('/api/dg/vouches'), {
    select: data => data.vouches
  })

export const useEpochs = () =>
  useQuery(['delta', 'epochs'], () => dgFetch<{ epochs: EpochRow[] }>('/api/dg/epochs'), {
    select: data => data.epochs
  })

// --- repo-scoped hooks ---------------------------------------------------------

export const useDeltaIntents = (spaceId: string, repoId: string) =>
  useQuery(
    ['delta', 'intents', spaceId, repoId],
    () => dgFetch<{ intents: DeltaIntent[] }>(`${dgPath(spaceId, repoId)}/intents`),
    { select: data => data.intents }
  )

export const useDeltaIdeas = (spaceId: string, repoId: string) =>
  useQuery(
    ['delta', 'ideas', spaceId, repoId],
    () => dgFetch<{ ideas: DeltaIdea[] }>(`${dgPath(spaceId, repoId)}/ideas`),
    { select: data => data.ideas }
  )

export const useDeltaWork = (spaceId: string, repoId: string) =>
  useQuery(
    ['delta', 'work', spaceId, repoId],
    () => dgFetch<{ work: DeltaWorkItem[] }>(`${dgPath(spaceId, repoId)}/work`),
    { select: data => data.work }
  )

export const useDeltaOplog = (spaceId: string, repoId: string) =>
  useQuery(
    ['delta', 'oplog', spaceId, repoId],
    () => dgFetch<{ entries: DeltaOpEntry[] }>(`${dgPath(spaceId, repoId)}/oplog`),
    { select: data => data.entries }
  )

export const useArenaMatches = (spaceId: string, repoId: string) =>
  useQuery(
    ['delta', 'matches', spaceId, repoId],
    () => dgFetch<{ matches: ArenaMatchSummary[] }>(`${dgPath(spaceId, repoId)}/matches`),
    { select: data => data.matches }
  )

export const useArenaMatch = (spaceId: string, repoId: string, matchId: string) =>
  useQuery(['delta', 'match', spaceId, repoId, matchId], () =>
    dgFetch<ArenaMatchDetail>(`${dgPath(spaceId, repoId)}/matches/${matchId}`)
  )

// --- mutations -----------------------------------------------------------------

export const useCreateIdea = (spaceId: string, repoId: string) =>
  useMutation((body: { title: string; body: string }) =>
    dgFetch(`${dgPath(spaceId, repoId)}/ideas`, { method: 'POST', body: JSON.stringify(body) })
  )

export const useVerifyIdea = (spaceId: string, repoId: string) =>
  useMutation((id: string) =>
    dgFetch(`${dgPath(spaceId, repoId)}/ideas/${id}/verify`, { method: 'POST', body: '{}' })
  )

export const useVoteArenaMatch = (spaceId: string, repoId: string, matchId: string) =>
  useMutation((body: { entry_id: string }) =>
    dgFetch(`${dgPath(spaceId, repoId)}/matches/${matchId}/vote`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  )

export const useEnterArenaMatch = (spaceId: string, repoId: string, matchId: string) =>
  useMutation(() =>
    dgFetch(`${dgPath(spaceId, repoId)}/matches/${matchId}/enter`, { method: 'POST', body: '{}' })
  )
