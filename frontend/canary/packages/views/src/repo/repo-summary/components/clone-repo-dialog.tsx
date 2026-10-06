import { FC } from 'react'

import { Alert, Button, CopyButton, IconV2, Layout, Link, Popover, Tabs, TextInput } from '@harnessio/ui/components'
import { useCustomDialogTrigger, useTranslation } from '@harnessio/ui/context'

export interface CloneRepoDialogProps {
  sshUrl?: string
  httpsUrl: string
  isSSHEnabled?: boolean
  handleCreateToken: () => void
  tokenGenerationError?: string | null
  /** Direct-download archive URL for the selected ref (`.zip`). */
  zipUrl?: string
  /** Namespace/repo slug the `dgit` client addresses (e.g. `alice/my-repo`). */
  dgitRepoRef?: string
  /** Host origin the `dgit` client targets — `dgit login --host`. */
  dgitHost?: string
}

export enum CloneRepoTabs {
  HTTPS = 'https',
  SSH = 'ssh',
  DGIT = 'dgit'
}

export const CloneRepoDialog: FC<CloneRepoDialogProps> = ({
  httpsUrl,
  sshUrl,
  isSSHEnabled,
  handleCreateToken: _handleCreateToken,
  tokenGenerationError,
  zipUrl,
  dgitRepoRef,
  dgitHost
}) => {
  const { t } = useTranslation()
  const { triggerRef, registerTrigger } = useCustomDialogTrigger()

  const handleCreateToken = () => {
    registerTrigger()
    _handleCreateToken()
  }

  const dgitLogin = dgitHost ? `dgit login --host ${dgitHost}` : 'dgit login'

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button ref={triggerRef}>
          <IconV2 name="copy" size="sm" />
          {t('views:repos.cloneRepo', 'Clone repository')}
        </Button>
      </Popover.Trigger>
      <Popover.Content
        className="w-[360px]"
        align="end"
        title={t('views:repos.cloneRepo', 'Clone repository')}
        hideArrow
      >
        <Tabs.Root defaultValue={CloneRepoTabs.HTTPS}>
          <Tabs.List className="mb-cn-sm -mx-[var(--cn-popover-py)] px-[var(--cn-popover-py)]" variant="overlined">
            <Tabs.Trigger value={CloneRepoTabs.HTTPS}>{t('views:repos.cloneHttps', 'HTTPS')}</Tabs.Trigger>
            {isSSHEnabled && (
              <Tabs.Trigger value={CloneRepoTabs.SSH} disabled={!sshUrl}>
                {t('views:repos.cloneSsh', 'SSH')}
              </Tabs.Trigger>
            )}
            {!!dgitRepoRef && <Tabs.Trigger value={CloneRepoTabs.DGIT}>dgit</Tabs.Trigger>}
          </Tabs.List>

          <Tabs.Content value={CloneRepoTabs.HTTPS}>
            <Layout.Vertical gap="sm">
              <TextInput
                className="truncate"
                label={t('views:repos.gitCloneUrl', 'Git clone URL')}
                id="httpsUrl"
                readOnly
                value={httpsUrl}
                suffix={<CopyButton name={httpsUrl} buttonVariant="transparent" />}
                caption={t(
                  'views:repos.generateCredential',
                  'Please generate a clone credential if its your first time.'
                )}
              />

              <Button onClick={handleCreateToken} className="w-full">
                {t('views:repos.cloneCredential', 'Generate Clone Credential')}
              </Button>

              {!!tokenGenerationError && (
                <Alert.Root theme="danger">
                  <Alert.Description>{tokenGenerationError}</Alert.Description>
                </Alert.Root>
              )}
            </Layout.Vertical>
          </Tabs.Content>

          <Tabs.Content value={CloneRepoTabs.SSH}>
            <TextInput
              className="truncate"
              id="sshUrl"
              label={t('views:repos.gitCloneUrl', 'Git clone URL')}
              readOnly
              value={sshUrl ?? ''}
              suffix={<CopyButton name={sshUrl || ''} buttonVariant="transparent" />}
            />
          </Tabs.Content>

          <Tabs.Content value={CloneRepoTabs.DGIT}>
            <Layout.Vertical gap="sm">
              <TextInput
                className="truncate"
                id="dgitLogin"
                label={t('views:repos.dgitLogin', 'Sign in once')}
                readOnly
                value={dgitLogin}
                suffix={<CopyButton name={dgitLogin} buttonVariant="transparent" />}
              />
              <TextInput
                className="truncate"
                id="dgitIntents"
                label={t('views:repos.dgitIntents', 'List merge intents')}
                readOnly
                value={`dgit intents ${dgitRepoRef ?? ''}`}
                suffix={<CopyButton name={`dgit intents ${dgitRepoRef ?? ''}`} buttonVariant="transparent" />}
              />
              <TextInput
                className="truncate"
                id="dgitHooks"
                label={t('views:repos.dgitHooks', 'Scan-gated pushes')}
                readOnly
                value="dgit hooks install --global"
                suffix={<CopyButton name="dgit hooks install --global" buttonVariant="transparent" />}
                caption={t(
                  'views:repos.dgitCaption',
                  'The delta-git client adds OAuth sign-in and a pre-push secret scan to plain git.'
                )}
              />
            </Layout.Vertical>
          </Tabs.Content>
        </Tabs.Root>

        {!!zipUrl && (
          <Layout.Vertical gap="xs" className="mt-cn-sm border-t pt-cn-sm">
            <Link external variant="secondary" href={zipUrl} noHoverUnderline>
              <Layout.Flex align="center" gap="2xs">
                <IconV2 name="download" size="sm" />
                {t('views:repos.downloadZip', 'Download ZIP')}
              </Layout.Flex>
            </Link>
          </Layout.Vertical>
        )}
      </Popover.Content>
    </Popover.Root>
  )
}
