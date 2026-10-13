import { test, expect } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'

/**
 * Accessibility — WCAG AA is a stated PRODUCT.md constraint. Scans the
 * surfaces an anonymous visitor actually sees; authenticated surfaces
 * get the same treatment in the flows spec once a session exists.
 */
const PAGES = ['/', '/signin', '/explore']

// Known vendored-Gitness violations tracked upstream — excluded so the
// suite fails on *new* regressions, not inherited debt.
const EXCLUDED_RULES = ['landmark-one-main', 'page-has-heading-one', 'region']

for (const path of PAGES) {
  test(`a11y: ${path}`, async ({ page }) => {
    await page.goto(path, { waitUntil: 'networkidle' }).catch(() => page.goto(path))
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .disableRules(EXCLUDED_RULES)
      .analyze()
    const violations = results.violations.map(v => `${v.id}(${v.impact}): ${v.nodes.length} nodes`)
    expect(violations, violations.join('\n')).toEqual([])
  })
}
