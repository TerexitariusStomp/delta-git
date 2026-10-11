import { useMemo } from 'react'

import { DiffFile, DiffModeEnum, DiffView } from '@git-diff-view/react'
import * as Diff2Html from 'diff2html'

import { Text } from '@harnessio/ui/components'

import '@git-diff-view/react/styles/diff-view-pure.css'

import { useThemeStore } from '../../framework/context/ThemeContext'
import { parseSpecificDiff } from '../pull-request/diff-utils'
import { DIFF2HTML_CONFIG, normalizeGitFilePath } from '../pull-request/pull-request-utils'
import { useArenaEntryDiff } from './delta-api'

interface ArenaEntryDiffProps {
  spaceId: string
  repoId: string
  matchId: string
  entryId: string
}

interface DiffSection {
  fileName: string
  raw: string
}

/** One file's unified diff rendered through the shared git-diff-view engine —
 *  the same renderer the PR changes view uses, minus the review chrome. */
function EntryDiffFile({ fileName, raw }: DiffSection) {
  const isLightTheme = useThemeStore(state => state.isLightTheme)
  const diffFile = useMemo(() => {
    const instance = DiffFile.createInstance({
      newFile: { fileName, content: '' },
      hunks: [raw]
    })
    try {
      instance.init()
      instance.buildUnifiedDiffLines()
      return instance
    } catch {
      return undefined
    }
  }, [fileName, raw])

  return (
    <div className="border-cn-2 rounded-cn-3 mb-cn-sm overflow-hidden border">
      <div className="border-cn-2 bg-cn-2 text-cn-1 text-cn-size-2 px-cn-md py-cn-xs border-b font-medium">
        {fileName}
      </div>
      {diffFile ? (
        <DiffView
          diffFile={diffFile}
          diffViewMode={DiffModeEnum.Unified}
          diffViewWrap
          diffViewTheme={isLightTheme ? 'light' : 'dark'}
        />
      ) : (
        <pre className="p-cn-md overflow-x-auto text-xs">{raw}</pre>
      )}
    </div>
  )
}

/**
 * Per-candidate diff panel for an arena match entry — the judging exhibit.
 * The server seals entries while the match is building, so this is only
 * mounted once the match is judging or resolved.
 */
export function ArenaEntryDiff({ spaceId, repoId, matchId, entryId }: ArenaEntryDiffProps) {
  const { data: raw, isLoading, error } = useArenaEntryDiff(spaceId, repoId, matchId, entryId)

  const sections = useMemo<DiffSection[]>(() => {
    if (!raw) return []
    return Diff2Html.parse(raw, DIFF2HTML_CONFIG)
      .map(diff => ({
        fileName: normalizeGitFilePath(diff.isDeleted ? diff.oldName : diff.newName),
        raw:
          parseSpecificDiff(raw, diff.oldName, diff.newName, diff.checksumBefore, diff.checksumAfter) ??
          ''
      }))
      .filter(section => section.raw)
  }, [raw])

  if (isLoading) return <Text color="foreground-3">Loading diff…</Text>
  if (error) return <Text color="foreground-3">Diff unavailable: {String(error)}</Text>
  if (!sections.length) return <Text color="foreground-3">No changes in this entry.</Text>
  return (
    <div className="mt-cn-sm">
      {sections.map(section => (
        <EntryDiffFile key={section.fileName} {...section} />
      ))}
    </div>
  )
}
