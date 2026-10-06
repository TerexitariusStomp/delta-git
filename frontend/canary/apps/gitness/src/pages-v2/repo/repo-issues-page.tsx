import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { Button, Layout, Link, MarkdownViewer, NoData, SandboxLayout, Select, StatusBadge, Tabs, Text, TextInput } from '@harnessio/ui/components'

import { PathParams } from '../../RouteDefinitions'
import {
  useCreateIssue,
  useCreateIssueComment,
  useIssue,
  useIssueComments,
  useIssueReaction,
  useIssueReactions,
  useIssues,
  useIssueTemplates,
  useUpdateIssue
} from '../delta/delta-api'

const ts = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : '—')

const REACTION_EMOJI: Record<string, string> = {
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  hooray: '🎉',
  confused: '😕',
  heart: '❤️',
  rocket: '🚀',
  eyes: '👀'
}

function LabelChip({ name, color }: { name: string; color: string }) {
  // Dynamic hex can't be a tailwind class — color comes from the repo's
  // label registry, so only the background is inline.
  return (
    <span
      className="rounded-cn-full px-cn-xs py-cn-3xs text-cn-size-1 border border-cn-2"
      style={{ borderColor: `#${color}`, color: `#${color}` }}>
      {name}
    </span>
  )
}

function useRepoParams() {
  const { spaceId = '', repoId = '' } = useParams<PathParams>()
  return { spaceId, repoId, base: `/${spaceId}/repos/${repoId}` }
}

