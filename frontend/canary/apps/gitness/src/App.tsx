import { Suspense } from 'react'
import { I18nextProvider } from 'react-i18next'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'

import { QueryClientProvider } from '@tanstack/react-query'

import { CodeServiceAPIClient } from '@harnessio/code-service-client'
import { TooltipProvider } from '@harnessio/ui/components'
import { DialogProvider, TranslationProvider } from '@harnessio/ui/context'

import { ExitConfirmProvider } from './framework/context/ExitConfirmContext'
import { defaultContext, MFEContext } from './framework/context/MFEContext'
import { NavigationProvider } from './framework/context/NavigationContext'
import { ThemeProvider } from './framework/context/ThemeContext'
import { queryClient } from './framework/queryClient'
import i18n from './i18n/i18n'
import { useTranslationStore } from './i18n/stores/i18n-store'
import { routes } from './routes'

const BASE_URL_PREFIX = `${window.apiUrl || ''}/api/v1`

// Routes an anonymous visitor may stay on despite 401s from authed APIs.
const ANON_OK_PATHS = new Set(['/', '/signin'])

export default function App() {
  new CodeServiceAPIClient({
    urlInterceptor: (url: string) => `${BASE_URL_PREFIX}${url}`,
    responseInterceptor: (response: Response) => {
      switch (response.status) {
        case 401:
          // Public routes render anonymous-first (idea timeline, sign-in
          // itself) — a 401 there is a data gate, not a session bounce.
          if (!ANON_OK_PATHS.has(window.location.pathname)) window.location.href = '/signin'
          break
      }
      return response
    }
  })

  // Router Configuration
  const router = createBrowserRouter(routes, { basename: '/' })

  const { t } = useTranslationStore()

  return (
    <MFEContext.Provider value={defaultContext}>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider defaultTheme="dark-std-std">
          <TranslationProvider t={t}>
            <QueryClientProvider client={queryClient}>
              <TooltipProvider>
                <DialogProvider>
                  <ExitConfirmProvider>
                    <NavigationProvider routes={routes}>
                      {/* Single Suspense boundary for lazily-chunked pages (routes.tsx). */}
                      <Suspense fallback={null}>
                        <RouterProvider router={router} />
                      </Suspense>
                    </NavigationProvider>
                  </ExitConfirmProvider>
                </DialogProvider>
              </TooltipProvider>
            </QueryClientProvider>
          </TranslationProvider>
        </ThemeProvider>
      </I18nextProvider>
    </MFEContext.Provider>
  )
}
