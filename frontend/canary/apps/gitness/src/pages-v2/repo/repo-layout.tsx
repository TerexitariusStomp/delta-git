import { Outlet, useMatches, useParams } from 'react-router-dom'

import { useLinkedSyncRepositoryMutation } from '@harnessio/code-service-client'
import { toast } from '@harnessio/ui/components'
import { NotFoundPage, RepoHeader, RepoSubheader, SubHeaderWrapper } from '@harnessio/views'

import { PublicAccessGuard } from '../../components-v2/public-access'
import { useRepoHotkeys } from '../../delta/use-repo-hotkeys'
import { useRepoFunding, useRepoStar, useToggleStar } from '../delta/delta-api'
import { useRoutes } from '../../framework/context/NavigationContext'
import { useGetRepoRef } from '../../framework/hooks/useGetRepoPath'
import { useIsMFE } from '../../framework/hooks/useIsMFE'
import { CustomHandle } from '../../framework/routing/types'
import { useGitRef } from '../../hooks/useGitRef'
import { useRepoCommits } from '../../hooks/useRepoCommits'
import { useUpstreamRepoUrl } from '../../hooks/useUpstreamRepoUrl'
import { PathParams } from '../../RouteDefinitions'
import { isRefABranch } from '../../utils/git-utils'

const RepoLayout = () => {
  const isMFE = useIsMFE()
  const routes = useRoutes()
  const { spaceId, repoId } = useParams<PathParams>()
  const { toRepoCommits } = useRepoCommits()
  const { isLoading, gitRefName, gitRefPath, repoData, fullGitRef, defaultBranch, repoFetchError } =
    useGitRef()
  const toUpstreamRepo = useUpstreamRepoUrl()
  // GitHub-flavoured repo hotkeys (t/y/./g */?) — returns the ? cheatsheet element.
  const repoHotkeys = useRepoHotkeys()

  const repoRef = useGetRepoRef()

  // GitHub-style repo stars — the Favorite icon now drives the real
  // cross-repo social graph, not the legacy KV favorites lane.
  const { data: star, refetch: refetchStar } = useRepoStar(spaceId ?? '', repoId ?? '')
  const toggleStar = useToggleStar(spaceId ?? '', repoId ?? '')
  // GitHub's FUNDING.yml convention — parsed server-side, renders the
  // Sponsor button beside the star toggle when the repo declares links.
  const { data: fundingLinks } = useRepoFunding(spaceId ?? '', repoId ?? '')

  const { mutate: syncLinkedRepo, isLoading: isSyncing } = useLinkedSyncRepositoryMutation(
    { repo_ref: repoRef },
    {
      onSuccess: () => {
        toast.success({ title: 'Sync started successfully' })
      },
      onError: err => {
        toast.danger({ title: err?.message || 'Failed to start sync' })
      }
    }
  )

  const isOnBranch = isRefABranch(fullGitRef)

  const onSyncLinked = () => {
    syncLinkedRepo({ repo_ref: repoRef, body: { branches: [gitRefName] } })
  }

  const onFavoriteToggle = async (isFavorite: boolean) => {
    try {
      await toggleStar.mutateAsync(isFavorite)
      refetchStar()
    } catch {
      toast.danger({ title: 'Sign in to star repositories' })
    }
  }

  // Removing gitRef from summary, files and commits path when navigating from compare page
  const matches = useMatches()
  const isComparePage = matches.some(match => match.pathname.includes('/pulls/compare/'))
  const shouldHideLayout = matches.some(match => (match.handle as CustomHandle)?.hideLayout ?? false)

  const summaryPathRef = isComparePage ? defaultBranch : gitRefPath
  const filesPathRef = isComparePage ? defaultBranch : gitRefPath
  const commitsPathRef = isComparePage ? defaultBranch : gitRefName

  if (repoFetchError) {
    return <NotFoundPage titleText={repoFetchError.message} pageTypeText="repositories" />
  }

  return (
    <>
      {!shouldHideLayout && (
        <>
          <RepoHeader
            name={repoData?.identifier ?? ''}
            isPublic={!!repoData?.is_public}
            isArchived={repoData?.archived}
            isLinked={repoData?.repo_type === 'linked'}
            isLoading={isLoading}
            isFavorite={star?.starred ?? repoData?.is_favorite}
            starCount={star?.stargazers_count}
            sponsors={fundingLinks}
            onFavoriteToggle={onFavoriteToggle}
            onSyncLinked={isOnBranch ? onSyncLinked : undefined}
            isSyncing={isSyncing}
            archivedDate={repoData?.updated}
            upstream={repoData?.upstream}
            toUpstreamRepo={toUpstreamRepo}
          />

          <SubHeaderWrapper>
            <RepoSubheader
              showPipelinesTab={!isMFE}
              showSearchTab={isMFE}
              summaryPath={routes.toRepoSummary({ spaceId, repoId, '*': summaryPathRef })}
              filesPath={routes.toRepoFiles({ spaceId, repoId, '*': filesPathRef })}
              commitsPath={toRepoCommits({ spaceId, repoId, fullGitRef, gitRefName: commitsPathRef })}
              isRepoEmpty={!!repoData?.is_empty}
              deltaPaths={{
                intents: routes.toRepoIntents({ spaceId, repoId }),
                ideas: routes.toRepoIdeas({ spaceId, repoId }),
                arena: routes.toRepoArena({ spaceId, repoId }),
                agents: routes.toRepoAgents({ spaceId, repoId }),
                knowledge: routes.toRepoKnowledge({ spaceId, repoId })
              }}
            />
          </SubHeaderWrapper>
        </>
      )}

      <PublicAccessGuard>
        <Outlet />
      </PublicAccessGuard>
      {repoHotkeys.cheatsheet}
    </>
  )
}

export default RepoLayout
