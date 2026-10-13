import { test, expect, type Page } from '@playwright/test'

/**
 * Sidebar More/Settings crawl — every destination the left-nav exposes.
 * Mirrors `src/data/navbar-menu-data.ts`; anonymous visitors may be
 * redirected to /signin, which is acceptable — what must never happen
 * is a 4xx/5xx page load, a literal `:param` URL, a console error, or
 * a skeleton that never resolves.
 */
// Mirrors the actual paths from routes.tsx that navbar-menu-data.ts links —
// resolved via each item's routeName → `path` segment.
const NAV_DESTINATIONS = [
  // Work (toRepositories needs a selected space — covered by flows)
  '/arena',
  '/agents',
  // Delivery
  '/gitops',
  '/environments',
  '/connectors',
  '/delegates',
  '/secrets',
  '/variables',
  '/templates',
  '/file-store',
  // Platform
  '/databases',
  '/artifacts',
  '/iac',
  '/feature-flags',
  // DevX
  '/dev-portal',
  '/dev-environments',
  '/dev-insights',
  '/discovery',
  // Reliability
  '/service-reliability',
  '/monitored-services',
  '/incidents',
  '/slo-downtime',
  '/chaos',
  '/certificates',
  // SecOps / FinOps
  '/security-tests',
  '/supply-chain',
  '/cloud-costs',
  '/dashboards',
  // Settings
  '/notifications',
  '/policies',
  '/freeze-windows',
  '/overrides',
  '/external-tickets',
  '/admin/default-settings',
  '/admin/user-groups',
  '/admin/service-accounts',
  '/admin/resource-groups',
  '/admin/roles',
  // Public surfaces
  '/explore',
  '/signin'
]

const attachErrorTraps = (page: Page) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', err => pageErrors.push(String(err)))
  return { consoleErrors, pageErrors }
}

// Noise we can't control: auth-gated resource 401s (expected for anonymous
// crawls), browser/extension chatter, deprecation warnings.
const IGNORABLE = /favicon|net::ERR_|Extension context|deprecated|status of 401|status of 403/i

for (const dest of NAV_DESTINATIONS) {
  test(`nav: ${dest}`, async ({ page, baseURL }) => {
    const { consoleErrors, pageErrors } = attachErrorTraps(page)
    const url = `${baseURL}${dest.replace('/{space}', '')}`
    const res = await page.goto(url, { waitUntil: 'domcontentloaded' })

    expect(res?.status() ?? 0, `GET ${dest} returned ${res?.status()}`).toBeLessThan(400)

    // Allow the SPA to settle — client redirect to /signin is fine.
    await page.waitForTimeout(2500)
    const finalUrl = page.url()
    expect(finalUrl, `unresolved route param in ${finalUrl}`).not.toContain('/:')
    expect(finalUrl, `placeholder space segment in ${finalUrl}`).not.toContain('{space}')

    // The SPA should have mounted *something* — not a blank body.
    const bodyText = await page.locator('body').innerText()
    expect(bodyText.trim().length, `empty render at ${finalUrl}`).toBeGreaterThan(10)

    const badConsole = consoleErrors.filter(e => !IGNORABLE.test(e))
    const badPage = pageErrors.filter(e => !IGNORABLE.test(e))
    expect(badConsole, `console errors: ${badConsole.join(' | ')}`).toEqual([])
    expect(badPage, `page errors: ${badPage.join(' | ')}`).toEqual([])
  })
}

test('home: idea composer renders above the fold', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText(/what should the agents build/i)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByPlaceholder(/idea/i).first()).toBeVisible()
  // Anonymous visitors can draft; submit parks the draft and bounces to sign-in.
  await expect(page.getByRole('button', { name: /sign in to post/i })).toBeVisible()
})

test('agent surfaces: llms.txt + skill.md + openapi serve', async ({ request, baseURL }) => {
  for (const path of ['/llms.txt', '/skill.md', '/api/openapi.json', '/.well-known/delta-node']) {
    const res = await request.get(`${baseURL}${path}`)
    expect(res.status(), `${path} → ${res.status()}`).toBe(200)
  }
})
