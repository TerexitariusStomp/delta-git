import { useParams } from 'react-router-dom'

import { Layout, NoData, SandboxLayout, Text } from '@harnessio/ui/components'

import { PathParams } from '../../RouteDefinitions'
import { useActivity, useContributors, usePulse } from '../delta/delta-api'

const ts = (sec: number) => new Date(sec * 1000).toLocaleDateString()

function useRepoParams() {
  const { spaceId = '', repoId = '' } = useParams<PathParams>()
  return { spaceId, repoId }
}

/** 52-week commit activity — CSS bars, no chart dep needed. */
function ActivityChart({ weeks }: { weeks: { week: number; commits: number }[] }) {
  const max = Math.max(1, ...weeks.map(w => w.commits))
  return (
    <Layout.Vertical gap="xs">
      <Text variant="body-strong" color="foreground-1">
        Commit activity — last 52 weeks
      </Text>
      <div className="flex items-end gap-px h-28 border border-cn-2 rounded-cn-3 p-cn-sm">
        {weeks.map(w => (
          <div
            key={w.week}
            title={`${w.commits} commits — week of ${ts(w.week)}`}
            className="flex-1 bg-cn-success rounded-sm min-h-px"
            style={{ height: `${Math.max(2, (w.commits / max) * 100)}%` }}
          />
        ))}
      </div>
    </Layout.Vertical>
  )
}

/** Insights — pulse numbers, activity chart, contributors. */
export function RepoInsightsPage() {
  const { spaceId, repoId } = useRepoParams()
  const { data: pulse, isLoading: pulseLoading } = usePulse(spaceId, repoId)
  const { data: activity } = useActivity(spaceId, repoId)
  const { data: contributors, isLoading: contribLoading } = useContributors(spaceId, repoId)

  if (pulseLoading || contribLoading) {
    return (
      <SandboxLayout.Main>
        <SandboxLayout.Content>
          <Text color="foreground-3">Loading…</Text>
        </SandboxLayout.Content>
      </SandboxLayout.Main>
    )
  }

  if (!pulse) {
    return (
      <SandboxLayout.Main>
        <SandboxLayout.Content>
          <NoData
            imageName="no-data-folder"
            title="No activity yet"
            description={['Insights populate once commits land on the default branch.']}
          />
        </SandboxLayout.Content>
      </SandboxLayout.Main>
    )
  }

  const stats: { label: string; value: number }[] = [
    { label: 'Commits · 7d', value: pulse.commits_7d },
    { label: 'Commits · 30d', value: pulse.commits_30d },
    { label: 'Authors · 7d', value: pulse.authors_7d },
    { label: 'Authors · 30d', value: pulse.authors_30d },
    { label: 'Open issues', value: pulse.open_issues },
    { label: 'Closed issues', value: pulse.closed_issues },
    { label: 'Open pull requests', value: pulse.open_pull_requests }
  ]

  const totalCommits = (contributors ?? []).reduce((n, c) => n + c.commits, 0)

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <Text as="h1" variant="heading-section" className="mb-cn-md">
          Pulse
        </Text>

        <Layout.Flex gap="sm" wrap="wrap" className="mb-cn-lg">
          {stats.map(s => (
            <Layout.Vertical
              key={s.label}
              className="border border-cn-2 rounded-cn-3 px-cn-md py-cn-sm min-w-32"
              gap="2xs">
              <Text variant="heading-subsection" color="foreground-1">
                {s.value}
              </Text>
              <Text variant="body-normal" color="foreground-3">
                {s.label}
              </Text>
            </Layout.Vertical>
          ))}
        </Layout.Flex>

        {pulse.history_truncated && (
          <Text color="foreground-3" className="mb-cn-md">
            Showing the most recent 500 commits — earlier history is not included.
          </Text>
        )}

        {activity && activity.weeks.length > 0 && (
          <Layout.Vertical className="mb-cn-lg">
            <ActivityChart weeks={activity.weeks} />
          </Layout.Vertical>
        )}

        <Layout.Vertical gap="xs">
          <Text variant="body-strong" color="foreground-1">
            Contributors
          </Text>
          {(contributors ?? []).length === 0 ? (
            <Text color="foreground-3">No contributors yet.</Text>
          ) : (
            (contributors ?? []).map(c => {
              const pct = totalCommits ? Math.round((c.commits / totalCommits) * 100) : 0
              return (
                <Layout.Vertical key={c.email} gap="3xs" className="border-b border-cn-2 pb-cn-xs">
                  <Layout.Flex justify="between" align="center">
                    <Text variant="body-strong" color="foreground-1">
                      {c.name}
                    </Text>
                    <Text variant="body-normal" color="foreground-3">
                      {c.commits} commits · {pct}%
                    </Text>
                  </Layout.Flex>
                  <div className="h-1.5 rounded-cn-full bg-cn-2 overflow-hidden">
                    <div className="h-full bg-cn-success" style={{ width: `${pct}%` }} />
                  </div>
                </Layout.Vertical>
              )
            })
          )}
        </Layout.Vertical>
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}
