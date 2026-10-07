import {
  Alert,
  Button,
  Favorite,
  IconV2,
  Layout,
  Link,
  Popover,
  Skeleton,
  StatusBadge,
  Text
} from '@harnessio/ui/components'
import { useTranslation } from '@harnessio/ui/context'
import { cn, formatDate } from '@harnessio/ui/utils'

import { RepositoryType } from '../repo.types'
import { ForkedFrom } from './forked-from'

interface SponsorLink {
  platform: string
  value: string
  url: string
}

interface RepoHeaderProps {
  name: string
  isPublic: boolean
  isArchived?: boolean
  isLinked?: boolean
  isLoading?: boolean
  className?: string
  isFavorite?: boolean
  onFavoriteToggle: (isFavorite: boolean) => void
  /** GitHub-style star count shown beside the favorite toggle. */
  starCount?: number
  /** Parsed FUNDING.yml links — renders the GitHub-style Sponsor button. */
  sponsors?: SponsorLink[]
  onSyncLinked?: () => void
  isSyncing?: boolean
  archivedDate?: number
  upstream?: RepositoryType['upstream']
  toUpstreamRepo?: (path: string, subPath?: string) => string
}

export const RepoHeader = ({
  name,
  isPublic,
  isArchived,
  isLinked,
  isLoading,
  className,
  isFavorite,
  onFavoriteToggle,
  starCount,
  sponsors,
  onSyncLinked,
  isSyncing,
  archivedDate,
  upstream,
  toUpstreamRepo
}: RepoHeaderProps) => {
  const { t } = useTranslation()

  const formattedDate = archivedDate ? formatDate(archivedDate) : ''

  return (
    <Layout.Grid className={cn('cn-repo-header', className)} gapY="md">
      <Layout.Flex direction="column" gap="3xs">
        <Layout.Flex justify="start" align="center">
          {isLoading ? (
            <>
              <Layout.Flex gap="xs" justify="start" align="center">
                <Skeleton.Box className="h-[var(--cn-line-height-24)] w-28" />
                <Skeleton.Box className="h-6 w-14" />
              </Layout.Flex>
              <Skeleton.Box className="h-6 w-14" />
            </>
          ) : (
            <>
              <Layout.Flex gap="xs" justify="start" align="center">
                <Text className="truncate" variant="heading-hero" as="h2">
                  {name}
                </Text>

                <StatusBadge variant="outline" theme={!isPublic ? 'muted' : 'success'} size="md">
                  {!isPublic ? t('views:repos.private', 'Private') : t('views:repos.public', 'Public')}
                </StatusBadge>

                {isArchived && (
                  <StatusBadge variant="outline" theme="warning" size="md">
                    {t('views:repos.archived', 'Archived')}
                  </StatusBadge>
                )}
              </Layout.Flex>

              <Favorite isFavorite={isFavorite} onFavoriteToggle={onFavoriteToggle} />
              {starCount !== undefined && (
                <Text variant="body-normal" color="foreground-3">
                  {starCount} {starCount === 1 ? 'star' : 'stars'}
                </Text>
              )}

              {sponsors !== undefined && sponsors.length === 1 && (
                <Button variant="outline" size="sm" asChild>
                  <Link
                    external
                    noHoverUnderline
                    href={sponsors[0].url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <IconV2 name="heart" size="xs" />
                    {t('views:repos.sponsor', 'Sponsor')}
                  </Link>
                </Button>
              )}
              {sponsors !== undefined && sponsors.length > 1 && (
                <Popover.Root>
                  <Popover.Trigger asChild>
                    <Button variant="outline" size="sm">
                      <IconV2 name="heart" size="xs" />
                      {t('views:repos.sponsor', 'Sponsor')}
                      <IconV2 className="chevron-down" name="nav-arrow-down" size="2xs" />
                    </Button>
                  </Popover.Trigger>
                  <Popover.Content align="start" className="w-64" hideArrow>
                    <Layout.Grid gapY="2xs">
                      {sponsors.map(link => (
                        <Button key={link.url} variant="ghost" size="sm" className="justify-start" asChild>
                          <Link
                            external
                            noHoverUnderline
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {link.platform === 'custom' ? link.url : `${link.platform}: ${link.value}`}
                          </Link>
                        </Button>
                      ))}
                    </Layout.Grid>
                  </Popover.Content>
                </Popover.Root>
              )}
            </>
          )}
        </Layout.Flex>

        {upstream && <ForkedFrom upstream={upstream} toUpstreamRepo={toUpstreamRepo} />}
      </Layout.Flex>

      {isArchived && (
        <Alert.Root theme="warning">
          <Alert.Description>
            {formattedDate
              ? t('views:repos.archivedBanner', 'This repository has been archived on {{date}}. It is now read-only.', {
                  date: formattedDate
                })
              : t('views:repos.archivedBannerNoDate', 'This repository has been archived. It is now read-only.')}
          </Alert.Description>
        </Alert.Root>
      )}

      {isLinked && (
        <Alert.Root theme="info" className="items-center bg-transparent border border-current/30">
          <Alert.Description className="flex flex-1 items-center justify-between gap-x-3">
            <span>
              {t(
                'views:repos.linkedBanner',
                'This repository is linked from an external source. Content is synced automatically and cannot be edited directly.'
              )}
            </span>
            {onSyncLinked && (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                tooltipProps={{
                  content: isSyncing
                    ? t('views:repos.link.syncing', 'Syncing…')
                    : t('views:repos.link.sync', 'Sync now')
                }}
                onClick={onSyncLinked}
                disabled={isSyncing}
                className="shrink-0"
              >
                <IconV2 name="refresh" className={isSyncing ? 'animate-spin' : ''} />
              </Button>
            )}
          </Alert.Description>
        </Alert.Root>
      )}
    </Layout.Grid>
  )
}
