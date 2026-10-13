import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

// delta-git: dynamic import — the static import pulled the whole shiki
// vendor chunk into the entry bundle's preload graph. The highlighter
// only resolves inside the effect anyway.
import type { getDiffViewHighlighter as getDiffViewHighlighterType } from '@git-diff-view/shiki'

// Re-export from UI types for backward compatibility
export type { HighlighterType } from '@harnessio/ui/types'

import type { HighlighterType } from '@harnessio/ui/types'

export const useDiffHighlighter = ({ setLoading }: { setLoading: Dispatch<SetStateAction<boolean>> }) => {
  const [highlighter, setHighlighter] = useState<HighlighterType>()

  useEffect(() => {
    const init = async () => {
      setLoading(true)
      try {
        const getDiffViewHighlighter: typeof getDiffViewHighlighterType = (await import('@git-diff-view/shiki'))
          .getDiffViewHighlighter
        const shikiHighlighter = await getDiffViewHighlighter()
        if (shikiHighlighter) {
          setHighlighter(shikiHighlighter as HighlighterType)
        }
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [setLoading])

  return highlighter
}
