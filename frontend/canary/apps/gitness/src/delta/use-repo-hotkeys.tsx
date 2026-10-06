import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'

import { useGetBranchQuery } from '@harnessio/code-service-client'
import { Dialog, Table, Tag, Text } from '@harnessio/ui/components'
import { tinykeys } from 'tinykeys'

import { useRoutes } from '../framework/context/NavigationContext'
import { useGetRepoRef } from '../framework/hooks/useGetRepoPath'
import { useGitRef } from '../hooks/useGitRef'
import { PathParams } from '../RouteDefinitions'

interface ShortcutSpec {
  keys: string
  action: string
}

const SHORTCUTS: ShortcutSpec[] = [
  { keys: 't', action: 'File finder' },
  { keys: 'y', action: 'Permalink — pin the current file view to its commit SHA' },
  { keys: '.', action: 'Open the web editor on this file' },
  { keys: 'g c', action: 'Go to Code' },
  { keys: 'g i', action: 'Go to Issues' },
  { keys: 'g p', action: 'Go to Pull requests' },
  { keys: 'g a', action: 'Go to Actions' },
  { keys: 'g b', action: 'Go to Branches' },
  { keys: 'g n', action: 'Go to Merge intents' },
  { keys: '?', action: 'Show this cheatsheet' }
]

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * Repo-scoped keyboard shortcuts, GitHub-flavoured (`t`/`y`/`.`/`g *`/`?`).
 * Mounted once from RepoLayout so it covers every repo sub-surface.
 */
export function useRepoHotkeys() {
  const navigate = useNavigate()
  const location = useLocation()
  const routes = useRoutes()
  const { spaceId = '', repoId = '' } = useParams<PathParams>()
  const repoRef = useGetRepoRef()
  const { fullGitRef, gitRefName, fullResourcePath } = useGitRef()
  const [showCheatsheet, setShowCheatsheet] = useState(false)

  // Latest commit sha for `y` permalink — resolved on demand via the branch.
  const { data: { body: branchData } = {} } = useGetBranchQuery(
    {
      repo_ref: repoRef,
      branch_name: gitRefName || '',
      queryParams: {}
    },
    { enabled: !!gitRefName }
  )
  const headSha = branchData?.commit?.sha

  useEffect(() => {
    if (!spaceId || !repoId) return

    const unsub = tinykeys(
      window,
      {
        t: e => {
          if (isEditableTarget(e.target)) return
          e.preventDefault()
          const input = document.querySelector<HTMLInputElement>('[data-dg-file-search] input')
          if (input) {
            input.focus()
          } else {
            navigate(`${routes.toRepoFiles({ spaceId, repoId })}/${fullGitRef || ''}`)
          }
        },
        y: e => {
          if (isEditableTarget(e.target)) return
          // Permalink: swap the mutable ref segment for the pinned commit sha.
          const sha = headSha
          if (!sha || !location.pathname.includes('/files/')) return
          e.preventDefault()
          const filesIdx = location.pathname.indexOf('/files/')
          const base = location.pathname.slice(0, filesIdx + '/files/'.length)
          const rest = location.pathname.slice(filesIdx + '/files/'.length)
          const tildeIdx = rest.indexOf('/~/')
          const pathPart = tildeIdx >= 0 ? rest.slice(tildeIdx) : ''
          navigate(`${base}${sha}${pathPart}`)
        },
        '.': e => {
          if (isEditableTarget(e.target)) return
          if (!location.pathname.includes('/files/') || !fullResourcePath) return
          e.preventDefault()
          navigate(
            `${routes.toRepoFiles({ spaceId, repoId })}/edit/${fullGitRef || ''}/~/${fullResourcePath}`
          )
        },
        'g c': e => {
          if (isEditableTarget(e.target)) return
          e.preventDefault()
          navigate(routes.toRepoSummary({ spaceId, repoId }))
        },
        'g i': e => {
          if (isEditableTarget(e.target)) return
          e.preventDefault()
          navigate(`/${spaceId}/repos/${repoId}/issues`)
        },
        'g p': e => {
          if (isEditableTarget(e.target)) return
          e.preventDefault()
          navigate(routes.toRepoPullRequests({ spaceId, repoId }))
        },
        'g a': e => {
          if (isEditableTarget(e.target)) return
          e.preventDefault()
          navigate(routes.toRepoPipelines({ spaceId, repoId }))
        },
        'g b': e => {
          if (isEditableTarget(e.target)) return
          e.preventDefault()
          navigate(routes.toRepoBranches({ spaceId, repoId }))
        },
        'g n': e => {
          if (isEditableTarget(e.target)) return
          e.preventDefault()
          navigate(routes.toRepoIntents({ spaceId, repoId }))
        },
        'Shift+?': e => {
          if (isEditableTarget(e.target)) return
          e.preventDefault()
          setShowCheatsheet(v => !v)
        },
        // Some layouts emit `?` without a Shift modifier flag on the event.
        '?': e => {
          if (isEditableTarget(e.target)) return
          e.preventDefault()
          setShowCheatsheet(v => !v)
        }
      },
      { event: 'keydown' }
    )
    return unsub
  }, [
    navigate,
    location.pathname,
    routes,
    spaceId,
    repoId,
    fullGitRef,
    gitRefName,
    fullResourcePath,
    headSha
  ])

  return {
    cheatsheet: (
      <Dialog.Root open={showCheatsheet} onOpenChange={setShowCheatsheet}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Keyboard shortcuts</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Table.Root variant="default">
              <Table.Body>
                {SHORTCUTS.map(s => (
                  <Table.Row key={s.keys}>
                    <Table.Cell className="w-32">
                      <Tag variant="outline" size="sm" theme="gray" label={s.keys} value="" />
                    </Table.Cell>
                    <Table.Cell>
                      <Text variant="body-normal" color="foreground-1">
                        {s.action}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Root>
    )
  }
}
