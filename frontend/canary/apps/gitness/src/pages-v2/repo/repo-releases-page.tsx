import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import {
  Button,
  Checkbox,
  Layout,
  Link,
  MarkdownViewer,
  NoData,
  SandboxLayout,
  StatusBadge,
  Text,
  TextInput
} from '@harnessio/ui/components'

import { PathParams } from '../../RouteDefinitions'
import {
  useCreateRelease,
  useRelease,
  useReleases,
  useUploadReleaseAsset
} from '../delta/delta-api'

const ts = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : '—')

const fmtBytes = (n: number) =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`

function useRepoParams() {
  const { spaceId = '', repoId = '' } = useParams<PathParams>()
  return { spaceId, repoId, base: `/${spaceId}/repos/${repoId}` }
}

/** Releases list — GitHub-shaped tag+notes+assets rows. */
export function RepoReleasesPage() {
  const { spaceId, repoId, base } = useRepoParams()
  const { data: releases, isLoading } = useReleases(spaceId, repoId)
  const navigate = useNavigate()

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Layout.Flex justify="between" align="center" className="mb-cn-md">
          <Text as="h1" variant="heading-section">
            Releases
          </Text>
          <Button onClick={() => navigate(`${base}/releases/new`)}>New release</Button>
        </Layout.Flex>

        {isLoading ? (
          <Text color="foreground-3">Loading…</Text>
        ) : !releases?.length ? (
          <NoData
            imageName="no-data-folder"
            title="No releases yet"
            description={['Tag a commit, attach notes and binaries — agents can fetch assets over the API.']}
            primaryButton={{ label: 'New release', to: `${base}/releases/new` }}
          />
        ) : (
          <Layout.Vertical gap="md">
            {releases.map(rel => (
              <Layout.Vertical key={rel.id} className="border border-cn-2 rounded-cn-3 p-cn-md" gap="xs">
                <Layout.Flex align="center" gap="sm">
                  <Link
                    to={`${base}/releases/${rel.id}`}
                    variant="secondary"
                    className="text-cn-size-3">
                    {rel.name}
                  </Link>
                  <StatusBadge variant="status" theme="muted">
                    {rel.tag_name}
                  </StatusBadge>
                  {rel.draft && (
                    <StatusBadge variant="status" theme="warning">
                      Draft
                    </StatusBadge>
                  )}
                  {rel.prerelease && (
                    <StatusBadge variant="status" theme="info">
                      Pre-release
                    </StatusBadge>
                  )}
                  <Text color="foreground-3" className="ml-auto">
                    {rel.author.login} · {ts(rel.created_at)}
                  </Text>
                </Layout.Flex>
                {rel.assets.length > 0 && (
                  <Text color="foreground-3">
                    {rel.assets.length} asset{rel.assets.length === 1 ? '' : 's'}
                  </Text>
                )}
              </Layout.Vertical>
            ))}
          </Layout.Vertical>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

/** Release detail — notes + downloadable assets. */
export function RepoReleaseDetailPage() {
  const { spaceId, repoId, base } = useRepoParams()
  const { releaseId = '' } = useParams<{ releaseId: string }>()
  const { data: release, isLoading, refetch } = useRelease(spaceId, repoId, releaseId)
  const uploadAsset = useUploadReleaseAsset(spaceId, repoId, releaseId)
  const navigate = useNavigate()

  if (isLoading) {
    return (
      <SandboxLayout.Main>
        <SandboxLayout.Content>
          <Text color="foreground-3">Loading…</Text>
        </SandboxLayout.Content>
      </SandboxLayout.Main>
    )
  }
  if (!release) {
    return (
      <SandboxLayout.Main>
        <SandboxLayout.Content>
          <NoData imageName="no-data-folder" title="Release not found" description={['It may have been deleted.']} />
        </SandboxLayout.Content>
      </SandboxLayout.Main>
    )
  }

  const assetBase = `/api/v1/repos/${spaceId}/${repoId}/+/releases/${release.id}/assets`

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Layout.Flex justify="between" align="start" className="mb-cn-md">
          <Layout.Vertical gap="2xs">
            <Text as="h1" variant="heading-section">
              {release.name}
            </Text>
            <Layout.Flex align="center" gap="sm">
              <StatusBadge variant="status" theme="muted">
                {release.tag_name}
              </StatusBadge>
              {release.draft && (
                <StatusBadge variant="status" theme="warning">
                  Draft
                </StatusBadge>
              )}
              {release.prerelease && (
                <StatusBadge variant="status" theme="info">
                  Pre-release
                </StatusBadge>
              )}
              <Text color="foreground-3">
                {release.author.login} released {ts(release.created_at)}
              </Text>
            </Layout.Flex>
          </Layout.Vertical>
        </Layout.Flex>

        {release.body && (
          <Layout.Vertical className="border border-cn-2 rounded-cn-3 p-cn-md mb-cn-md">
            <MarkdownViewer source={release.body} />
          </Layout.Vertical>
        )}

        <Layout.Vertical gap="xs" className="mb-cn-lg">
          <Text variant="body-strong" color="foreground-1">
            Assets
          </Text>
          {release.assets.map(a => (
            <Layout.Flex
              key={a.id}
              align="center"
              gap="sm"
              className="border border-cn-2 rounded-cn-2 px-cn-sm py-cn-xs">
              <a href={`${assetBase}/${a.id}`} className="text-cn-link hover:underline">
                {a.name}
              </a>
              <Text color="foreground-3" className="ml-auto">
                {fmtBytes(a.size)} · {a.download_count} downloads
              </Text>
            </Layout.Flex>
          ))}
          <label className="mt-cn-xs">
            <input
              type="file"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0]
                if (!file) return
                uploadAsset.mutate({ name: file.name, file }, { onSuccess: () => refetch() })
                e.target.value = ''
              }}
            />
            <Text as="span" color="foreground-3" className="cursor-pointer hover:underline">
              {uploadAsset.isLoading ? 'Uploading…' : '+ Attach a binary'}
            </Text>
          </label>
        </Layout.Vertical>

        <Button variant="outline" onClick={() => navigate(`${base}/releases`)}>
          Back to releases
        </Button>
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

/** New release composer. */
export function RepoReleaseNewPage() {
  const { spaceId, repoId, base } = useRepoParams()
  const createRelease = useCreateRelease(spaceId, repoId)
  const [tag, setTag] = useState('')
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [prerelease, setPrerelease] = useState(false)
  const navigate = useNavigate()

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          New release
        </Text>
        <form
          className="flex flex-col gap-cn-md max-w-2xl"
          onSubmit={e => {
            e.preventDefault()
            if (!tag.trim()) return
            createRelease.mutate(
              {
                tag_name: tag.trim(),
                name: name.trim() || undefined,
                body: body || undefined,
                draft,
                prerelease
              },
              { onSuccess: rel => navigate(`${base}/releases/${rel.id}`) }
            )
          }}>
          <TextInput
            id="releaseTag"
            label="Tag"
            placeholder="v1.0.0"
            value={tag}
            onChange={e => setTag(e.target.value)}
            autoFocus
          />
          <TextInput
            id="releaseName"
            label="Release title"
            placeholder="Defaults to the tag name"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <label className="flex flex-col gap-cn-2xs">
            <Text variant="body-normal" color="foreground-2">
              Release notes
            </Text>
            <textarea
              className="border border-cn-2 rounded-cn-2 px-cn-sm py-cn-xs bg-cn-1 text-cn-1 min-h-40"
              placeholder="Markdown supported"
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={8}
            />
          </label>
          <Layout.Flex gap="lg">
            <Checkbox
              id="rel-draft"
              checked={draft}
              onCheckedChange={v => setDraft(v === true)}
              label="Draft — hidden until published"
            />
            <Checkbox
              id="rel-pre"
              checked={prerelease}
              onCheckedChange={v => setPrerelease(v === true)}
              label="Pre-release"
            />
          </Layout.Flex>
          <Layout.Flex gap="sm">
            <Button type="submit" disabled={createRelease.isLoading || !tag.trim()}>
              {createRelease.isLoading ? 'Publishing…' : 'Publish release'}
            </Button>
            <Button variant="outline" type="button" onClick={() => navigate(`${base}/releases`)}>
              Cancel
            </Button>
          </Layout.Flex>
          {createRelease.isError && (
            <Text color="danger">{(createRelease.error as Error)?.message ?? 'Create failed'}</Text>
          )}
        </form>
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}
