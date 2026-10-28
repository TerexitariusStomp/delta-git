import { FC, useEffect, useMemo } from 'react'
import { Link, Outlet, useParams } from 'react-router-dom'

import { NavbarItemType, Toaster, useSidebar } from '@harnessio/ui/components'
import { useTranslation } from '@harnessio/ui/context'
import { getBrand } from '@harnessio/ui/utils'
import { MainContentLayout } from '@harnessio/views'

import { getNavbarMenuData } from '../../data/navbar-menu-data'
import { getPinnedMenuItemsData } from '../../data/pinned-items'
import { useAppContext } from '../../framework/context/AppContext'
import { useRoutes } from '../../framework/context/NavigationContext'
import { useGetSpaceURLParam } from '../../framework/hooks/useGetSpaceParam'
import { useLocationChange } from '../../framework/hooks/useLocationChange'
import { useSelectedSpaceId } from '../../framework/hooks/useSelectedSpaceId'
import useSpaceSSEWithPubSub from '../../framework/hooks/useSpaceSSEWithPubSub'
import { PathParams } from '../../RouteDefinitions'
import { Breadcrumbs } from '../breadcrumbs/breadcrumbs'
import { useGetBreadcrumbs } from '../breadcrumbs/useGetBreadcrumbs'
import { useNav } from '../stores/recent-pinned-nav-links.store'
import { AppSideBar } from './side-bar'

interface NavLinkStorageInterface {
  state: {
    recent: NavbarItemType[]
    pinned: NavbarItemType[]
  }
}

export const AppShell: FC = () => {
  const routes = useRoutes()
  const { spaceId } = useParams<PathParams>()
  const spaceURL = useGetSpaceURLParam() ?? ''
  const { pinnedMenu, setRecent, setNavLinks } = useNav()
  const { t } = useTranslation()
  const selectedSpaceId = useSelectedSpaceId(spaceId)
  const spaceIdPathParam = spaceId ?? selectedSpaceId ?? ''
  const { currentUser } = useAppContext()

  // Anonymous visitors get the idea-first landing without the app chrome —
  // the sidebar/menu machinery is meaningless (and empty) before sign-in.
  const anonymous = !currentUser?.uid

  const { breadcrumbs } = useGetBreadcrumbs()

  const pinnedMenuItemsData = useMemo(
    () => getPinnedMenuItemsData({ t, routes, spaceId: spaceIdPathParam }),
    [t, routes, spaceIdPathParam]
  )

  useLocationChange({ onRouteChange: setRecent, getNavbarMenuData })

  useEffect(() => {
    const linksFromStorage = localStorage.getItem('nav-items')
    let parsedLinksFromStorage: NavLinkStorageInterface | undefined

    if (linksFromStorage) {
      parsedLinksFromStorage = JSON.parse(linksFromStorage)
    }

    /**
     * Logic for setting initial pinned links
     *
     * setting initial pinned link only if no pinned links are stored in local storage.
     * Pinned links cannot be empty as we will have some links permanently.
     */
    if (parsedLinksFromStorage && !parsedLinksFromStorage?.state?.pinned?.length) {
      const pinnedItems = pinnedMenu.filter(
        item => !pinnedMenuItemsData.some(staticPinned => staticPinned.id === item.id)
      )
      setNavLinks({ pinnedMenu: [...pinnedMenuItemsData, ...pinnedItems] })
    }
  }, [spaceIdPathParam])

  useSpaceSSEWithPubSub({
    space: spaceURL
  })

  return (
    <>
      {anonymous ? (
        <div className="flex min-h-svh min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-cn-2 px-cn-md py-cn-sm">
            <Link to="/" className="flex items-center gap-cn-xs" aria-label={`${getBrand().name} home`}>
              <img src={getBrand().logo} alt="" className="h-6 w-6 rounded-cn-1" />
              <span className="text-cn-1 font-semibold">{getBrand().name}</span>
            </Link>
            <nav className="flex items-center gap-cn-md text-sm">
              <Link to="/explore" className="text-cn-brand">
                Explore
              </Link>
              <Link to="/signin" className="text-cn-brand">
                Sign in
              </Link>
            </nav>
          </header>
          <main className="flex-1">
            <Outlet />
          </main>
        </div>
      ) : (
        <AppSideBar>
          <Breadcrumbs breadcrumbs={breadcrumbs} withMobileSidebarToggle />
          <MainContentLayout useSidebar={useSidebar} withBreadcrumbs={breadcrumbs.length > 0}>
            <Outlet />
          </MainContentLayout>
        </AppSideBar>
      )}
      <Toaster />
    </>
  )
}
