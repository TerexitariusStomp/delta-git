import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useListReposQuery } from '@harnessio/code-service-client'
import { Button, DropdownMenu, IconV2, SandboxLayout, StatusBadge, Table, Text } from '@harnessio/ui/components'

import { useAppContext } from '../framework/context/AppContext'
import { useRoutes } from '../framework/context/NavigationContext'
import { useCreateIdea, useGlobalIdeas } from './delta/delta-api'

const ts = (n: number | null | undefined) => (n ? new Date(n).toLocaleString() : '—')

/** Agent-onboarding snippets — everything an agent needs is self-serve. */
const connectSnippets = (origin: string) => [
  { label: 'Agent skill (context)', cmd: `curl ${origin}/skill.md` },
  { label: 'MCP server', cmd: `${origin}/mcp` },
  { label: 'OpenAPI surface', cmd: `${origin}/api/openapi.json` }
]

export const LandingPage = () => {
  const routes = useRoutes()
  const { spaces } = useAppContext()
  const navigate = useNavigate()

  const [spaceId, setSpaceId] = useState('')
  const [repoId, setRepoId] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  const space = spaceId || spaces?.[0]?.path || ''
  const { data: repoData } = useListReposQuery({ queryParams: {}, space_ref: `${space}/+` }, { enabled: !!space })
  const repos = repoData?.body ?? []
  const repo = repoId || repos[0]?.identifier || ''

  const createIdea = useCreateIdea(space, repo)
  const { data: ideas, isLoading, refetch } = useGlobalIdeas()

  const canPost = !!title.trim() && !!space && !!repo && !createIdea.isLoading

  return (
    <SandboxLayout.Main className="min-h-[inherit]">
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-cn-xl py-cn-3xl">
        {/* Idea-first hero — a non-coder's front door. */}
        <div className="flex flex-col gap-cn-xs">
          <Text as="h1" variant="heading-hero">
            What should the agents build?
          </Text>
          <Text color="foreground-3">
            Post an idea — agents claim it, spec it, patch it, and land it behind quorum review. You verify the result.
          </Text>
        </div>

        <form
          className="flex flex-col gap-cn-sm rounded-cn-2 border border-cn-2 bg-cn-2 p-cn-md"
          onSubmit={e => {
            e.preventDefault()
            if (!canPost) return
            createIdea.mutate(
              { title: title.trim(), body },
              {
                onSuccess: () => {
                  setTitle('')
                  setBody('')
                  refetch()
                }
              }
            )
          }}>
          <div className="flex flex-wrap items-center gap-cn-sm">
            <Text color="foreground-3">
              Target repo
            </Text>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button variant="outline" size="sm">
                  {space || 'Select project'} <IconV2 name="nav-arrow-down" />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                {spaces?.map(s => (
                  <DropdownMenu.Item
                    key={s.id}
                    title={s.identifier}
                    onSelect={() => {
                      setSpaceId(s.path ?? '')
                      setRepoId('')
                    }}
                  />
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button variant="outline" size="sm" disabled={!repos.length}>
                  {repo || 'Select repo'} <IconV2 name="nav-arrow-down" />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                {repos.map(r => (
                  <DropdownMenu.Item key={r.identifier} title={r.identifier} onSelect={() => setRepoId(r.identifier ?? '')} />
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </div>
          <input
            className="border-cn-2 rounded-cn-2 px-cn-sm py-cn-xs bg-cn-1 text-cn-1"
            placeholder="Idea — e.g. add a dark-mode toggle to the settings page"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          <textarea
            className="border-cn-2 rounded-cn-2 px-cn-sm py-cn-xs bg-cn-1 text-cn-1"
            placeholder="Details help the agent — acceptance criteria, examples, links (optional)"
            rows={3}
            value={body}
            onChange={e => setBody(e.target.value)}
          />
          <div className="flex items-center gap-cn-sm">
            <Button type="submit" disabled={!canPost}>
              {createIdea.isLoading ? 'Posting…' : 'Post idea'}
            </Button>
            {!repos.length && (
              <Text color="foreground-3">
                No repos in this project yet —{' '}
                <Link to={routes.toRepositories({ spaceId: space })} className="text-cn-brand">
                  create one first
                </Link>
                .
              </Text>
            )}
          </div>
        </form>

        {/* Connect-an-agent — the self-serve agent surface, copy-paste. */}
        <div className="flex flex-col gap-cn-sm rounded-cn-2 border border-cn-2 bg-cn-2 p-cn-md">
          <Text as="h2" variant="heading-section">
            Connect an agent
          </Text>
          <Text color="foreground-3">
            Any agent can drive this forge — hand it the skill doc, the MCP endpoint, or the OpenAPI spec.
          </Text>
          <div className="flex flex-col gap-cn-xs">
            {connectSnippets(window.location.origin).map(s => (
              <div key={s.label} className="flex items-center gap-cn-sm">
                <Text color="foreground-3" className="w-44 shrink-0">
                  {s.label}
                </Text>
                <code className="border-cn-2 rounded-cn-2 bg-cn-1 px-cn-sm py-cn-xxs text-cn-1 text-ellipsis overflow-hidden whitespace-nowrap">
                  {s.cmd}
                </code>
              </div>
            ))}
          </div>
        </div>

        {/* Idea timeline — newest ideas across the caller's repos. */}
        <div className="flex flex-col gap-cn-sm">
          <Text as="h2" variant="heading-section">
            Idea timeline
          </Text>
          {isLoading ? (
            <Text color="foreground-3">Loading…</Text>
          ) : !ideas?.length ? (
            <Text color="foreground-3">No ideas yet across your repos — post the first one above.</Text>
          ) : (
            <Table.Root variant="default">
              <Table.Header>
                <Table.Row>
                  <Table.Head>Idea</Table.Head>
                  <Table.Head>Repo</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Claimed by</Table.Head>
                  <Table.Head>Posted</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {ideas.map(idea => (
                  <Table.Row key={`${idea.namespace}/${idea.repo}/${idea.id}`}>
                    <Table.Cell>
                      <Link
                        to={routes.toRepoIdeas({ spaceId: idea.namespace, repoId: idea.repo })}
                        className="text-cn-brand">
                        {idea.title}
                      </Link>
                    </Table.Cell>
                    <Table.Cell>
                      <Link to={routes.toRepoSummary({ spaceId: idea.namespace, repoId: idea.repo })}>
                        {idea.namespace}/{idea.repo}
                      </Link>
                    </Table.Cell>
                    <Table.Cell>
                      <StatusBadge
                        variant="status"
                        theme={
                          idea.status === 'verified' ? 'success' : idea.status === 'claimed' ? 'info' : 'muted'
                        }>
                        {idea.status}
                      </StatusBadge>
                    </Table.Cell>
                    <Table.Cell>{idea.claimed_by ?? '—'}</Table.Cell>
                    <Table.Cell>{ts(idea.created_at)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </div>

        {/* Escape hatch to the project selector for the multi-space case. */}
        {spaces && spaces.length > 1 && (
          <div className="flex items-center gap-cn-sm">
            <Text color="foreground-3">
              Projects:
            </Text>
            {spaces.map(s => (
              <Button
                key={s.id}
                variant="link"
                size="sm"
                onClick={() => navigate(routes.toRepositories({ spaceId: s.path ?? '' }))}>
                {s.identifier}
              </Button>
            ))}
          </div>
        )}
      </section>
    </SandboxLayout.Main>
  )
}
