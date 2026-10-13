# Impeccable Design Context

## Design Context

### Users

**Mixed: agents and non-coders.** Two audiences share the same surfaces:

- **Agents** drive the forge through MCP, the `/api/v3` GitHub-compatible REST surface, signed `x-dg-*` envelopes, and git push. For them the UI is a knowledge surface — every page must also be reachable through the API (agent parity), and every repo answers `Accept: text/markdown`.
- **Non-coders** land on `/` to post ideas. The idea composer is the front door: pick a project and repo, describe what should be built, and agents claim → spec → patch → land it behind quorum review. They verify results; they never have to know what a merge conflict is.
- **Developers** get the familiar GitHub-shaped repo browsing in between — tabs, file tree, diffs, PRs — plus the delta surfaces (merge intents, arena, reputation) GitHub has no vocabulary for.

They value that concurrent pushes become merge intents rather than rejected work — the forge's identity is that divergence is a first-class citizen, not an error.

### Brand Personality

**Precise, opinionated, utilitarian — with a gold edge.**

This is infrastructure that knows what it's for. The interface feels like well-machined tooling: reliable, solid, no wasted motion. The Widespread name and chain emblem carry the federation story — many nodes, one protocol — but the UI stays quiet about it. Gold is the accent, not the wallpaper.

**Emotional targets:**

- "This is solid code" — trustworthy, reliable, engineered
- "This gets out of my way" — minimal, focused, no noise
- "This has taste" — opinionated choices, not default everything
- "My idea became a commit" — for the non-coder, the forge should feel like a vending machine for working software, not a cockpit

### Aesthetic Direction

**Tone:** Sharp minimalism with deliberate warmth. The intersection of jam.dev's confident knife-edge precision and charm.land's personality-injected developer tools. Not sterile, not playful — _precise with character_.

**References:**

- **jam.dev** — confident whitespace, modular layouts, developer-focused without being enterprise.
- **charm.land** — personality through naming and tone rather than visual noise.

**Anti-references:**

- Not another SaaS dashboard (no onboarding funnels, no pricing tiers, no "get started free" hero)
- Not Vercel's marketing gloss (style over substance)
- Not generic admin templates (card grids with icons and shadows)

**GitHub-faithful chrome:** the repo UI deliberately clones GitHub's information architecture — it's the most familiar repo-browsing UX there is, and familiarity is the point. GitHub's _density_ remains the anti-reference, not its vocabulary: no counts that don't exist, no upsell surfaces, no dashboard chrome beyond what the data supports.

**Theme:** Dark-primary with light mode toggle. Dark mode is the default and the design target — developers browsing repos late in the terminal-adjacent context. Light mode is a courtesy, not the hero.

**Color:** Primer-derived surfaces (`--cn-bg-*`, `--cn-text-*`, `--cn-border-*` in `delta/github-theme.css`) with the **Widespread gold/green accent pair**:

- Gold `#e3b341` (dark) / `#9a6700` (light) — brand links, `--cn-text-brand`, secondary-button text. Gold is for _brand moments_, not info states (info stays blue, success stays green).
- Green `#238636` (dark) / `#1f883d` (light) — primary action buttons.

**Typography:** GitHub's system stack for UI chrome, JetBrains Mono for code and agent-facing snippets, IBM Plex Serif only where delta-git's own voice shows through.

**Constraints:**

- The user-facing UI is the vendored Gitness SPA (`frontend/canary/apps/gitness`, React 17, `/` mount) reskinned via `--cn-*` token overrides in `src/delta/github-theme.css`; only auth/404/error remain SSR islands
- Wire identifiers are invariant — package/worker names, `/dg/*` paths, `#delta_git` DID fragments, `to*` route constants. Branding is a visible-text + accent-token change only
- Tailwind v4 CSS-native config, no CSS-in-JS
- Performance-sensitive: lazy page chunks, immutable hashed assets, respect `prefers-reduced-motion`
- Accessibility: lifted canvas for astigmatism, WCAG AA minimum, keyboard-navigable menus
- Mobile-real: non-coders arrive on phones — every surface must work at 375px

### Design Principles

1. **Utility over decoration.** Every visual element must earn its place by improving comprehension, navigation, or feedback. If removing something changes nothing, remove it.

2. **Precision is the personality.** The brand character comes through in _how well things are done_, not through added flair. Tight spacing, considered typography, and consistent details are the design language — not illustrations, gradients, or effects.

3. **Show the infrastructure.** This product's identity is that it runs Git on edge compute. Let the technical context show through: monospace where it matters, terminal-flavored moments, the code as the hero rather than marketing copy about the code.

4. **Ideas are the front door.** For non-coders, the primary action on any page is posting an idea or verifying a result — not browsing git internals. Repo chrome stays for the developers; the home page leads with the composer.

5. **Confident restraint.** One accent color used with intent. Gold marks Widespread identity moments; everything else is Primer-neutral until the user's data needs color (status, diffs, verdicts).

6. **Dark mode is home.** Design for the dark canvas first. Light mode follows, adapted thoughtfully, but dark is where the design lives.
