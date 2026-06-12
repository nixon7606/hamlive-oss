# Unified Page Padding & Dark-Background Contrast — Design

**Date:** 2026-06-11
**Status:** Approved (design)
**Branch:** `design/unified-padding-dark-contrast`

## Goal

Make the design consistent across all pages:

1. **Same padding on every page** — identical vertical (top/bottom) padding and identical
   horizontal gutter from the screen edge, on every page.
2. **Everything viewable on the black background** — no low-contrast / dark-on-dark text or
   controls anywhere; readable on the dark theme.

## Current state (problems)

The app already has a design system in `client/dist/public/css/local.css` (classes `.app-page`,
`.static-page`, `.app-card`, etc.) and CSS color variables in `client/dist/public/css/main.css`
(`--hl-light`, `--hl-tertiary`, …). The infrastructure exists but is applied inconsistently.

### Padding / horizontal alignment

Two container patterns are in use across the 16 page views:

| Pattern | Pages | Width | Vertical padding |
|---|---|---|---|
| `container-fluid app-page` | dashboard, admin, liveNet, login, myAccount, myNets, favorites, netNotRunning | ~95% (near screen edges) | 1.5rem top / 2rem bottom |
| `container static-page` | intro, guide, privacyPolicy, termsOfUse, cookiePolicy, dataPrivacy, oAuth2Homepage, 404 | Bootstrap centered (narrow) | 2rem top / 3rem bottom |

Result: on wide screens, legal/info pages are indented far from the left edge while app pages run
near the edge, and the two groups use different top/bottom padding.

### Contrast on the black background

- **Footer** (`partials/footer.ejs`): copyright uses `text-tertiary` = `--hl-tertiary` (`#a376c3`,
  purple) on black — barely legible.
- **Navbar links** (`partials/navbar.ejs`): use `--hl-navbar-dark-color` =
  `rgba(220, 131, 53, 0.55)` — dim, washed-out orange.
- **Muted/secondary text, placeholders, inactive tabs**: lean on the same low-contrast purple
  (`#a376c3`).

## Design

### Source of truth

CSS and EJS both live directly under `dist/` and are tracked as source (no `src/` to compile):

- Spacing system: `client/dist/public/css/local.css`
- Color variables: `client/dist/public/css/main.css`
- Layout markup: `server/dist/views/*.ejs` and `server/dist/views/partials/*.ejs`

All changes are centralized in the CSS design system wherever possible; per-page EJS edits only
where a page hardcodes its own spacing/color.

### A. Unified spacing

- Standardize a single page-padding contract used by **all** content pages: the same
  `padding-top` / `padding-bottom` and the same horizontal gutter from the screen edge.
- `.app-page` and `.static-page` are reconciled so their padding is identical. `.static-page`
  retains **only** a narrower `max-width` (a centered reading column for long-form legal/guide
  text) — it no longer differs in padding.
- The horizontal gutter is made consistent so a page's content begins the same distance from the
  screen edge regardless of which layout it uses.

### B. Dark-background contrast pass

- Raise contrast of every offending element to clear **WCAG AA** (4.5:1 for normal text, 3:1 for
  large text / UI affordances) on the black background:
  - Footer copyright → readable muted tone (light at reduced opacity / lighter gray), not purple.
  - Navbar links → full-opacity, readable color in all states (default/hover/active).
  - Muted/secondary text, placeholders, inactive tab labels → bumped to clear the threshold.
- Done via the shared CSS variables / design-system classes so the fix holds across all pages;
  per-page overrides only where colors are hardcoded inline.

### C. Verification

After implementation, re-screenshot each page (public pages headlessly via Chrome; logged-in pages
after signing in with the console magic-link) and confirm: identical gutters/padding, and no
low-contrast text remains. No success claim before screenshots confirm it.

## Decisions (locked)

- **Reading column kept** for legal/info pages (narrower `max-width`), with padding identical to
  app pages — *not* forced full-width.
- **WCAG AA** is the contrast bar.

## Out of scope

- No restructuring of page content, navigation, or components beyond spacing/contrast.
- No unrelated refactoring or visual redesign (colors palette, fonts) beyond contrast fixes.
