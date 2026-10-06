import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'

import { useGetBranchQuery } from '@harnessio/code-service-client'
import { useQuery } from '@tanstack/react-query'
import { Dialog, Layout, Table, Tag, Text, TextInput } from '@harnessio/ui/components'
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
  // File finder (`t`) — fuzzy filter over the repo's flat path list.
  const [showFinder, setShowFinder] = useState(false)
  const [finderQuery, setFinderQuery] = useState('')
  const [finderIndex, setFinderIndex] = useState(0)
  const finderInputRef = useRef<HTMLInputElement | null>(null)

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

  const { data: pathsData } = useQuery({
    queryKey: ['repo-paths', repoRef, gitRefName],
    queryFn: async () => {
      const res = await fetch(
        `/api/v1/repos/${encodeURIComponent(repoRef)}/paths?git_ref=${encodeURIComponent(gitRefName || 'main')}`,
        { credentials: 'same-origin' }
      )
      if (!res.ok) throw new Error('paths failed')
      return res.json() as Promise<{ files: string[]; directories: string[] }>
    },
    enabled: showFinder && !!repoRef,
    staleTime: 60_000
  })

  const finderResults = useMemo(() => {
    const files = pathsData?.files ?? []
    const q = finderQuery.trim().toLowerCase()
    if (!q) return files.slice(0, 50)
    // Subsequence match (GitHub-style fuzzy): every query char in order.
    const matches: string[] = []
    for (const path of files) {
      const lower = path.toLowerCase()
      let pos = 0
      let ok = true
      for (const ch of q) {
        pos = lower.indexOf(ch, pos)
        if (pos < 0) {
          ok = false
          break
        }
        pos++
      }
      if (ok) {
        matches.push(path)
        if (matches.length >= 50) break
      }
    }
    return matches
  }, [pathsData, finderQuery])

  const openFile = (path: string) => {
    setShowFinder(false)
    navigate(`${routes.toRepoFiles({ spaceId, repoId })}/${fullGitRef || ''}/~/${path}`)
  }

  useEffect(() => {
    if (!spaceId || !repoId) return

    const unsub = tinykeys(
      window,
      {
        t: e => {
          if (isEditableTarget(e.target)) return
          e.preventDefault()
          setFinderQuery('')
          setFinderIndex(0)
          setShowFinder(true)
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
      <>
      <Dialog.Root open={showFinder} onOpenChange={setShowFinder}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>File finder</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Layout.Vertical gap="sm">
              <TextInput
                ref={finderInputRef}
                autoFocus
                placeholder="Type to filter files…"
                value={finderQuery}
                onChange={e => {
                  setFinderQuery(e.target.value)
                  setFinderIndex(0)
                }}
                onKeyDown={e => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setFinderIndex(i => Math.min(i + 1, finderResults.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setFinderIndex(i => Math.max(i - 1, 0))
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    const pick = finderResults[Math.max(0, Math.min(finderIndex, finderResults.length - 1))]
                    if (pick) openFile(pick)
                  }
                }}
              />
              <Layout.Vertical gap="2xs" className="max-h-80 overflow-y-auto">
                {finderResults.length === 0 && (
                  <Text variant="body-normal" color="foreground-3">
                    {pathsData ? 'No files match.' : 'Loading…'}
                  </Text>
                )}
                {finderResults.map((path, idx) => (
                  <button
                    key={path}
                    type="button"
                    className={`w-full rounded px-2 py-1 text-left text-sm ${
                      idx === finderIndex ? 'bg-cn-background-3' : 'hover:bg-cn-background-2'
                    }`}
                    onMouseEnter={() => setFinderIndex(idx)}
                    onClick={() => openFile(path)}
                  >
                    <Text variant="body-normal" color="foreground-1" as="span">
                      {path}
                    </Text>
                  </button>
                ))}
              </Layout.Vertical>
            </Layout.Vertical>
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Root>
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
      </>
    )
  }
}
