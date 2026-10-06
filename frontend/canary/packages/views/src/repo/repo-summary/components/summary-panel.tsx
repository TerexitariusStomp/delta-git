import { FC } from 'react'

import {
  Button,
  CounterBadge,
  DropdownMenu,
  IconPropsV2,
  IconV2,
  Layout,
  Link,
  Separator,
  Tag,
  Text,
  TimeAgoCard
} from '@harnessio/ui/components'
import { useCustomDialogTrigger, useTranslation } from '@harnessio/ui/context'

import { EditRepoDetails } from './edit-repo-details-dialog'

interface DetailItem {
  id: string
  iconName: 'git-commit' | 'git-pull-request' | 'tag' | 'git-branch' | NonNullable<IconPropsV2['name']>
  name: string
  count: number
  to: string
}

interface SummaryPanelProps {
  title: string
  details: DetailItem[]
  timestamp?: string
  description?: string
  tags?: Record<string, string>
  /** GitHub-style topic chips (lowercase slug names). */
  topics?: string[]
  /** Project homepage URL shown under the description (GitHub "website"). */
  website?: string | null
  /** Route path to the repo's license file, if one exists at the root. */
  licensePath?: string
  /** Display name of the detected license file (e.g. `LICENSE`, `COPYING`). */
  licenseName?: string
  saveDescription: (description: string) => void
  updateRepoError?: string
  isEditDialogOpen: boolean
  setEditDialogOpen: (value: boolean) => void
}

const SummaryPanel: FC<SummaryPanelProps> = ({
  title,
  details,
  timestamp,
  description = '',
  tags,
  topics,
  website,
  licensePath,
  licenseName,
  saveDescription,
  updateRepoError,
  isEditDialogOpen,
  setEditDialogOpen: _setEditDialogOpen
}) => {
  const { t } = useTranslation()

  const { triggerRef, registerTrigger } = useCustomDialogTrigger()
  const setEditDialogOpen = () => {
    registerTrigger()
    _setEditDialogOpen(true)
  }

  const onClose = () => {
    _setEditDialogOpen(false)
  }
  const onSave = (description: string) => {
    saveDescription(description)
  }

  return (
    <>
      <Layout.Grid gapY="xl" className="pr-cn-sm">
        <Layout.Grid gapX="xs" justify="between" flow="column">
          <Layout.Grid gapY="2xs">
            <Text variant="heading-base" as="h5">
              {title}
            </Text>

            {!!timestamp?.length && (
              <Text as="span" color="foreground-3">
                Created <TimeAgoCard timestamp={timestamp} />
              </Text>
            )}
          </Layout.Grid>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button
                ref={triggerRef}
                variant="ghost"
                size="xs"
                aria-label="More options"
                iconOnly
                tooltipProps={{ content: 'More options' }}
              >
                <IconV2 name="more-horizontal" size="2xs" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item
                onClick={setEditDialogOpen}
                title={
                  description?.length
                    ? t('views:repos.summary.summaryPanel.editDescription', 'Edit description')
                    : t('views:repos.summary.summaryPanel.addDescription', 'Add description')
                }
              />
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </Layout.Grid>

        {!!description?.length && (
          <Layout.Grid gapY="sm">
            <Separator />
            <Text variant="body-normal" lineClamp={6} color="foreground-1">
              {description}
            </Text>
          </Layout.Grid>
        )}

        {!!website && (
          <Layout.Flex align="center" gap="2xs" className="min-w-0">
            <IconV2 name="link" size="xs" className="shrink-0 text-cn-2" />
            <Link variant="secondary" href={website} external className="truncate">
              {website}
            </Link>
          </Layout.Flex>
        )}

        {!!topics?.length && (
          <Layout.Flex wrap="wrap" gap="3xs">
            {topics.map(topic => (
              <Tag key={topic} label={topic} value={topic} variant="outline" size="sm" theme="blue" />
            ))}
          </Layout.Flex>
        )}

        {!!tags && !!Object.keys(tags).length && (
          <Layout.Flex wrap="wrap" gap="3xs">
            {Object.entries(tags).map(([key, value]) => (
              <Tag key={key} label={key || value} value={value || ''} variant="outline" size="sm" theme="gray" />
            ))}
          </Layout.Flex>
        )}

        {!!licensePath && (
          <>
            <Separator />
            <Link variant="secondary" to={licensePath}>
              <Layout.Flex className="cursor-pointer gap-cn-2xs" align="center" gap="2xs">
                <IconV2 name="menu-scale" size="xs" className="text-cn-2" />
                <Text color="foreground-1">{licenseName ?? 'License'}</Text>
              </Layout.Flex>
            </Link>
          </>
        )}

        <Separator />

        <Layout.Grid gapY="sm">
          {details?.map(item => (
            <Link variant="secondary" key={item.id} to={item.to}>
              <Layout.Flex className="cursor-pointer gap-cn-2xs" align="center" gap="2xs">
                <IconV2 name={item.iconName} size="xs" className="text-cn-2" />
                <Text color="foreground-1">{item.name}</Text>
                <CounterBadge>{item.count}</CounterBadge>
              </Layout.Flex>
            </Link>
          ))}
        </Layout.Grid>
      </Layout.Grid>
      <EditRepoDetails
        showEditRepoDetails={isEditDialogOpen}
        description={description}
        onSave={onSave}
        onClose={onClose}
        updateRepoError={updateRepoError}
      />
    </>
  )
}

SummaryPanel.displayName = 'SummaryPanel'

export default SummaryPanel
