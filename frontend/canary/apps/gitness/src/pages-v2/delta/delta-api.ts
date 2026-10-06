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

// --- repo knowledge base (/api/v1 knowledge plane) ---------------------------

const kbPath = (repoRef: string) => `/api/v1/repos/${repoRef}/+/knowledge`

export interface KbSymbol {
  name: string
  kind: string
  line: number
}

export interface KbFile {
  path: string
  ext: string
  symbols: KbSymbol[]
  imports: string[]
}

export interface KbEdge {
  from: string
  to: string
  kind: 'file' | 'package'
}

export interface RepoKnowledgeDoc {
  head: string | null
  headOid: string | null
  generated: number
  summary: string
  moduleBlurbs: Record<string, string>
  files: KbFile[]
  edges: KbEdge[]
  packages: string[]
  entrypoints: string[]
  glossary: { term: string; definition: string }[]
  diagrams: { id: string; title: string; mermaid: string }[]
  tours: { id: string; title: string; steps: { path: string; line?: number; note: string }[] }[]
}

export interface AskAnswer {
  answer: string
  citations: { path: string; repo: string }[]
}

const repoRef = (spaceId: string, repoId: string) => `${spaceId}/${repoId}`

export const useRepoKnowledge = (spaceId: string, repoId: string) =>
  useQuery(['delta', 'kb', spaceId, repoId], () =>
    dgFetch<RepoKnowledgeDoc>(kbPath(repoRef(spaceId, repoId)))
  )

export const useAskRepo = (spaceId: string, repoId: string) =>
  useMutation((query: string) =>
    dgFetch<AskAnswer>(`/api/v1/repos/${repoRef(spaceId, repoId)}/+/ask`, {
      method: 'POST',
      body: JSON.stringify({ query })
    })
  )

// --- issues (GitHub-shaped, DO-backed, session-authed via /api/v1) ----------

export interface RepoIssue {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  state_reason: 'completed' | 'not_planned' | 'reopened' | null
  user: { login: string }
  labels: { name: string; color: string; description: string | null }[]
  assignees: { login: string }[]
  milestone: { number: number; title: string; state: string } | null
  comments: number
  work_intent_id: string | null
  created_at: string
  updated_at: string
  closed_at: string | null
}

export interface RepoIssueComment {
  id: string
  body: string
  user: { login: string }
  created_at: string
  updated_at: string
}

export interface RepoMilestone {
  number: number
  title: string
  description: string | null
  state: string
  due_on: string | null
  created_at: string
  closed_at: string | null
}

const v1Path = (spaceId: string, repoId: string) => `/api/v1/repos/${repoRef(spaceId, repoId)}`

export const useIssues = (spaceId: string, repoId: string, state?: 'open' | 'closed') =>
  useQuery(
    ['delta', 'issues', spaceId, repoId, state ?? 'all'],
    () => dgFetch<RepoIssue[]>(`${v1Path(spaceId, repoId)}/issues${state ? `?state=${state}` : ''}`),
    { select: data => data ?? [] }
  )

export const useIssue = (spaceId: string, repoId: string, number: number) =>
  useQuery(['delta', 'issue', spaceId, repoId, number], () =>
    dgFetch<RepoIssue>(`${v1Path(spaceId, repoId)}/issues/${number}`)
  )

export const useIssueComments = (spaceId: string, repoId: string, number: number) =>
  useQuery(
    ['delta', 'issue-comments', spaceId, repoId, number],
    () => dgFetch<RepoIssueComment[]>(`${v1Path(spaceId, repoId)}/issues/${number}/comments`),
    { select: data => data ?? [] }
  )

export const useIssueReactions = (spaceId: string, repoId: string, number: number) =>
  useQuery(['delta', 'issue-reactions', spaceId, repoId, number], () =>
    dgFetch<Record<string, number>>(`${v1Path(spaceId, repoId)}/issues/${number}/reactions`)
  )

