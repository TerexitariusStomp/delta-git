import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { Button, SandboxLayout, StatusBadge, Table, Tag, Text } from '@harnessio/ui/components'

import { PathParams } from '../../RouteDefinitions'
import {
  ForkNode,
  useArenaMatch,
  useArenaMatches,
  useCreateIdea,
  useDeltaIdeas,
  useDeltaIntents,
  useDeltaOplog,
  useDeltaWork,
  useEnterArenaMatch,
  useRepoNetwork,
  useVerifyIdea,
  useVoteArenaMatch
} from './delta-api'

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 10)}…` : id)
const ts = (n: number | null | undefined) => (n ? new Date(n).toLocaleString() : '—')

function useRepoParams() {
  const { spaceId = '', repoId = '' } = useParams<PathParams>()
  return { spaceId, repoId }
}

/** Merge intents — divergent pushes pending merge/adjudication. */
export function RepoDeltaIntentsPage() {
  const { spaceId, repoId } = useRepoParams()
  const { data: intents, isLoading } = useDeltaIntents(spaceId, repoId)
  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          Merge intents
        </Text>
        {isLoading ? (
          <Text color="foreground-3">Loading…</Text>
        ) : !intents?.length ? (
          <Text color="foreground-3">No open merge intents — all pushes are converged.</Text>
        ) : (
          <Table.Root variant="default">
            <Table.Header>
              <Table.Row>
                <Table.Head>Intent</Table.Head>
                <Table.Head>Target</Table.Head>
                <Table.Head>Delta ref</Table.Head>
                <Table.Head>Actor</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Conflicts</Table.Head>
                <Table.Head>Created</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {intents.map(intent => (
                <Table.Row key={intent.id}>
                  <Table.Cell>{shortId(intent.id)}</Table.Cell>
                  <Table.Cell>{intent.target_ref.replace('refs/heads/', '')}</Table.Cell>
                  <Table.Cell>{intent.delta_ref.replace('refs/delta/', '')}</Table.Cell>
                  <Table.Cell>{intent.actor}</Table.Cell>
                  <Table.Cell>
                    <StatusBadge
                      variant="status"
                      theme={intent.status === 'conflict' ? 'danger' : intent.status === 'merged' ? 'success' : 'info'}>
                      {intent.status}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell>{intent.conflicts.length}</Table.Cell>
                  <Table.Cell>{ts(intent.created_at)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

/** Ideas — work intents of kind=idea that agents can claim and build. */
export function RepoDeltaIdeasPage() {
  const { spaceId, repoId } = useRepoParams()
  const { data: ideas, isLoading, refetch } = useDeltaIdeas(spaceId, repoId)
  const createIdea = useCreateIdea(spaceId, repoId)
  const verifyIdea = useVerifyIdea(spaceId, repoId)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          Ideas
        </Text>
        <form
          className="mb-cn-lg flex flex-col gap-cn-sm max-w-xl"
          onSubmit={e => {
            e.preventDefault()
            if (!title.trim()) return
            createIdea.mutate(
              { title: title.trim(), body },
              { onSuccess: () => { setTitle(''); setBody(''); refetch() } }
            )
          }}>
          <input
            className="border-cn-2 rounded-cn-2 px-cn-sm py-cn-xs bg-cn-1 text-cn-1"
            placeholder="Idea title"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          <textarea
            className="border-cn-2 rounded-cn-2 px-cn-sm py-cn-xs bg-cn-1 text-cn-1"
            placeholder="Describe what should be built"
            rows={3}
            value={body}
            onChange={e => setBody(e.target.value)}
          />
          <Button type="submit" disabled={createIdea.isLoading || !title.trim()}>
            {createIdea.isLoading ? 'Posting…' : 'Post idea'}
          </Button>
        </form>
        {isLoading ? (
          <Text color="foreground-3">Loading…</Text>
        ) : !ideas?.length ? (
          <Text color="foreground-3">No ideas yet — post the first one above.</Text>
        ) : (
          <Table.Root variant="default">
            <Table.Header>
              <Table.Row>
                <Table.Head>Title</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Proposed by</Table.Head>
                <Table.Head>Claimed by</Table.Head>
                <Table.Head>Votes</Table.Head>
                <Table.Head>Created</Table.Head>
                <Table.Head />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {ideas.map(idea => (
                <Table.Row key={idea.id}>
                  <Table.Cell>{idea.title}</Table.Cell>
                  <Table.Cell>
                    <StatusBadge
                      variant="status"
                      theme={idea.status === 'verified' ? 'success' : idea.status === 'claimed' ? 'info' : 'muted'}>
                      {idea.status}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell>{idea.created_by}</Table.Cell>
                  <Table.Cell>{idea.claimed_by ?? '—'}</Table.Cell>
                  <Table.Cell>{idea.votes.length}</Table.Cell>
                  <Table.Cell>{ts(idea.created_at)}</Table.Cell>
                  <Table.Cell>
                    {idea.status !== 'verified' && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={verifyIdea.isLoading}
                        onClick={() => verifyIdea.mutate(idea.id, { onSuccess: () => refetch() })}>
                        Verify
                      </Button>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

/** Arena — repo-scoped vibe-coding matches. */
export function RepoDeltaArenaPage() {
  const { spaceId, repoId } = useRepoParams()
  const { data: matches, isLoading } = useArenaMatches(spaceId, repoId)
  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          Arena
        </Text>
        {isLoading ? (
          <Text color="foreground-3">Loading…</Text>
        ) : !matches?.length ? (
          <Text color="foreground-3">No matches yet.</Text>
        ) : (
          <Table.Root variant="default">
            <Table.Header>
              <Table.Row>
                <Table.Head>Match</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Prize</Table.Head>
                <Table.Head>Ends</Table.Head>
                <Table.Head>Created</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {matches.map(m => (
                <Table.Row key={m.id}>
                  <Table.Cell>
                    <Link to={`arena/${m.id}`}>{m.title}</Link>
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge
                      variant="status"
                      theme={m.status === 'resolved' ? 'success' : m.status === 'open' ? 'info' : 'warning'}>
                      {m.status}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell>{m.prize_rep} rep</Table.Cell>
                  <Table.Cell>{ts(m.ends_at)}</Table.Cell>
                  <Table.Cell>{ts(m.created_at)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

/** Arena match detail — entries (blind until voted/resolved) + vote + enter. */
export function RepoDeltaArenaMatchPage() {
  const { spaceId, repoId } = useRepoParams()
  const { matchId = '' } = useParams<PathParams & { matchId?: string }>()
  const { data, isLoading } = useArenaMatch(spaceId, repoId, matchId)
  const enter = useEnterArenaMatch(spaceId, repoId, matchId)
  const vote = useVoteArenaMatch(spaceId, repoId, matchId)

  if (isLoading || !data) {
    return (
      <SandboxLayout.Main>
        <SandboxLayout.Content>
          <Text color="foreground-3">Loading…</Text>
        </SandboxLayout.Content>
      </SandboxLayout.Main>
    )
  }
  const { match, entries, blind, voted } = data
  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-sm">
          {match.title}
        </Text>
        <Text color="foreground-3" variant="body-normal" className="mb-cn-md">
          {match.spec}
        </Text>
        <div className="flex items-center gap-cn-sm mb-cn-lg">
          <StatusBadge variant="status" theme={match.status === 'resolved' ? 'success' : 'info'}>
            {match.status}
          </StatusBadge>
          <Tag value={`${match.prize_rep} rep prize`} />
          {blind && <Tag value="blind judging" />}
          {match.status === 'open' && (
            <Button size="sm" disabled={enter.isLoading} onClick={() => enter.mutate()}>
              Enter match
            </Button>
          )}
        </div>
        <Table.Root variant="default">
          <Table.Header>
            <Table.Row>
              <Table.Head>Entry</Table.Head>
              <Table.Head>Entrant</Table.Head>
              <Table.Head>Workspace</Table.Head>
              <Table.Head>Head</Table.Head>
              <Table.Head />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {entries.map(entry => (
              <Table.Row key={entry.id}>
                <Table.Cell>{shortId(entry.id)}</Table.Cell>
                <Table.Cell>{entry.entrant_did ?? 'hidden'}</Table.Cell>
                <Table.Cell>{entry.workspace}</Table.Cell>
                <Table.Cell>{shortId(entry.head_oid)}</Table.Cell>
                <Table.Cell>
                  {match.status !== 'resolved' && !voted && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={vote.isLoading}
                      onClick={() => vote.mutate({ entry_id: entry.id })}>
                      Vote
                    </Button>
                  )}
                  {match.winner_entry_id === entry.id && <Tag value="winner" />}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

/** Fork-lineage tree — children are indented under their forked-from parent. */
function ForkTree({ root, nodes }: { root: ForkNode | null; nodes: ForkNode[] }) {
  const children = new Map<number | null, ForkNode[]>()
  const ids = new Set(nodes.map(n => n.id))
  if (root) ids.add(root.id)
  for (const n of nodes) {
    // Nodes whose parent isn't visible (hidden intermediate fork, or the
    // invisible root) hang directly under the rendered root row — or at the
    // top level when the root itself is hidden.
    const parent =
      n.forked_from_id !== null && ids.has(n.forked_from_id)
        ? n.forked_from_id
        : (root?.id ?? null)
    children.set(parent, [...(children.get(parent) ?? []), n])
  }
  const renderRow = (node: ForkNode, depth: number) => (
    <Link
      to={`/${node.owner}/${node.name}`}
      className="flex items-center gap-cn-xs py-cn-3xs hover:bg-cn-2 rounded-cn-2"
      style={{ paddingLeft: `${depth * 1.5}rem` }}>
      <Text variant="body-strong" color="foreground-1">
        {node.full_name}
      </Text>
      {!node.is_public && <Tag value="private" />}
    </Link>
  )
  const renderLevel = (parentId: number | null, depth: number) =>
    (children.get(parentId) ?? []).map(node => (
      <div key={node.id}>
        {renderRow(node, depth)}
        {renderLevel(node.id, depth + 1)}
      </div>
    ))
  return (
    <div>
      {root && renderRow(root, 0)}
      {renderLevel(root ? root.id : null, root ? 1 : 0)}
    </div>
  )
}

/** Network — the fork lineage tree (GitHub /network parity). */
export function RepoNetworkPage() {
  const { spaceId, repoId } = useRepoParams()
  const { data: network, isLoading } = useRepoNetwork(spaceId, repoId)
  const forks = network?.forks ?? []
  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          Fork network
        </Text>
        {isLoading ? (
          <Text color="foreground-3">Loading…</Text>
        ) : !forks.length ? (
          <Text color="foreground-3">No forks yet — this repository stands alone.</Text>
        ) : (
          <>
            <Text color="foreground-3" className="mb-cn-sm">
              {forks.length} {forks.length === 1 ? 'fork' : 'forks'} in this network
            </Text>
            <ForkTree root={network?.root ?? null} nodes={forks} />
          </>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

/** Agents — the repo's work queue + operation log. */
export function RepoDeltaAgentsPage() {
  const { spaceId, repoId } = useRepoParams()
  const { data: work } = useDeltaWork(spaceId, repoId)
  const { data: ops } = useDeltaOplog(spaceId, repoId)
  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          Agents
        </Text>
        <Text as="h2" variant="heading-subsection" className="mb-cn-sm">
          Work queue
        </Text>
        {!work?.length ? (
          <Text color="foreground-3" className="mb-cn-lg">
            No open work items.
          </Text>
        ) : (
          <Table.Root variant="default" className="mb-cn-lg">
            <Table.Header>
              <Table.Row>
                <Table.Head>Item</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Posted by</Table.Head>
                <Table.Head>Claimed by</Table.Head>
                <Table.Head>Created</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {work.map(w => (
                <Table.Row key={w.id}>
                  <Table.Cell>{w.title}</Table.Cell>
                  <Table.Cell>
                    <StatusBadge variant="status" theme={w.status === 'closed' ? 'muted' : 'info'}>
                      {w.status}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell>{w.created_by}</Table.Cell>
                  <Table.Cell>{w.claimed_by ?? '—'}</Table.Cell>
                  <Table.Cell>{ts(w.created_at)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
        <Text as="h2" variant="heading-subsection" className="mb-cn-sm">
          Operation log
        </Text>
        {!ops?.length ? (
          <Text color="foreground-3">No operations recorded.</Text>
        ) : (
          <Table.Root variant="default">
            <Table.Header>
              <Table.Row>
                <Table.Head>#</Table.Head>
                <Table.Head>Kind</Table.Head>
                <Table.Head>Actor</Table.Head>
                <Table.Head>When</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {[...ops].reverse().map(op => (
                <Table.Row key={op.seq}>
                  <Table.Cell>{op.seq}</Table.Cell>
                  <Table.Cell>{op.kind}</Table.Cell>
                  <Table.Cell>{op.actor}</Table.Cell>
                  <Table.Cell>{ts(op.created_at)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}
