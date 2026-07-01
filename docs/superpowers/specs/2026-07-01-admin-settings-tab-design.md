# Admin "Settings" Tab + Recent Sends Default Range

**Date:** 2026-07-01
**Status:** Approved (user-confirmed design, built inline)
**Target:** `feat/inhouse-email` → staging

## Problem

The admin Email tab mixes configuration (Email Settings incl. Delivery Tracking, Email
Templates) with reporting (Email Delivery Lookup, Recent Sends). Config belongs in its
own tab. Separately, Recent Sends renders empty until a preset/Load click.

## Design

1. **New "Settings" tab** (`settings-tab` / `#settings-panel`, gear icon, after Audit)
   in `server/dist/views/admin.ejs`. The **Email Settings** card
   (`#email-settings-panel`, includes provider radios, SMTP fields, Delivery Tracking
   sub-card, send-test) and the **Email Templates** card move into it **verbatim** —
   same ids and markup, so all existing JS (`emailSettings.ts` init on DOMContentLoaded,
   TinyMCE, preview) keeps working with no client changes. EJS-only.
2. **Email tab keeps** Delivery Lookup + Recent Sends; the Users-table
   "view email history" deep-link (targets `email-tab`) is unaffected.
3. **Recent Sends auto-loads the last 24 h** the first time the Email tab is shown
   (`shown.bs.tab` once-listener on `#email-tab` → `loadRecentEmails(
   recentRangeFromControls(1))` in `client/src/.../admin/main.ts`). Loading on
   tab-open (not page-open) avoids a wasted API call; the deep-link jump also
   triggers it.
4. PATCHES.md: amend the in-house email entry (Settings tab location; 24 h default).

## Constraints

- EJS edited directly in dist (fork rule). Client rebuilt ONLY via
  `npx tsc -p client/tsconfig.json`; commit the regenerated `admin/main.js` outputs.
- Deploy note: `main.js` changes → Cloudflare cache purge + hard refresh required.
- No endpoint or server-logic changes. No new tests mandated (DOM wiring; the client
  test project has no DOM environment) — verified on staging.