export const useCreateIssue = (spaceId: string, repoId: string) =>
  useMutation((body: { title: string; body?: string; labels?: string[]; assignees?: string[] }) =>
    dgFetch<RepoIssue>(`${v1Path(spaceId, repoId)}/issues`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  )

export const useUpdateIssue = (spaceId: string, repoId: string, number: number) =>
  useMutation(
    (patch: {
      title?: string
      body?: string | null
      state?: 'open' | 'closed'
      state_reason?: 'completed' | 'not_planned'
      labels?: string[]
      assignees?: string[]
    }) =>
      dgFetch<RepoIssue>(`${v1Path(spaceId, repoId)}/issues/${number}`, {
        method: 'PATCH',
        body: JSON.stringify(patch)
      })
  )

export const useCreateIssueComment = (spaceId: string, repoId: string, number: number) =>
  useMutation((body: { body: string }) =>
    dgFetch<RepoIssueComment>(`${v1Path(spaceId, repoId)}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  )

export const useIssueReaction = (spaceId: string, repoId: string, number: number) =>
  useMutation((vars: { reaction: string; add: boolean }) =>
    dgFetch(`${v1Path(spaceId, repoId)}/issues/${number}/reactions/${vars.reaction}`, {
      method: vars.add ? 'PUT' : 'DELETE'
    })
  )

export const useMilestones = (spaceId: string, repoId: string) =>
  useQuery(
    ['delta', 'milestones', spaceId, repoId],
    () => dgFetch<RepoMilestone[]>(`${v1Path(spaceId, repoId)}/milestones`),
    { select: data => data ?? [] }
  )

// --- social: stars + topics + explore ---------------------------------------

export interface RepoStar {
  starred: boolean
  stargazers_count: number
}

export interface ExploreRepo {
  owner: string
  name: string
  full_name: string
  description: string | null
  stargazers_count: number
  updated_at: string
}

export interface ExploreResult {
  repos: ExploreRepo[]
  topics: { topic: string; repos: number }[]
}

export const useRepoStar = (spaceId: string, repoId: string) =>
  useQuery(['delta', 'star', spaceId, repoId], () =>
    dgFetch<RepoStar>(`${v1Path(spaceId, repoId)}/+/star`)
  )

export const useToggleStar = (spaceId: string, repoId: string) =>
  useMutation((star: boolean) =>
    dgFetch<RepoStar>(`${v1Path(spaceId, repoId)}/+/star`, { method: star ? 'PUT' : 'DELETE' })
  )

export const useExplore = (topic?: string) =>
  useQuery(['delta', 'explore', topic ?? ''], () =>
    dgFetch<ExploreResult>(`/api/v1/explore${topic ? `?topic=${encodeURIComponent(topic)}` : ''}`)
  )

// --- discussions (GitHub-shaped, DO-backed, session-authed via /api/v1) -----

export type DiscussionCategory = 'general' | 'announcements' | 'ideas' | 'q-a' | 'show-and-tell' | 'polls'

export interface RepoDiscussion {
  number: number
  title: string
  body: string | null
  category: DiscussionCategory
  user: { login: string }
  comments: number
  answer_comment_id: string | null
  created_at: string
  updated_at: string
}

export interface RepoDiscussionComment {
  id: string
  body: string
  user: { login: string }
  created_at: string
  updated_at: string
}

export const useDiscussions = (spaceId: string, repoId: string, category?: DiscussionCategory | 'all') =>
  useQuery(
    ['delta', 'discussions', spaceId, repoId, category ?? 'all'],
    () =>
      dgFetch<RepoDiscussion[]>(
        `${v1Path(spaceId, repoId)}/discussions${category && category !== 'all' ? `?category=${category}` : ''}`
      ),
    { select: data => data ?? [] }
  )

export const useDiscussion = (spaceId: string, repoId: string, number: number) =>
  useQuery(['delta', 'discussion', spaceId, repoId, number], () =>
    dgFetch<RepoDiscussion>(`${v1Path(spaceId, repoId)}/discussions/${number}`)
  )

export const useDiscussionComments = (spaceId: string, repoId: string, number: number) =>
  useQuery(
    ['delta', 'discussion-comments', spaceId, repoId, number],
    () => dgFetch<RepoDiscussionComment[]>(`${v1Path(spaceId, repoId)}/discussions/${number}/comments`),
    { select: data => data ?? [] }
  )

export const useDiscussionReactions = (spaceId: string, repoId: string, number: number) =>
  useQuery(['delta', 'discussion-reactions', spaceId, repoId, number], () =>
    dgFetch<Record<string, number>>(`${v1Path(spaceId, repoId)}/discussions/${number}/reactions`)
  )

export const useCreateDiscussion = (spaceId: string, repoId: string) =>
  useMutation((body: { title: string; body?: string; category?: DiscussionCategory }) =>
    dgFetch<RepoDiscussion>(`${v1Path(spaceId, repoId)}/discussions`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  )

export const useUpdateDiscussion = (spaceId: string, repoId: string, number: number) =>
  useMutation((patch: { title?: string; body?: string | null; category?: DiscussionCategory }) =>
    dgFetch<RepoDiscussion>(`${v1Path(spaceId, repoId)}/discussions/${number}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    })
  )

