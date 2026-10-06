import { useParams } from 'react-router-dom'

import { NoData, SandboxLayout } from '@harnessio/ui/components'

import { PathParams } from '../../RouteDefinitions'

interface StubSurface {
  title: string
  /** What the GitHub-familiar surface will do when it lands. */
  blurb: string
  /** The delta-native surface that already covers the underlying need. */
  altLabel: string
  /** Repo-relative path for the delta-native alternative (e.g. `intents`). */
  altPath?: string
}

/**
 * Placeholder for GitHub-parity surfaces that have not landed yet. Keeps the
 * GitHub-style tab IA legible without shipping dead links — each stub names
 * the roadmap surface and links the delta-native equivalent that works today.
 */
export default function RepoStubPage({ surface }: { surface: keyof typeof STUB_SURFACES }) {
  const { spaceId = '', repoId = '' } = useParams<PathParams>()
  const spec = STUB_SURFACES[surface]
  const altPath = spec.altPath ? `/${spaceId}/repos/${repoId}/${spec.altPath}` : undefined

  return (
    <SandboxLayout.Main>
      <SandboxLayout.Content>
        <NoData
          imageName="no-data-folder"
          title={spec.title}
          description={[spec.blurb]}
          primaryButton={
            altPath
              ? {
                  label: spec.altLabel,
                  icon: 'arrow-right',
                  to: altPath
                }
              : undefined
          }
        />
      </SandboxLayout.Content>
    </SandboxLayout.Main>
  )
}

const STUB_SURFACES: Record<string, StubSurface> = {
  issues: {
    title: 'Issues',
    blurb:
      'GitHub-style issues are landing on this repo — labels, milestones, assignees and discussions. Underneath, every issue is an agent-claimable work intent.',
    altLabel: 'Open merge intents',
    altPath: 'intents'
  },
  discussions: {
    title: 'Discussions',
    blurb:
      'Threaded community discussions with categories and answers are on the roadmap. Agents participate alongside humans.',
    altLabel: 'Open ideas',
    altPath: 'ideas'
  },
  projects: {
    title: 'Projects',
    blurb:
      'Board, table and roadmap views tracking issues, merge intents and agent work — landing in the parity roadmap.',
    altLabel: 'Open merge intents',
    altPath: 'intents'
  },
  wiki: {
    title: 'Wiki',
    blurb: 'A git-backed wiki for this repository is on the roadmap — pages live in a hidden repo and push like code.',
    altLabel: 'Browse the files',
    altPath: 'files'
  },
  security: {
    title: 'Security',
    blurb:
      'SECURITY.md rendering, advisories, private vulnerability reports, dependency graph and scan findings are on the roadmap.',
    altLabel: 'Open knowledge',
    altPath: 'knowledge'
  },
  insights: {
    title: 'Insights',
    blurb:
      'Pulse, contributors, commit activity, code frequency, network and traffic — reputation-weighted — are on the roadmap.',
    altLabel: 'Open the arena',
    altPath: 'arena'
  }
}
