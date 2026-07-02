# Admin QoL Pass: Nets Schedule Calendar + Tab Improvements

**Date:** 2026-07-01
**Status:** Approved design — ready for implementation plan
**Target:** `staging` branch → staging box (LXC 204)

## Goal

Quality-of-life improvements across the four admin data tabs, headlined by a weekly
schedule view on the Nets tab so an admin can see at a glance when nets are planned.

## Scope decision (recorded deliberately)

The repo's architecture direction mandates porting legacy screens to the `liveNet`
ReactiveStore/widget pattern when touched. The admin page (`byView/admin/main.ts`) is
legacy-style, and this pass **consciously extends the existing pattern instead of
porting** — a port would triple the project without adding any of the requested
features. This continues the precedent set by the Email Settings work and must be
noted in `PATCHES.md`.

## Existing data (verified — drives what needs server changes)

- `GET /api/admin/nets` (`adminController.listNets`) already returns per net:
  `schedule` (dayOfWeek/hour/minute/timezone/notifyBeforeMinutes/notifyBeforeEnabled/
  enabled), `hasLiveNet`, `liveNetStatus`, `liveNetStartedAt`. **Calendar + LIVE badge
  + readable schedule need no server changes.** The nets list is not paginated.
- `GET /api/admin/users` (`listUsers`) already selects `lastLogin`, `lastAuthVia`,
  `locked`, `lockedUntil`, `flaggedForDeletion`, `newAccount`, `superUser`. The list
  IS server-paginated, so the status filter must be a server-side query param.
- `GET /api/admin/audit` (`listAudit`) filters `actor` (regex) + `action` (exact
  string); CSV branch shares the filter object. No date filtering, no way to
  enumerate actions.
- `GET /api/admin/email/recent` returns rows with `status` (the UI already colors
  them via `EVENT_COLORS`). Client-side filtering suffices.

## Features

### 1. Nets tab — schedule views (Table / Week / Agenda toggle)

- A small view toggle (`app-btn` group) atop the Nets panel: **Table** (default,
  existing table untouched), **Week**, **Agenda**.
- **Week view:** 7 day-columns (Sun–Sat) showing the **recurring weekly pattern**
  (column = day of week, undated — every week looks the same because schedules are
  weekly). Each enabled schedule renders one compact block in its day column,
  stacked and sorted by time: time + net title. The day column and displayed time
  come from the next occurrence converted to the viewer's timezone (so a
  Sunday-evening net in another timezone lands on the day the viewer would
  actually experience it). The Agenda view is the dated variant. Blocks for
  nets that are live right now get a `● LIVE` highlight linking to the net's live
  URL (`/views/livenet/<npid>`). Clicking a block opens the existing admin schedule
  editor modal for that net.
- **Agenda view:** the next 7 days of computed occurrences as a chronological list
  grouped by day (`Today`, `Tomorrow`, weekday names), same block content.
- **Timezone rule:** each schedule's next occurrence is computed in the net's own
  IANA timezone, then displayed in the **viewer's browser timezone**. Tooltip
  (title attr) shows the net's own timezone and the notify lead
  (e.g. "19:30 America/Denver · opens 30 min early").
- **Occurrence computation** is a pure, tested helper: given
  `{dayOfWeek, hour, minute, timezone}` and a reference `Date`, return the next
  occurrence as a `Date` (epoch). Implementation approach: iterate candidate days in
  the net's tz using `Intl.DateTimeFormat` parts (same technique as the server's
  `isTimeMatch`), no date library.
- Disabled schedules don't render; nets with no schedule appear only in Table view.

### 2. Nets tab — readable Schedule column + LIVE badge

- Schedule cell: `Sun 19:30 (America/Denver) · next in 2d 4h` (relative countdown
  from the same occurrence helper; omit countdown when disabled → show `off`).
- Status cell: `● LIVE` badge (link to live net) when `hasLiveNet`.

### 3. Users tab — status filter chips + Last Login column

- Chips above the table: **All / Active / Locked / Flagged / New** (single-select).
- Server: `listUsers` accepts `status=locked|flagged|new|active`;
  `locked` → `{locked: true}`, `flagged` → `{flaggedForDeletion: true}`,
  `new` → `{newAccount: true}`, `active` → `{locked: {$ne: true},
  flaggedForDeletion: {$ne: true}}`, absent/`all` → no filter. Combines with the
  existing search param; pagination + total counts respect the filter.
- Client: new sortable **Last Login** column (relative, e.g. "3d ago"; `—` when
  never); chips re-query page 1.

### 4. Email tab — bounce focus on Recent Sends

- Status chips: **All / Delivered / Bounced / Deferred / Other** — client-side
  filter over the loaded rows (the load already spans the chosen range).
- Summary line after load: `N sent · X delivered · Y bounced · Z other`.
- Clicking a recipient address jumps to Delivery Lookup with that address
  (reuses the existing `loadEmailActivity(email)` used by the Users deep-link).

### 5. Audit tab — date range, action dropdown, clickable actor

- Server (`listAudit`): accept `from`/`to` (ISO dates → `createdAt: {$gte,$lte}`,
  `to` inclusive end-of-day); the CSV branch inherits them. Response `message`
  gains `actions: string[]` (from `AdminAudit.distinct('action')`, cached per
  request only — the collection is small).
- Client: two date inputs + Action `<select>` populated from `actions` (with
  "any"), replacing the exact-text action input; actor names in result rows are
  clickable → sets the actor filter and re-queries.

## Non-goals

- No port of the admin page to the ReactiveStore/widget pattern (recorded above).
- No public-facing schedule calendar (worthwhile future feature — out of scope).
- No new npm dependencies, no calendar library.
- No changes to the schedule editor itself.

## Testing

- Pure helpers get client-project Jest tests (`tests/client/lib/`): next-occurrence
  computation (tz conversion, week rollover, DST week sanity), relative-countdown
  formatting, recent-sends status bucketing.
- Server: route tests for `listUsers` `status=` filtering and `listAudit`
  `from`/`to` + `actions` (extend existing admin route test files' harness style).
- UI wiring verified on staging (no DOM test environment in the client project).

## Constraints (fork rules)

- Server edits directly in `server/dist/**/*.js`; client via `client/src` +
  `npx tsc -p client/tsconfig.json` ONLY (never `npm run build`); commit dist.
- Deploy: client JS changes require Cloudflare custom-purge of
  `/js/byView/admin/main.js` + hard refresh.
- PATCHES.md: extend the admin/email entries with this pass + the scope decision.