/** Issues list — GitHub-shaped rows over DO-backed tracker issues. */
export function RepoIssuesPage() {
  const { spaceId, repoId, base } = useRepoParams()
  const [state, setState] = useState<'open' | 'closed'>('open')
  const [input, setInput] = useState('')
  // `applied` holds the qualifier string sent to the API — updated on submit,
  // keeping list rendering stable while the user edits the search box.
  const [applied, setApplied] = useState('')
  // When searching, the open/closed tab folds into the query (GitHub does the
  // same) unless the user already named an is: qualifier explicitly.
  const effectiveQuery =
    applied && !/\bis:\s*(open|closed)/i.test(applied) ? `${applied} is:${state}` : applied
  const { data: issues, isLoading } = useIssues(spaceId, repoId, state, effectiveQuery)
  const navigate = useNavigate()

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Layout.Flex justify="between" align="center" className="mb-cn-md">
          <Text as="h1" variant="heading-section">
            Issues
          </Text>
          <Button onClick={() => navigate(`${base}/issues/new`)}>New issue</Button>
        </Layout.Flex>

        <form
          className="mb-cn-md"
          onSubmit={e => {
            e.preventDefault()
            setApplied(input)
          }}>
          <TextInput
            id="issueSearch"
            placeholder="Search issues — is:open label:bug author:octocat"
            value={input}
            onChange={e => setInput(e.target.value)}
          />
        </form>

        <Tabs.Root value={state} onValueChange={v => setState(v as 'open' | 'closed')} className="mb-cn-md">
          <Tabs.List>
            <Tabs.Trigger value="open">Open</Tabs.Trigger>
            <Tabs.Trigger value="closed">Closed</Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>

        {isLoading ? (
          <Text color="foreground-3">Loading…</Text>
        ) : !issues?.length ? (
          <NoData
            imageName="no-data-folder"
            title={`No ${state} issues`}
            description={[
              state === 'open'
                ? 'Nothing is tracking open work here — file the first issue, or let an agent claim one.'
                : 'No closed issues yet.'
            ]}
            primaryButton={{ label: 'New issue', to: `${base}/issues/new` }}
          />
        ) : (
          <Layout.Vertical gap="xs" className="border border-cn-2 rounded-cn-3 divide-y divide-cn-2">
            {issues.map(issue => (
              <Link
                key={issue.number}
                to={`${base}/issues/${issue.number}`}
                variant="secondary"
                noHoverUnderline
                className="block px-cn-md py-cn-sm hover:bg-cn-2">
                <Layout.Flex align="center" gap="sm">
                  <StatusBadge
                    variant="status"
                    theme={issue.state === 'open' ? 'success' : 'muted'}
                    className="shrink-0">
                    {issue.state === 'open' ? 'Open' : 'Closed'}
                  </StatusBadge>
                  <Text variant="body-strong" color="foreground-1" className="truncate">
                    {issue.title}
                  </Text>
                  {issue.labels.map(l => (
                    <LabelChip key={l.name} name={l.name} color={l.color} />
                  ))}
                  <Layout.Flex align="center" gap="sm" className="ml-auto shrink-0">
                    <Text variant="body-normal" color="foreground-3">
                      #{issue.number} · {issue.user.login} · {ts(issue.created_at)}
                    </Text>
                    {issue.comments > 0 && (
                      <Text variant="body-normal" color="foreground-3">
                        💬 {issue.comments}
                      </Text>
                    )}
                  </Layout.Flex>
                </Layout.Flex>
              </Link>
            ))}
          </Layout.Vertical>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

/** New issue composer. */
export function RepoIssueNewPage() {
  const { spaceId, repoId, base } = useRepoParams()
  const createIssue = useCreateIssue(spaceId, repoId)
  const { data: templates } = useIssueTemplates(spaceId, repoId)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [labels, setLabels] = useState<string[]>([])
  const navigate = useNavigate()

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          New issue
        </Text>
        <form
          className="flex flex-col gap-cn-md max-w-2xl"
          onSubmit={e => {
            e.preventDefault()
            if (!title.trim()) return
            createIssue.mutate(
              { title: title.trim(), body: body || undefined, labels },
              { onSuccess: issue => navigate(`${base}/issues/${issue.number}`) }
            )
          }}>
          {templates && templates.length > 0 && (
            <Select
              label="Template"
              placeholder="Open a blank issue"
              options={templates.map(t => ({ label: `${t.name}${t.about ? ` — ${t.about}` : ''}`, value: t.file }))}
              onChange={file => {
                const t = templates.find(x => x.file === file)
                if (!t) return
                setTitle(prev => (prev ? prev : t.title))
                setBody(t.body)
                setLabels(t.labels)
              }}
            />
          )}
          <TextInput
            id="issueTitle"
            label="Title"
            placeholder="Title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            autoFocus
          />
          <label className="flex flex-col gap-cn-2xs">
            <Text variant="body-normal" color="foreground-2">
              Description
            </Text>
            <textarea
              className="border border-cn-2 rounded-cn-2 px-cn-sm py-cn-xs bg-cn-1 text-cn-1 min-h-40"
              placeholder="Markdown supported"
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={8}
            />
          </label>
          <Layout.Flex gap="sm">
            <Button type="submit" disabled={createIssue.isLoading || !title.trim()}>
              {createIssue.isLoading ? 'Creating…' : 'Create issue'}
            </Button>
            <Button variant="outline" type="button" onClick={() => navigate(`${base}/issues`)}>
              Cancel
            </Button>
          </Layout.Flex>
          {createIssue.isError && (
            <Text color="danger">{(createIssue.error as Error)?.message ?? 'Create failed'}</Text>
          )}
        </form>
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

/** Issue detail — header + body + comments thread + close/reopen + reactions. */
export function RepoIssueDetailPage() {
  const { spaceId, repoId } = useRepoParams()
  const { issueNumber = '' } = useParams<{ issueNumber: string }>()
  const number = parseInt(issueNumber, 10)
  const { data: issue, isLoading, refetch } = useIssue(spaceId, repoId, number)
  const { data: comments, refetch: refetchComments } = useIssueComments(spaceId, repoId, number)
  const { data: reactions, refetch: refetchReactions } = useIssueReactions(spaceId, repoId, number)
  const updateIssue = useUpdateIssue(spaceId, repoId, number)
  const addComment = useCreateIssueComment(spaceId, repoId, number)
  const setReaction = useIssueReaction(spaceId, repoId, number)
  const [draft, setDraft] = useState('')

  if (isLoading) {
    return (
      <SandboxLayout.Main>
        <SandboxLayout.Content>
          <Text color="foreground-3">Loading…</Text>
        </SandboxLayout.Content>
      </SandboxLayout.Main>
    )
  }
  if (!issue) {
    return (
      <SandboxLayout.Main>
        <SandboxLayout.Content>
          <NoData imageName="no-data-folder" title="Issue not found" description={['It may have been deleted.']} />
        </SandboxLayout.Content>
      </SandboxLayout.Main>
    )
  }

  const isOpen = issue.state === 'open'

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Layout.Flex justify="between" align="start" className="mb-cn-md">
          <Layout.Vertical gap="2xs">
            <Text as="h1" variant="heading-section">
              {issue.title} <Text as="span" color="foreground-3">#{issue.number}</Text>
            </Text>
            <Layout.Flex align="center" gap="sm">
              <StatusBadge variant="status" theme={isOpen ? 'success' : 'muted'}>
                {isOpen ? 'Open' : `Closed${issue.state_reason ? ` as ${issue.state_reason.replace('_', ' ')}` : ''}`}
              </StatusBadge>
              <Text color="foreground-3">
                {issue.user.login} opened {ts(issue.created_at)}
                {issue.closed_at ? ` · closed ${ts(issue.closed_at)}` : ''}
              </Text>
              {issue.labels.map(l => (
                <LabelChip key={l.name} name={l.name} color={l.color} />
              ))}
            </Layout.Flex>
          </Layout.Vertical>
          <Button
            variant="outline"
            disabled={updateIssue.isLoading}
            onClick={() =>
              updateIssue.mutate(
                { state: isOpen ? 'closed' : 'open', state_reason: isOpen ? 'completed' : undefined },
                { onSuccess: () => refetch() }
              )
            }>
            {isOpen ? 'Close issue' : 'Reopen issue'}
          </Button>
        </Layout.Flex>

        {issue.body && (
          <Layout.Vertical className="border border-cn-2 rounded-cn-3 p-cn-md mb-cn-md">
            <Text variant="body-normal" color="foreground-3" className="mb-cn-xs">
              {issue.user.login}
            </Text>
            <MarkdownViewer source={issue.body} />
          </Layout.Vertical>
        )}

        {Object.keys(reactions ?? {}).length > 0 && (
          <Layout.Flex gap="xs" className="mb-cn-md">
            {Object.entries(reactions!).map(([reaction, count]) => (
              <Button
                key={reaction}
                variant="outline"
                size="sm"
                onClick={() =>
                  setReaction.mutate({ reaction, add: false }, { onSuccess: () => refetchReactions() })
                }>
                {REACTION_EMOJI[reaction] ?? reaction} {count}
              </Button>
            ))}
          </Layout.Flex>
        )}

        <Layout.Flex gap="xs" className="mb-cn-lg">
          {['+1', '-1', 'heart', 'rocket', 'eyes'].map(r => (
            <Button
              key={r}
              variant="ghost"
              size="sm"
              onClick={() => setReaction.mutate({ reaction: r, add: true }, { onSuccess: () => refetchReactions() })}>
              {REACTION_EMOJI[r]}
            </Button>
          ))}
        </Layout.Flex>

        <Layout.Vertical gap="md" className="mb-cn-lg">
          {(comments ?? []).map(cm => (
            <Layout.Vertical key={cm.id} className="border border-cn-2 rounded-cn-3 p-cn-md" gap="xs">
              <Text variant="body-normal" color="foreground-3">
                {cm.user.login} · {ts(cm.created_at)}
              </Text>
              <MarkdownViewer source={cm.body} />
            </Layout.Vertical>
          ))}
        </Layout.Vertical>

        <form
          className="flex flex-col gap-cn-sm"
          onSubmit={e => {
            e.preventDefault()
            if (!draft.trim()) return
            addComment.mutate(
              { body: draft },
              { onSuccess: () => { setDraft(''); refetchComments(); refetch() } }
            )
          }}>
          <textarea
            className="border border-cn-2 rounded-cn-2 px-cn-sm py-cn-xs bg-cn-1 text-cn-1 min-h-28"
            placeholder="Leave a comment — markdown supported"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={4}
          />
          <Layout.Flex gap="sm">
            <Button type="submit" disabled={addComment.isLoading || !draft.trim()}>
              {addComment.isLoading ? 'Commenting…' : 'Comment'}
            </Button>
            {isOpen && (
              <Button
                variant="outline"
                type="button"
                disabled={addComment.isLoading || updateIssue.isLoading}
                onClick={e => {
                  e.preventDefault()
                  const post = draft.trim()
                    ? addComment.mutateAsync({ body: draft })
                    : Promise.resolve()
                  void post.then(() =>
                    updateIssue.mutate(
                      { state: 'closed', state_reason: 'completed' },
                      { onSuccess: () => { setDraft(''); refetch(); refetchComments() } }
                    )
                  )
                }}>
                Comment and close
              </Button>
            )}
          </Layout.Flex>
        </form>

        {issue.assignees.length > 0 && (
          <Text color="foreground-3" className="mt-cn-md">
            Assigned to {issue.assignees.map(a => a.login).join(', ')}
          </Text>
        )}
        {issue.milestone && (
          <Text color="foreground-3" className="mt-cn-2xs">
            Milestone: {issue.milestone.title}
          </Text>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}
