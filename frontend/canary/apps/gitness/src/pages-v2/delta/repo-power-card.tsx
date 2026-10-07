import { useEffect, useRef, useState } from 'react'

import { Button, Text } from '@harnessio/ui/components'

import { useRepoPool } from './delta-api'

/**
 * "Power this project" — the repo's volunteer-compute enlistment point.
 *
 * The card itself stays thin: it renders the supporter count and, on click,
 * lazy-injects `/power.js` (the vendored visitor-node consent script) with
 * the repo's pool slug + coordinator WebSocket in data-attrs. The script
 * owns the actual consent card, WebSocket protocol, and job execution — we
 * deliberately don't reimplement that surface in React.
 */
export function RepoPowerCard({ spaceId, repoId }: { spaceId: string; repoId: string }) {
  const { data } = useRepoPool(spaceId, repoId)
  const [injected, setInjected] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)

  // If the user already consented on a previous visit the script auto-resumes
  // — inject it on mount when localStorage says so (same key the script uses).
  useEffect(() => {
    if (!data?.enabled || !data.project) return
    if (localStorage.getItem(`chimera-consent:${data.project}`) === '1') inject()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.enabled, data?.project])

  if (!data?.enabled || !data.project || !data.coordinatorWs) return null

  function inject() {
    if (injected || !data?.project || !data.coordinatorWs) return
    const s = document.createElement('script')
    s.src = data.scriptUrl
    s.dataset.project = data.project
    s.dataset.coordinator = data.coordinatorWs
    s.dataset.label = `Power ${repoId}`
    anchor.current?.appendChild(s)
    setInjected(true)
  }

  return (
    <div
      ref={anchor}
      className="mx-auto mb-cn-md flex max-w-[1200px] items-center justify-between gap-cn-md rounded-cn-2 border border-cn-2 bg-cn-1 px-cn-md py-cn-sm"
    >
      <Text color="foreground-3" className="text-cn-size-1">
        ⚡ {data.supporters} supporter{data.supporters === 1 ? '' : 's'} power this project&apos;s
        agent work — merges, indexing, and research run on volunteered browser compute.
      </Text>
      {!injected && (
        <Button size="sm" variant="outline" onClick={inject}>
          Power this project
        </Button>
      )}
    </div>
  )
}