export const useCreateDiscussionComment = (spaceId: string, repoId: string, number: number) =>
  useMutation((body: { body: string }) =>
    dgFetch<RepoDiscussionComment>(`${v1Path(spaceId, repoId)}/discussions/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  )

export const useMarkDiscussionAnswer = (spaceId: string, repoId: string, number: number) =>
  useMutation((vars: { commentId: string | null }) =>
    vars.commentId
      ? dgFetch<RepoDiscussion>(`${v1Path(spaceId, repoId)}/discussions/${number}/answer`, {
          method: 'PUT',
          body: JSON.stringify({ comment_id: vars.commentId })
        })
      : dgFetch<RepoDiscussion>(`${v1Path(spaceId, repoId)}/discussions/${number}/answer`, {
          method: 'DELETE'
        })
  )

export const useDiscussionReaction = (spaceId: string, repoId: string, number: number) =>
  useMutation((vars: { reaction: string; add: boolean }) =>
    dgFetch(`${v1Path(spaceId, repoId)}/discussions/${number}/reactions/${vars.reaction}`, {
      method: vars.add ? 'PUT' : 'DELETE'
    })
  )

// --- wiki (markdown pages on refs/heads/wiki, session-authed via /api/v1) ---

export interface WikiPage {
  name: string
  oid: string
}

export interface WikiPageContent extends WikiPage {
  content: string
}

export interface WikiHistoryEntry {
  oid: string
  message: string
  author?: { name: string; email: string; when: number }
}

export const useWikiPages = (spaceId: string, repoId: string) =>
  useQuery(
    ['delta', 'wiki', spaceId, repoId],
    () => dgFetch<WikiPage[]>(`${v1Path(spaceId, repoId)}/wiki`),
    { select: data => data ?? [] }
  )

export const useWikiPage = (spaceId: string, repoId: string, page: string, enabled = true) =>
  useQuery(
    ['delta', 'wiki', spaceId, repoId, page],
    () => dgFetch<WikiPageContent>(`${v1Path(spaceId, repoId)}/wiki/${encodeURIComponent(page)}`),
    { enabled }
  )

export const useWikiHistory = (spaceId: string, repoId: string) =>
  useQuery(
    ['delta', 'wiki-history', spaceId, repoId],
    () => dgFetch<WikiHistoryEntry[]>(`${v1Path(spaceId, repoId)}/wiki-history`),
    { select: data => data ?? [] }
  )

export const useSaveWikiPage = (spaceId: string, repoId: string) =>
  useMutation((vars: { page: string; content: string; message?: string }) =>
    dgFetch<{ name: string; commit_id: string }>(
      `${v1Path(spaceId, repoId)}/wiki/${encodeURIComponent(vars.page)}`,
      { method: 'PUT', body: JSON.stringify({ content: vars.content, message: vars.message }) }
    )
  )

export const useDeleteWikiPage = (spaceId: string, repoId: string) =>
  useMutation((page: string) =>
    dgFetch<{ name: string }>(`${v1Path(spaceId, repoId)}/wiki/${encodeURIComponent(page)}`, {
      method: 'DELETE'
    })
  )

// --- releases (tag-bound metadata + R2 assets, session-authed via /api/v1) ---

export interface RepoReleaseAsset {
  id: string
  name: string
  content_type: string
  size: number
  download_count: number
}

export interface RepoRelease {
  id: string
  tag_name: string
  target_commitish: string | null
  name: string
  body: string | null
  draft: boolean
  prerelease: boolean
  author: { login: string }
  assets: RepoReleaseAsset[]
  created_at: string
  published_at: string | null
}

export const useReleases = (spaceId: string, repoId: string) =>
  useQuery(
    ['delta', 'releases', spaceId, repoId],
    () => dgFetch<RepoRelease[]>(`${v1Path(spaceId, repoId)}/releases`),
    { select: data => data ?? [] }
  )

export const useRelease = (spaceId: string, repoId: string, id: string) =>
  useQuery(['delta', 'release', spaceId, repoId, id], () =>
    dgFetch<RepoRelease>(`${v1Path(spaceId, repoId)}/releases/${id}`)
  )

export const useCreateRelease = (spaceId: string, repoId: string) =>
  useMutation(
    (body: { tag_name: string; name?: string; body?: string; draft?: boolean; prerelease?: boolean }) =>
      dgFetch<RepoRelease>(`${v1Path(spaceId, repoId)}/releases`, {
        method: 'POST',
        body: JSON.stringify(body)
      })
  )

export const useDeleteRelease = (spaceId: string, repoId: string) =>
  useMutation((id: string) =>
    dgFetch(`${v1Path(spaceId, repoId)}/releases/${id}`, { method: 'DELETE' })
  )

export const useUploadReleaseAsset = (spaceId: string, repoId: string, releaseId: string) =>
  useMutation((vars: { name: string; file: File }) =>
    dgFetch<RepoReleaseAsset>(
      `${v1Path(spaceId, repoId)}/releases/${releaseId}/assets?name=${encodeURIComponent(vars.name)}`,
      { method: 'POST', body: vars.file }
    )
  )
