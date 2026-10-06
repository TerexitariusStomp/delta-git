import { useSearchParams } from 'react-router-dom'

import { Button, Layout, Link, NoData, SandboxLayout, Tag, Text } from '@harnessio/ui/components'

import { useExplore } from './delta/delta-api'

/** Public discovery surface — most-starred repos + topic browse. */
export function ExplorePage() {
  const [params, setParams] = useSearchParams()
  const topic = params.get('topic') ?? undefined
  const { data, isLoading } = useExplore(topic)

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Layout.Flex justify="between" align="center" className="mb-cn-md">
          <Text as="h1" variant="heading-section">
            {topic ? `Topic: ${topic}` : 'Explore'}
          </Text>
          {topic && (
            <Button variant="outline" onClick={() => setParams({})}>
              Clear topic
            </Button>
          )}
        </Layout.Flex>

        {!!data?.topics?.length && (
          <Layout.Flex wrap="wrap" gap="xs" className="mb-cn-lg">
            {data.topics.map(t => (
              <button key={t.topic} onClick={() => setParams({ topic: t.topic })} className="cursor-pointer">
                <Tag label={`${t.topic} (${t.repos})`} value={t.topic} variant="outline" theme="blue" />
              </button>
            ))}
          </Layout.Flex>
        )}

        {isLoading ? (
          <Text color="foreground-3">Loading…</Text>
        ) : !data?.repos?.length ? (
          <NoData
            imageName="no-data-folder"
            title="Nothing to explore yet"
            description={['Star a repository to help it trend, or tag repos with topics.']}
          />
        ) : (
          <Layout.Vertical gap="xs" className="divide-y divide-cn-2 border border-cn-2 rounded-cn-3">
            {data.repos.map(repo => (
              <Link
                key={repo.full_name}
                to={`/${repo.owner}/repos/${repo.name}`}
                variant="secondary"
                noHoverUnderline
                className="block px-cn-md py-cn-sm hover:bg-cn-2">
                <Layout.Vertical gap="2xs">
                  <Layout.Flex align="center" gap="sm">
                    <Text variant="body-strong" color="foreground-1">
                      {repo.full_name}
                    </Text>
                    <Text variant="body-normal" color="foreground-3" className="ml-auto shrink-0">
                      ★ {repo.stargazers_count}
                    </Text>
                  </Layout.Flex>
                  {repo.description && (
                    <Text variant="body-normal" color="foreground-3" lineClamp={2}>
                      {repo.description}
                    </Text>
                  )}
                </Layout.Vertical>
              </Link>
            ))}
          </Layout.Vertical>
        )}
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}
