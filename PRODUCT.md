# Impeccable Design Context

## Design Context

### Users

Solo developers (and occasionally small teams) who self-host Git repositories on Cloudflare Workers. These are infrastructure-minded people who chose to run their own git forge on edge compute rather than use a hosted service. They interact primarily via `git clone`/`git push` in the terminal; the web UI is for browsing trees, blobs, commits, and managing auth. They value that this thing actually works — 80,000+ objects on a Workers runtime is the flex, not the marketing page.

### Brand Personality

**Precise, opinionated, utilitarian.**

This is a tool that does one thing well and knows it. The interface should feel like well-machined infrastructure: reliable, solid, no wasted motion. But not cold — there's a quiet confidence and a subtle edge of personality underneath the utility. The feeling is closer to a well-built CLI tool that happens to have a web face than it is to a SaaS product trying to convert you.

**Emotional targets:**

- "This is solid code" — trustworthy, reliable, engineered
- "This gets out of my way" — minimal, focused, no noise
- "This has taste" — opinionated choices, not default everything

### Aesthetic Direction

**Tone:** Sharp minimalism with deliberate warmth. The intersection of jam.dev's confident knife-edge precision and charm.land's personality-injected developer tools. Not sterile, not playful — _precise with character_.

**References:**

- **jam.dev** — The sharp knife. Clean whitespace, modular layouts, confident typography, developer-focused without being enterprise. What works: the generous spacing, the way product context is shown rather than described, the confidence in leaving things simple.
- **charm.land** — The sugar high. Personality through naming, illustration, and tone rather than through visual noise. What works: the proof that developer tools can have warmth and identity without becoming whimsical or losing credibility.

**Anti-references:**

- Not another SaaS dashboard (no onboarding funnels, no pricing tiers, no "get started free" hero)
- Not Vercel's marketing gloss (style over substance)
- Not generic admin templates (card grids with icons and shadows)

**Update (GitHub-faithful pivot):** the UI now deliberately clones GitHub's chrome — its information architecture is the most familiar repo-browsing UX there is. We adopt GitHub's own open-source design system (Primer: `@primer/react`, `@primer/primitives`, `@primer/octicons-react`, all MIT) rather than eyeballing it. GitHub's _density_ remains the anti-reference, not its vocabulary: no Star/Watch/Fork counts that don't exist, no upsell surfaces, no dashboard chrome beyond what the data supports.

**Theme:** Dark-primary with light mode toggle. Dark mode is the default and the design target — developers browsing repos late in the terminal-adjacent context. Light mode is a courtesy, not the hero.

**Color:** Primer semantic tokens (`--fgColor-*`, `--bgColor-*`, `--borderColor-*` from `@primer/primitives`) drive both themes via `data-color-mode`; our Tailwind tokens alias onto them. GitHub blue (`#0969da` light / `#4493f8` dark links, `#1f883d`/`#238636` primary buttons).

**Typography:** GitHub's system stack for UI chrome (matching the clone), JetBrains Mono for code, IBM Plex Serif retained only where delta-git's own voice shows through (homepage hero).

**Constraints:**

- Part of devbin.tools ecosystem — shared shell conventions per frontend-spec.md
- Vendored Gitness SPA (React, `/` mount) reskinned toward GitHub via `--cn-*` token overrides; only auth/404/error remain SSR islands
- Tailwind v4 CSS-native config, no CSS-in-JS
- Performance-sensitive: no heavy background effects, respect `prefers-reduced-motion`
- Accessibility: lifted canvas for astigmatism, font-weight 450, WCAG AA minimum

### Design Principles

1. **Utility over decoration.** Every visual element must earn its place by improving comprehension, navigation, or feedback. If removing something changes nothing, remove it.

2. **Precision is the personality.** The brand character comes through in _how well things are done_, not through added flair. Tight spacing, considered typography, and consistent details are the design language — not illustrations, gradients, or effects.

3. **Show the infrastructure.** This product's identity is that it runs Git on edge compute. Let the technical context show through: monospace where it matters, terminal-flavored moments, the code as the hero rather than marketing copy about the code.

4. **Confident restraint.** Make strong choices and leave space around them. One accent color used with intent beats five used for variety. Large type with nothing beside it beats a dense layout. Silence is a design decision.

5. **Dark mode is home.** Design for the dark canvas first. The zinc surfaces, the indigo accent, the serif display weight — these are calibrated for dark backgrounds. Light mode follows, adapted thoughtfully, but dark is where the design lives.
