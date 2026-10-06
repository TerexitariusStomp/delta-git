import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import {
  Button,
  Layout,
  Link,
  MarkdownViewer,
  NoData,
  SandboxLayout,
  Text,
  TextInput
} from '@harnessio/ui/components'

import { PathParams } from '../../RouteDefinitions'
import {
  useDeleteWikiPage,
  useSaveWikiPage,
  useWikiHistory,
  useWikiPage,
  useWikiPages
} from '../delta/delta-api'

const ts = (sec: number | null | undefined) =>
  sec ? new Date(sec * 1000).toLocaleDateString() : '—'

function useRepoParams() {
  const { spaceId = '', repoId = '' } = useParams<PathParams>()
  return { spaceId, repoId, base: `/${spaceId}/repos/${repoId}` }
}

/** Page-list sidebar — GitHub's "Pages" column. */
function WikiSidebar({ base, pages, active }: { base: string; pages: { name: string }[]; active: string }) {
  return (
    <Layout.Vertical gap="xs" className="w-56 shrink-0">
      <Layout.Flex justify="between" align="center">
        <Text variant="body-strong" color="foreground-1">
          Pages
        </Text>
        <Link to={`${base}/wiki/new`} variant="secondary" className="text-cn-size-1">
          + New
        </Link>
      </Layout.Flex>
      <Layout.Vertical className="border border-cn-2 rounded-cn-3 divide-y divide-cn-2">
        {pages.map(p => (
          <Link
            key={p.name}
            to={`${base}/wiki/${encodeURIComponent(p.name)}`}
            variant="secondary"
            noHoverUnderline
            className={`block px-cn-sm py-cn-2xs hover:bg-cn-2 truncate ${p.name === active ? 'bg-cn-2' : ''}`}>
            {p.name}
          </Link>
        ))}
      </Layout.Vertical>
    </Layout.Vertical>
  )
}

/** Wiki view — rendered page + page list. Defaults to Home. */
export function RepoWikiPage() {
  const { spaceId, repoId, base } = useRepoParams()
  const { page: rawPage } = useParams<{ page: string }>()
  const page = rawPage ?? 'Home'
  const { data: pages, isLoading: pagesLoading } = useWikiPages(spaceId, repoId)
  const { data: doc, isLoading, isError } = useWikiPage(spaceId, repoId, page)
  const { data: history } = useWikiHistory(spaceId, repoId)
  const navigate = useNavigate()

  if (pagesLoading) {
    return (
      <SandboxLayout.Main>
        <SandboxLayout.Content>
          <Text color="foreground-3">Loading…</Text>
        </SandboxLayout.Content>
      </SandboxLayout.Main>
    )
  }

  if (!pages?.length) {
    return (
      <SandboxLayout.Main>
        <SandboxLayout.Content>
          <NoData
            imageName="no-data-folder"
            title="No wiki pages yet"
            description={[
              'A wiki is a git branch of markdown pages — clone it, edit it,',
              'or write the first page here.'
            ]}
            primaryButton={{ label: 'Create the first page', to: `${base}/wiki/new` }}
          />
        </SandboxLayout.Content>
      </SandboxLayout.Main>
    )
  }

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Layout.Flex align="start" gap="lg">
          <Layout.Vertical className="flex-1 min-w-0">
            <Layout.Flex justify="between" align="center" className="mb-cn-md">
              <Text as="h1" variant="heading-section">
                {page}
              </Text>
              <Layout.Flex gap="sm">
                <Button variant="outline" onClick={() => navigate(`${base}/wiki/${encodeURIComponent(page)}/edit`)}>
                  Edit
                </Button>
              </Layout.Flex>
            </Layout.Flex>
            {isLoading ? (
              <Text color="foreground-3">Loading…</Text>
            ) : isError || !doc ? (
              <NoData
                imageName="no-data-folder"
                title="Page not found"
                description={['It may have been deleted.']}
                primaryButton={{ label: 'Create this page', to: `${base}/wiki/new?page=${encodeURIComponent(page)}` }}
              />
            ) : (
              <Layout.Vertical className="border border-cn-2 rounded-cn-3 p-cn-md">
                <MarkdownViewer source={doc.content} />
              </Layout.Vertical>
            )}
            {history && history.length > 0 && (
              <Layout.Vertical gap="xs" className="mt-cn-lg">
                <Text variant="body-strong" color="foreground-2">
                  Recent changes
                </Text>
                {(history ?? []).slice(0, 10).map(h => (
                  <Text key={h.oid} variant="body-normal" color="foreground-3" className="truncate">
                    {h.oid.slice(0, 7)} · {h.message.split('\n')[0]} · {h.author?.name ?? 'unknown'} ·{' '}
                    {ts(h.author?.when)}
                  </Text>
                ))}
              </Layout.Vertical>
            )}
          </Layout.Vertical>
          <WikiSidebar base={base} pages={pages} active={page} />
        </Layout.Flex>
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

/** Wiki editor — new page or edit existing. */
export function RepoWikiEditPage() {
  const { spaceId, repoId, base } = useRepoParams()
  const { page: rawPage } = useParams<{ page: string }>()
  const isNew = rawPage === undefined
  const pageParam = new URLSearchParams(window.location.search).get('page')
  const existingName = isNew ? (pageParam ?? '') : decodeURIComponent(rawPage)

  const { data: existing } = useWikiPage(spaceId, repoId, existingName || '__none__', !isNew)
  const savePage = useSaveWikiPage(spaceId, repoId)
  const deletePage = useDeleteWikiPage(spaceId, repoId)
  const [name, setName] = useState(existingName)
  const [content, setContent] = useState<string | null>(null)
  const navigate = useNavigate()

  const targetName = isNew ? name : existingName
  const effectiveContent = content ?? existing?.content ?? ''

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          {isNew ? 'New wiki page' : `Edit ${existingName}`}
        </Text>
        <form
          className="flex flex-col gap-cn-md"
          onSubmit={e => {
            e.preventDefault()
            if (!targetName.trim()) return
            savePage.mutate(
              {
                page: targetName,
                content: effectiveContent,
                message: `${isNew ? 'Create' : 'Update'} ${targetName}`
              },
              {
                onSuccess: () => navigate(`${base}/wiki/${encodeURIComponent(targetName)}`)
              }
            )
          }}>
          {isNew && (
            <TextInput
              id="wikiPageName"
              label="Page name"
              placeholder="Home, How-To-Deploy, …"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          )}
          <textarea
            className="border border-cn-2 rounded-cn-2 px-cn-sm py-cn-xs bg-cn-1 text-cn-1 min-h-96 font-mono"
            placeholder="Markdown supported"
            value={effectiveContent}
            onChange={e => setContent(e.target.value)}
          />
          <Layout.Flex gap="sm">
            <Button type="submit" disabled={savePage.isLoading || !targetName.trim()}>
              {savePage.isLoading ? 'Saving…' : 'Save page'}
            </Button>
            <Button variant="outline" type="button" onClick={() => navigate(`${base}/wiki`)}>
              Cancel
            </Button>
            {!isNew && (
              <Button
                variant="outline"
                type="button"
                disabled={deletePage.isLoading}
                onClick={() =>
                  deletePage.mutate(existingName, { onSuccess: () => navigate(`${base}/wiki`) })
                }>
                Delete page
              </Button>
            )}
          </Layout.Flex>
          {savePage.isError && (
            <Text color="danger">{(savePage.error as Error)?.message ?? 'Save failed'}</Text>
          )}
        </form>
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}
