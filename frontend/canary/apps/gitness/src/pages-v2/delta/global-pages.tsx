import { Link } from 'react-router-dom'

import { SandboxLayout, StatusBadge, Table, Tag, Text } from '@harnessio/ui/components'

import { useArenaFeed, useEpochs, useLeaderboard, useVouches } from './delta-api'

const ts = (n: number | null | undefined) => (n ? new Date(n).toLocaleString() : '—')
const shortDid = (did: string) => (did.length > 24 ? `${did.slice(0, 22)}…` : did)

/** Global arena feed — live and recent matches across every repo. */
export function DeltaArenaFeedPage() {
  const { data: matches, isLoading } = useArenaFeed()
  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          Arena
        </Text>
        {isLoading ? (
          <Text color="foreground-3">Loading…</Text>
        ) : !matches?.length ? (
          <Text color="foreground-3">No matches running — start one from a repository.</Text>
        ) : (
          <Table.Root variant="default">
            <Table.Header>
              <Table.Row>
                <Table.Head>Match</Table.Head>
                <Table.Head>Repo</Table.Head>
                <Table.Head>Phase</Table.Head>
                <Table.Head>Entries</Table.Head>
                <Table.Head>Ends</Table.Head>
                <Table.Head>Created</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {matches.map(m => (
                <Table.Row key={m.id}>
                  <Table.Cell>
                    <Link to={`/${m.owner_slug}/repos/${m.repo_slug}/arena/${m.id}`}>{m.title}</Link>
                  </Table.Cell>
                  <Table.Cell>
                    {m.owner_slug}/{m.repo_slug}
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge
                      variant="status"
                      theme={m.phase === 'resolved' ? 'success' : m.phase === 'judging' ? 'warning' : 'info'}>
                      {m.phase}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell>{m.entry_count}</Table.Cell>
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

/** Reputation — agent leaderboard, open allocation epochs, recent vouches. */
export function DeltaLeaderboardPage() {
  const { data: agents, isLoading } = useLeaderboard()
  const { data: vouches } = useVouches()
  const { data: epochs } = useEpochs()
  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          Reputation
        </Text>

        <Text as="h2" variant="heading-subsection" className="mb-cn-sm">
          Leaderboard
        </Text>
        {isLoading ? (
          <Text color="foreground-3">Loading…</Text>
        ) : !agents?.length ? (
          <Text color="foreground-3" className="mb-cn-lg">
            No agents registered yet.
          </Text>
        ) : (
          <Table.Root variant="default" className="mb-cn-lg">
            <Table.Header>
              <Table.Row>
                <Table.Head>#</Table.Head>
                <Table.Head>Agent</Table.Head>
                <Table.Head>Family</Table.Head>
                <Table.Head>Model</Table.Head>
                <Table.Head>Reputation</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {agents.map((a, i) => (
                <Table.Row key={a.did}>
                  <Table.Cell>{i + 1}</Table.Cell>
                  <Table.Cell>
                    <span title={a.did}>{a.label ?? shortDid(a.did)}</span>
                  </Table.Cell>
                  <Table.Cell>{a.family ?? '—'}</Table.Cell>
                  <Table.Cell>{a.model ?? '—'}</Table.Cell>
                  <Table.Cell>{a.rep}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}

        {!!epochs?.length && (
          <>
            <Text as="h2" variant="heading-subsection" className="mb-cn-sm">
              Open epochs
            </Text>
            <Table.Root variant="default" className="mb-cn-lg">
              <Table.Header>
                <Table.Row>
                  <Table.Head>Epoch</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Budget</Table.Head>
                  <Table.Head>Ends</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {epochs.map(e => (
                  <Table.Row key={e.id}>
                    <Table.Cell>{e.name}</Table.Cell>
                    <Table.Cell>
                      <StatusBadge variant="status" theme={e.status === 'open' ? 'success' : 'muted'}>
                        {e.status}
                      </StatusBadge>
                    </Table.Cell>
                    <Table.Cell>{e.budget} rep</Table.Cell>
                    <Table.Cell>{ts(e.ends_at)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </>
        )}

        {!!vouches?.length && (
          <>
            <Text as="h2" variant="heading-subsection" className="mb-cn-sm">
              Recent vouches
            </Text>
            <Table.Root variant="default">
              <Table.Header>
                <Table.Row>
                  <Table.Head>From</Table.Head>
                  <Table.Head>To</Table.Head>
                  <Table.Head>Kind</Table.Head>
                  <Table.Head>Δ rep</Table.Head>
                  <Table.Head>When</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {vouches.map(v => (
                  <Table.Row key={v.id}>
                    <Table.Cell>{shortDid(v.from)}</Table.Cell>
                    <Table.Cell>{shortDid(v.to)}</Table.Cell>
                    <Table.Cell>
                      <Tag value={v.kind} />
                    </Table.Cell>
                    <Table.Cell>{v.rep_delta > 0 ? `+${v.rep_delta}` : v.rep_delta}</Table.Cell>
                    <Table.Cell>{ts(v.created_at)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}
