import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import {
  Button,
  Layout,
  Link,
  MarkdownViewer,
  NoData,
  SandboxLayout,
  Select,
  StatusBadge,
  Text,
  TextInput
} from '@harnessio/ui/components'

import { PathParams } from '../../RouteDefinitions'
import {
  DiscussionCategory,
  useCreateDiscussion,
  useCreateDiscussionComment,
  useDiscussion,
  useDiscussionComments,
  useDiscussionReaction,
  useDiscussionReactions,
  useDiscussions,
  useMarkDiscussionAnswer
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

const CATEGORY_LABEL: Record<DiscussionCategory, string> = {
  general: 'General',
  announcements: 'Announcements',
  ideas: 'Ideas',
  'q-a': 'Q&A',
  'show-and-tell': 'Show and tell',
  polls: 'Polls'
}

const CATEGORIES: DiscussionCategory[] = ['general', 'announcements', 'ideas', 'q-a', 'show-and-tell', 'polls']

function useRepoParams() {
  const { spaceId = '', repoId = '' } = useParams<PathParams>()
  return { spaceId, repoId, base: `/${spaceId}/repos/${repoId}` }
}

/** Discussions list — GitHub-shaped rows over DO-backed threads. */
export function RepoDiscussionsPage() {
  const { spaceId, repoId, base } = useRepoParams()
  const [category, setCategory] = useState<DiscussionCategory | 'all'>('all')
  const { data: discussions, isLoading } = useDiscussions(spaceId, repoId, category)
  const navigate = useNavigate()

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Layout.Flex justify="between" align="center" className="mb-cn-md">
          <Text as="h1" variant="heading-section">
            Discussions
          </Text>
          <Button onClick={() => navigate(`${base}/discussions/new`)}>New discussion</Button>
        </Layout.Flex>

        <Layout.Flex gap="sm" className="mb-cn-md" wrap="wrap">
          <Button
            variant={category === 'all' ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setCategory('all')}>
            All
          </Button>
          {CATEGORIES.map(cat => (
            <Button
              key={cat}
              variant={category === cat ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setCategory(cat)}>
              {CATEGORY_LABEL[cat]}
            </Button>
          ))}
        </Layout.Flex>

        {isLoading ? (
          <Text color="foreground-3">Loading…</Text>
        ) : !discussions?.length ? (
          <NoData
            imageName="no-data-folder"
            title="No discussions yet"
            description={['Start the first thread — questions, announcements, and ideas all live here.']}
            primaryButton={{ label: 'New discussion', to: `${base}/discussions/new` }}
          />
        ) : (
          <Layout.Vertical gap="xs" className="border border-cn-2 rounded-cn-3 divide-y divide-cn-2">
            {discussions.map(d => (
              <Link
                key={d.number}
                to={`${base}/discussions/${d.number}`}
                variant="secondary"
                noHoverUnderline
                className="block px-cn-md py-cn-sm hover:bg-cn-2">
                <Layout.Flex align="center" gap="sm">
                  <StatusBadge variant="status" theme="muted" className="shrink-0">
                    {CATEGORY_LABEL[d.category]}
                  </StatusBadge>
                  <Text variant="body-strong" color="foreground-1" className="truncate">
                    {d.title}
                  </Text>
                  {d.answer_comment_id && (
                    <StatusBadge variant="status" theme="success" className="shrink-0">
                      Answered
                    </StatusBadge>
                  )}
                  <Layout.Flex align="center" gap="sm" className="ml-auto shrink-0">
                    <Text variant="body-normal" color="foreground-3">
                      #{d.number} · {d.user.login} · {ts(d.created_at)}
                    </Text>
                    {d.comments > 0 && (
                      <Text variant="body-normal" color="foreground-3">
                        💬 {d.comments}
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

/** New discussion composer. */
export function RepoDiscussionNewPage() {
  const { spaceId, repoId, base } = useRepoParams()
  const createDiscussion = useCreateDiscussion(spaceId, repoId)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [category, setCategory] = useState<DiscussionCategory>('general')
  const navigate = useNavigate()

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          New discussion
        </Text>
        <form
          className="flex flex-col gap-cn-md max-w-2xl"
          onSubmit={e => {
            e.preventDefault()
            if (!title.trim()) return
            createDiscussion.mutate(
              { title: title.trim(), body: body || undefined, category },
              { onSuccess: d => navigate(`${base}/discussions/${d.number}`) }
            )
          }}>
          <Select
            value={category}
            options={CATEGORIES.map(cat => ({ value: cat, label: CATEGORY_LABEL[cat] }))}
            onChange={v => setCategory(v as DiscussionCategory)}
            label="Category"
            contentWidth="auto"
            wrapperClassName="w-full"
          />
          <TextInput
            id="discussionTitle"
            label="Title"
            placeholder="Title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            autoFocus
          />
          <label className="flex flex-col gap-cn-2xs">
            <Text variant="body-normal" color="foreground-2">
              Body
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
            <Button type="submit" disabled={createDiscussion.isLoading || !title.trim()}>
              {createDiscussion.isLoading ? 'Creating…' : 'Start discussion'}
            </Button>
            <Button variant="outline" type="button" onClick={() => navigate(`${base}/discussions`)}>
              Cancel
            </Button>
          </Layout.Flex>
          {createDiscussion.isError && (
            <Text color="danger">{(createDiscussion.error as Error)?.message ?? 'Create failed'}</Text>
          )}
        </form>
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

/** Discussion detail — header + body + comments + accepted-answer marking. */
export function RepoDiscussionDetailPage() {
  const { spaceId, repoId } = useRepoParams()
  const { discussionNumber = '' } = useParams<{ discussionNumber: string }>()
  const number = parseInt(discussionNumber, 10)
  const { data: discussion, isLoading, refetch } = useDiscussion(spaceId, repoId, number)
  const { data: comments, refetch: refetchComments } = useDiscussionComments(spaceId, repoId, number)
  const { data: reactions, refetch: refetchReactions } = useDiscussionReactions(spaceId, repoId, number)
  const addComment = useCreateDiscussionComment(spaceId, repoId, number)
  const setReaction = useDiscussionReaction(spaceId, repoId, number)
  const markAnswer = useMarkDiscussionAnswer(spaceId, repoId, number)
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
  if (!discussion) {
    return (
      <SandboxLayout.Main>
        <SandboxLayout.Content>
          <NoData
            imageName="no-data-folder"
            title="Discussion not found"
            description={['It may have been deleted.']}
          />
        </SandboxLayout.Content>
      </SandboxLayout.Main>
    )
  }

  const isQa = discussion.category === 'q-a'

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Layout.Vertical gap="2xs" className="mb-cn-md">
          <Text as="h1" variant="heading-section">
            {discussion.title}{' '}
            <Text as="span" color="foreground-3">
              #{discussion.number}
            </Text>
          </Text>
          <Layout.Flex align="center" gap="sm">
            <StatusBadge variant="status" theme="muted">
              {CATEGORY_LABEL[discussion.category]}
            </StatusBadge>
            {discussion.answer_comment_id && (
              <StatusBadge variant="status" theme="success">
                Answered
              </StatusBadge>
            )}
            <Text color="foreground-3">
              {discussion.user.login} started {ts(discussion.created_at)}
            </Text>
          </Layout.Flex>
        </Layout.Vertical>

        {discussion.body && (
          <Layout.Vertical className="border border-cn-2 rounded-cn-3 p-cn-md mb-cn-md">
            <Text variant="body-normal" color="foreground-3" className="mb-cn-xs">
              {discussion.user.login}
            </Text>
            <MarkdownViewer source={discussion.body} />
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
          {(comments ?? []).map(cm => {
            const isAnswer = discussion.answer_comment_id === cm.id
            return (
              <Layout.Vertical
                key={cm.id}
                className={`border rounded-cn-3 p-cn-md ${isAnswer ? 'border-cn-success' : 'border-cn-2'}`}
                gap="xs">
                <Layout.Flex justify="between" align="center">
                  <Text variant="body-normal" color="foreground-3">
                    {cm.user.login} · {ts(cm.created_at)}
                  </Text>
                  {isQa &&
                    (isAnswer ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={markAnswer.isLoading}
                        onClick={() =>
                          markAnswer.mutate({ commentId: null }, { onSuccess: () => refetch() })
                        }>
                        Unmark answer
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={markAnswer.isLoading}
                        onClick={() =>
                          markAnswer.mutate({ commentId: cm.id }, { onSuccess: () => refetch() })
                        }>
                        Mark as answer
                      </Button>
                    ))}
                </Layout.Flex>
                {isAnswer && (
                  <StatusBadge variant="status" theme="success">
                    Accepted answer
                  </StatusBadge>
                )}
                <MarkdownViewer source={cm.body} />
              </Layout.Vertical>
            )
          })}
        </Layout.Vertical>

        <form
          className="flex flex-col gap-cn-sm"
          onSubmit={e => {
            e.preventDefault()
            if (!draft.trim()) return
            addComment.mutate(
              { body: draft },
              {
                onSuccess: () => {
                  setDraft('')
                  refetchComments()
                  refetch()
                }
              }
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
          </Layout.Flex>
        </form>
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}
