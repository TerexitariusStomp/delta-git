import { defineConfig } from '@playwright/test'

/**
 * Live-deployment E2E — runs against E2E_BASE_URL (default the public
 * origin). Anonymous crawls: authenticated surfaces are expected to
 * bounce to /signin, which is still a *correct* outcome — what we
 * assert is no 4xx/5xx page loads, no unresolved `:param` URLs, no
 * console errors, and no forever-skeleton renders.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 1,
  workers: 4,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://code.widespread.fyi',
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } }
  ]
})
