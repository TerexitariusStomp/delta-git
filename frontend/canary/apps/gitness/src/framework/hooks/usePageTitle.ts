import { useEffect } from 'react'
import { useMatches } from 'react-router-dom'

import { useTranslation } from '@harnessio/ui/context'
import { getBrand } from '@harnessio/ui/utils'

import { usePageTitleContext } from '../context/PageTitleContext'

const usePageTitle = () => {
  const { t } = useTranslation()
  const matches = useMatches()
  const { pageTitle: dynamicTitle } = usePageTitleContext()

  useEffect(() => {
    // The tab title is the deployment's brand on every page rather than
    // per-route breadcrumbs.
    document.title = getBrand().name
  }, [matches, t, dynamicTitle])
}

export default usePageTitle
