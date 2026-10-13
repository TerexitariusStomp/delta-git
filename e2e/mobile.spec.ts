import { test, expect } from '@playwright/test'

/** Non-coders arrive on phones — the idea-first surfaces must work at 375px. */
test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

test('mobile: home composer usable at 375px', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const hero = page.getByText(/what should the agents build/i)
  // The landing chunk is lazy — cold loads over slow edges take a while.
  await expect(hero).toBeVisible({ timeout: 30_000 })

  // No horizontal overflow — the classic mobile breakage.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow, `page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(1)

  await expect(page.getByPlaceholder(/idea/i).first()).toBeVisible()
})

test('mobile: explore page renders without horizontal scroll', async ({ page }) => {
  await page.goto('/explore')
  await page.waitForTimeout(2000)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow, `page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(1)
})
