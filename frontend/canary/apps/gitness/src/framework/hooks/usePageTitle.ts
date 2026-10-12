import { useEffect } from 'react'
import { useMatches } from 'react-router-dom'

import { useTranslation } from '@harnessio/ui/context'

import { usePageTitleContext } from '../context/PageTitleContext'

const usePageTitle = () => {
  const { t } = useTranslation()
  const matches = useMatches()
  const { pageTitle: dynamicTitle } = usePageTitleContext()

  useEffect(() => {
    // Product brand is Widespread — the tab title is the brand on every
    // page rather than per-route breadcrumbs.
    document.title = 'Widespread'
  }, [matches, t, dynamicTitle])
}

export default usePageTitle
