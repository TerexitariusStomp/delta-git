import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { Button, Layout, Link, NoData, SandboxLayout, StatusBadge, Text, TextInput } from '@harnessio/ui/components'

import { PathParams } from '../../RouteDefinitions'
import {
  useAddProjectCard,
  useCreateProject,
  useIssues,
  useMoveProjectCard,
  useProject,
  useProjects
} from '../delta/delta-api'

function useRepoParams() {
  const { spaceId = '', repoId = '' } = useParams<PathParams>()
  return { spaceId, repoId, base: `/${spaceId}/repos/${repoId}` }
}

/** Boards list — GitHub classic-projects shaped. */
export function RepoProjectsPage() {
  const { spaceId, repoId, base } = useRepoParams()
  const { data: projects, isLoading } = useProjects(spaceId, repoId)
  const create = useCreateProject(spaceId, repoId)
  const [name, setName] = useState('')

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Layout.Flex justify="between" align="center" className="mb-cn-md">
          <Text as="h1" variant="heading-section">
            Projects
          </Text>
        </Layout.Flex>

        <Layout.Flex gap="sm" className="mb-cn-md">
          <TextInput
            id="newProject"
            placeholder="New board name"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <Button
            disabled={!name.trim() || create.isLoading}
            onClick={() => create.mutateAsync({ name }).then(() => setName(''))}>
            Create
          </Button>
        </Layout.Flex>

        {isLoading ? (
          <Text color="foreground-3">Loading…</Text>
        ) : !projects?.length ? (
          <NoData
            imageName="no-data-folder"
            title="No boards yet"
            description={['Group issues into columns — cards can reference issues or hold free-text notes.']}
          />
        ) : (
          <Layout.Vertical gap="md">
            {projects.map(p => (
              <Layout.Flex
                key={p.number}
                align="center"
                gap="sm"
                className="border border-cn-2 rounded-cn-3 p-cn-md">
                <Link to={`${base}/projects/${p.number}`} variant="secondary" className="text-cn-size-3">
                  {p.name}
                </Link>
                <StatusBadge variant="status" theme={p.state === 'open' ? 'success' : 'muted'}>
                  {p.state}
                </StatusBadge>
                {p.body && <Text color="foreground-3">{p.body}</Text>}
              </Layout.Flex>
            ))}
          </Layout.Vertical>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

/** Board detail — columns of issue/note cards with move buttons. */
export function RepoProjectBoardPage() {
  const { spaceId, repoId, base } = useRepoParams()
  const { projectId = '' } = useParams<{ projectId: string }>()
  const number = parseInt(projectId, 10)
  const { data: project, isLoading, refetch } = useProject(spaceId, repoId, number)
  const { data: issues = [] } = useIssues(spaceId, repoId)
  const addCard = useAddProjectCard(spaceId, repoId, number)
  const moveCard = useMoveProjectCard(spaceId, repoId, number)
  const [draft, setDraft] = useState<Record<string, string>>({})

  if (isLoading || !project) {
    return (
      <SandboxLayout.Main>
        <SandboxLayout.Content>
          <Text color="foreground-3">{isLoading ? 'Loading…' : 'Board not found'}</Text>
        </SandboxLayout.Content>
      </SandboxLayout.Main>
    )
  }

  const columns = (project.columns ?? []).slice().sort((a, b) => a.position - b.position)

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          {project.name}
        </Text>
        <Layout.Flex gap="md" align="start" className="overflow-x-auto">
          {columns.map(col => (
            <Layout.Vertical key={col.id} className="bg-cn-2 w-72 flex-shrink-0 rounded-cn-3 p-cn-sm" gap="sm">
              <Text variant="body-strong">
                {col.name} ({col.cards.length})
              </Text>
              {col.cards
                .slice()
                .sort((a, b) => a.position - b.position)
                .map(card => (
                  <Layout.Vertical key={card.id} className="bg-cn-1 border border-cn-2 rounded-cn-2 p-cn-sm" gap="2xs">
                    {card.kind === 'issue' ? (
                      <Link
                        to={`${base}/issues/${card.issue_number}`}
                        variant="secondary">
                        #{card.issue_number}{' '}
                        {issues.find(i => i.number === card.issue_number)?.title ?? ''}
                      </Link>
                    ) : (
                      <Text variant="body-normal">{card.note}</Text>
                    )}
                    <Layout.Flex gap="xs">
                      {columns
                        .filter(c => c.id !== col.id)
                        .map(target => (
                          <Button
                            key={target.id}
                            variant="link"
                            size="sm"
                            onClick={() =>
                              moveCard.mutate(
                                { card_id: card.id, column_id: target.id },
                                { onSuccess: () => refetch() }
                              )
                            }>
                            → {target.name}
                          </Button>
                        ))}
                    </Layout.Flex>
                  </Layout.Vertical>
                ))}
              <Layout.Flex gap="xs">
                <TextInput
                  id={`card-${col.id}`}
                  size="sm"
                  placeholder="Note or #issue"
                  value={draft[col.id] ?? ''}
                  onChange={e => setDraft(d => ({ ...d, [col.id]: e.target.value }))}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const v = (draft[col.id] ?? '').trim()
                    if (!v) return
                    const issueMatch = v.match(/^#?(\d+)$/)
                    addCard.mutate(
                      issueMatch
                        ? { column_id: col.id, issue: parseInt(issueMatch[1], 10) }
                        : { column_id: col.id, note: v },
                      { onSuccess: () => { setDraft(d => ({ ...d, [col.id]: '' })); refetch() } }
                    )
                  }}>
                  Add
                </Button>
              </Layout.Flex>
            </Layout.Vertical>
          ))}
        </Layout.Flex>
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}
