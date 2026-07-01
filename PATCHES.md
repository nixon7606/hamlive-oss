# PATCHES

This file catalogs how this fork diverges from upstream
(`Constant-Digital-Holdings-LLC/hamlive-oss`) and **why**. Upstream is
unmaintained; this fork is the source of truth and the deployed code.

Organized by area, not by date. For the chronological view see `CHANGELOG.md`
and the git history.

> **Important:** Most changes below were applied to the compiled output under
> `server/dist/` (and `client/dist/`), not to TypeScript/source. If the project
> is ever rebuilt from source, these edits will be overwritten and must be
> ported to the corresponding source files first. Treat the dist tree as the
> live artifact and patch it deliberately.
>
> Reusable patch tooling lives alongside the ops docs: `patch_validation.py`
> (string-match model patcher) and `validate_test.js` (schema validation test
> harness, run with `node validate_test.js`).

---

## Dependencies

### fast-xml-parser bump
- **Files:** `package.json`, lockfile
- **Why:** pull a patched version to clear a known vulnerability in the
  transitive dependency.
- **Upstream:** pinned to the older, flagged version.

---

## Validation (Mongoose models)

These relax over-strict validators that were rejecting legitimate input or
producing unhelpful errors, and they fix one validator that could hang a login.

### callSign accepts portable / DX forms
- **Files:** `server/dist/models/userProfile.js`,
  `server/dist/models/initialRegTracker.js` (kept identical in both)
- **Change:** regex now allows an optional `PREFIX/` and `/SUFFIX`
  (for example `N0AD/M`, `W1AW/4`, `DL/N0AD`); `maxlength` raised from 7 to 14;
  error message points to an example.
- **Upstream:** `/^(\d?[a-zA-Z]{1,3}|[a-zA-Z]\d[a-zA-Z]?)\d[a-zA-Z]{1,4}$/`,
  `maxlength 7`, message "malformed callsign". Rejected every slashed callsign,
  which blocked portable and DX operators from registering.

### location is genuinely optional
- **File:** `server/dist/models/userProfile.js`
- **Change:** removed `minlength: 5` and added an empty-value guard, so a blank
  location saves; when present it must still be 5 to 60 characters. Clearer
  message.
- **Upstream:** `minlength: 5` with no empty guard, so saving a profile with no
  location failed validation. (The sibling `frequency` and `modeDetails` fields
  already had the empty guard; `location` was the inconsistent one.)

### location max raised 24 -> 60 (QRZ auto-fill no longer blocks save)
- **Files:** `server/dist/models/userProfile.js`,
  `server/dist/views/myAccount.ejs` (input `maxlength`),
  `server/dist/views/admin.ejs` (admin edit input `maxlength`),
  `client/src/public/js/byView/myAccount/main.ts` +
  `client/dist/public/js/byView/myAccount/main.js`
- **Change:** `location` `maxlength` 24 -> 60 with a custom (non-value-echoing)
  message; form inputs match. The QRZ auto-fill in `main.ts/.js` truncates the
  returned location to 60 chars (`LOCATION_MAX`) because it sets the field value
  programmatically, which bypasses the input's HTML `maxlength`.
- **Why:** QRZ builds `City (Country)` strings (e.g.
  `Sapphire Central (Australia)`, 28 chars) that exceeded 24 and made the whole
  profile PATCH fail — which, because callsign + location save together, also
  blocked first-time callsign registration. Reported via prod log
  `ValidationError: ... location ... longer than the maximum allowed length (24)`.

### displayName allows real-world names
- **File:** `server/dist/models/userProfile.js`
- **Change:** regex widened to allow digits, parentheses, period, slash and a
  broader accented range; `maxlength` raised from 20 to 40.
- **Upstream:** `/^[A-zÀ-ú-' ]+$/`, `maxlength 20`. Rejected names like
  `Bill (W0SUN) Buckwalter` coming from Google sign-in, which combined with the
  auth bug below produced Cloudflare 524s on `/auth/google/redirect`.

### Clearer messages on frequency and net title
- **File:** `server/dist/models/netProfile.js`
- **Change:** `frequency` message now states the expected decimal format
  (`14.230` / `146.520`); `net title` message now states the length and allowed
  characters.
- **Upstream:** both said "... format did not pass validation", which told the
  user nothing.

### Clearer callsign-already-registered message
- **File:** `server/dist/models/userProfile.js` (unique-validator plugin)
- **Change:** reworded the duplicate-callsign error to plain guidance. Now also
  appends "or email `${SUPPORT_EMAIL}` to change the email on your account" when
  the optional `SUPPORT_EMAIL` env var is set (clause omitted if unset). See
  `.env.example`.
- **Upstream:** terse message referencing logging out and back in.

### Validation errors are shown to the user (not masked as "internal error")
- **Files:** `server/dist/lib/responseUtils.js` (`handleRequest`),
  `server/dist/views/myAccount.ejs` (validation popup modal),
  `client/src/public/js/byView/myAccount/main.ts` +
  `client/dist/public/js/byView/myAccount/main.js`
- **Change:** `handleRequest` no longer classifies Mongoose `ValidationError` as
  "internal". In production these author-defined messages (built cleanly from
  `err.errors`, dropping the `Validation failed: <path>:` prefix and never
  echoing the offending value) are now returned to the client instead of the
  generic "An internal error occurred." Genuine driver errors (`E11000`,
  `MongoServerError`, `CastError`) stay masked. `myAccount` additionally surfaces
  the returned message in a Bootstrap popup (`#validation_modal`) on save
  failure, keeping the inline status line as a fallback.
- **Why:** the schema's helpful messages (duplicate callsign, location too long)
  were being swallowed in prod, so users saw only "An internal error occurred."
  and a self-service fix turned into a support ticket. This is a **global**
  server change — it unmasks validation messages app-wide, by design.

---

## Authentication

### Google strategy no longer hangs on a save failure
- **File:** auth routes module (`authRoutes.js`)
- **Change:** the Google verify-callback catch handler now calls
  `done(null, false)` instead of only logging. Previously a profile-save
  failure left passport waiting forever, surfacing as a Cloudflare 524. This was
  the real cause behind the displayName 524s above.
- **Upstream:** catch handler logged the error and never called `done()`.

### Branded magic-link login email
- **File:** auth routes module (`authRoutes.js`, EmailBase)
- **Change:** inline HTML rebranded (dark logo header, signal-red button);
  subject set to "Sign in to netcontrol.live". Link click-tracking kept OFF so
  the one-time link is not rewritten.
- **Kept inline (not a SendGrid template) on purpose** for portability and
  login-path reliability.

---

## Email notifications

### Net close report uses our own SendGrid template
- **File:** `server/dist/lib/userNotification.js`
- **Change:** swapped the hardcoded upstream SendGrid Dynamic Template ID for
  one created in this account. The upstream ID lives in upstream's SendGrid
  account, so it failed silently here (template-not-found).
- **Note:** the actual template ID is account-specific and is intentionally not
  recorded in this repo. Dynamic fields used: subject, url, title,
  startedAtString, and a formattedAttendees array.

### Branded going-live announcement
- **File:** `server/dist/lib/userNotification.js`
- **Change:** inline HTML rebranded to match the rest. Kept inline (no
  account-specific template ID).

### In-house email — pluggable transports and admin UI
- **New files:** `server/dist/lib/secretBox.js` (AES-256-GCM encryption for SMTP
  credentials), `server/dist/lib/emailTransports.js` (provider selector &
  SendGrid/SMTP/console transports), `server/dist/lib/templateService.js`
  (Handlebars template engine with seeded email templates),
  `server/dist/models/emailSettings.js` (database admin email config),
  `server/dist/models/emailTemplate.js` (database email templates),
  `server/dist/controllers/emailAdminController.js` (admin UI endpoints),
  `server/dist/views/emails/*.hbs` (email templates in Handlebars format)
- **Modified files:** `server/dist/lib/userNotification.js` (uses new pluggable
  transports instead of SendGrid dynamic templates),
  `server/dist/routes/authRoutes.js` (magic-link email uses templateService),
  `server/dist/controllers/adminController.js` (admin UI includes Email
  Settings), `server/dist/routes/adminRoutes.js` (Email Settings endpoints),
  `server/dist/lib/serverUtils.js` (admin mail test endpoint),
  `server/dist/controllers/liveNetController.js` (net-close uses new transports),
  `server/dist/lib/backgroundTasks/scheduledNetStarter.js` (announce email via
  `NetAnnounceStart.init()`), `server/dist/lib/responseUtils.js` (`handleRequest`
  honors a deliberate `err.status`, e.g. 400/404 from the email admin endpoints),
  `server/dist/server.js` (seeds email templates on startup), `server/dist/views/admin.ejs`
  (Email Settings UI added)
- **Client:** new `client/src/public/js/byView/admin/emailSettings.ts` (Email
  Settings panel: provider config + template editor), compiled to
  `client/dist/public/js/byView/admin/emailSettings.js` (+ `.d.ts`/maps);
  `client/src/public/js/byView/admin/main.ts` + compiled
  `client/dist/public/js/byView/admin/main.js` import and init it
- **Breaking change:** net-close report no longer uses the SendGrid dynamic
  template `d-c2c75b3765954b5dbc043576c67493a7`. It now uses the in-house
  Handlebars template engine.
- **Dependencies:** new `nodemailer` (SMTP), `handlebars` (template engine). Both
  require `npm install` on deploy (see `docs/DEPLOY.md`).
- **Why:** in-house transports let admins configure email (SendGrid API key, SMTP
  host, or console logging) entirely in the database admin UI — no need to
  restart the app or edit `.env` to switch providers or add a password. The
  `secretBox.js` module encrypts stored SMTP credentials with AES-256-GCM,
  using `EMAIL_SECRET_KEY` if set or falling back to `COOKIE_SESSION_KEY`. The
  Handlebars template engine replaces dependency on account-specific SendGrid
  template IDs.

### cPanel delivery tracking — SMTP bounce/delivered status via Track Delivery
- **New file:** `server/dist/lib/cpanelDeliveryPoller.js` (pure mapping/
  correlation helpers + a cPanel API 2 `EmailTrack::search` HTTP client with an
  injectable transport + the `pollOnce()` pipeline that advances `EmailLog`/
  `EmailEvent` rows)
- **Modified files:** `server/dist/models/emailSettings.js` (new `tracking`
  sub-schema: `enabled`, `host`, `port`, `user`, `tokenEnc`, `tlsVerify`;
  `saveEmailSettings()` deep-sets `tracking.*` the same way it already did for
  `smtp.*`), `server/dist/controllers/emailAdminController.js` (`tracking`
  block added to `publicSettings()`/`putSettings()`, encrypts the token
  write-only like the SMTP password; new `testTracking` endpoint handler),
  `server/dist/routes/adminRoutes.js` (`POST /admin/email/tracking/test`),
  `server/dist/lib/userNotification.js` (`recordEmailLogs()` takes a 5th
  `status` param; SMTP sends now start their `EmailLog` row at `'accepted'`
  instead of SendGrid's `'queued'`, since SMTP has no queueing step of its
  own), `server/dist/lib/configLib.js` (`CPANEL_DELIVERY_POLLER_ENABLED`
  env override, mirrors the existing `SCHEDULED_NET_STARTER_ENABLED`
  pattern), `server/dist/server.js` (gated 5-minute `setInterval` calling
  `pollOnce()`), `server/dist/views/admin.ejs` (Delivery Tracking card under
  Email Settings: host/port/user/token/TLS-verify fields + Save/Test
  Connection), `.env.example` (documents the new toggle)
- **Client:** new fields wired into `client/src/public/js/byView/admin/
  emailSettings.ts` (existing Email Settings panel; not a new page), compiled
  to `client/dist/public/js/byView/admin/emailSettings.js` (+`.js.map`/
  `.d.ts.map`)
- **Dependencies:** none — the EmailTrack client is hand-rolled on Node's
  built-in `https`, no new package. Deploy remains reset+restart only, no
  `npm install` needed for this feature (contrast with the `nodemailer`/
  `handlebars` entry above, which does need one).
- **Why:** SendGrid sends get delivered/bounced status from SendGrid's event
  webhook; SMTP sends had no equivalent, so their `EmailLog` rows sat at
  `'queued'`/`'accepted'` forever. cPanel's Track Delivery feature (surfaced
  via its legacy `EmailTrack` module) exposes exactly that data for mail sent
  through the box, so a poller fills the same `EmailLog`/`EmailEvent` pipeline
  the admin Email Activity UI already reads.
- **Gotchas for future maintainers (verified against a real cPanel box,
  2026-07-01):**
  - `EmailTrack` only exists in **cPanel API 2** (`/json-api/cpanel` with
    `cpanel_jsonapi_apiversion=2`), **not UAPI** — UAPI has no EmailTrack
    module and returns "module not found." Don't "modernize" this to UAPI.
  - The search call **requires** the bare boolean query flags
    `success=1&defer=1&failure=1&inprogress=1`. With no flags at all, cPanel
    defaults to **failures-only**. The more REST-ish-looking spellings
    (`show_success=1`, `deliverytype=all`, etc.) are silently accepted and
    return an **empty result set** — no error, just nothing, which is easy to
    mistake for "no mail sent yet." See `buildSearchUrl()` in
    `cpanelDeliveryPoller.js` for the exact query string.
  - EmailTrack rows carry the Exim queue id (`msgid`), not the RFC
    `Message-ID` we store on `EmailLog`. Correlation is therefore
    recipient + send-time proximity (`correlateRow()`, 15-minute window over
    the last 48h of non-terminal `EmailLog` rows) — not an exact-id join.
  - The cPanel API token is **user-level** (created in cPanel → Security →
    Manage API Tokens on the account that owns the sending domain), **never a
    WHM token** — WHM tokens can't call per-account `EmailTrack`. It's
    encrypted at rest via `secretBox.js` (same mechanism as the SMTP
    password) and is write-only through the admin API (`publicSettings()`
    only ever returns `tokenSet`/`tokenInvalid` booleans, never the token).

---

## Branding

### Replaced logo and icon assets
- **Files:** `client/dist/public/img/` (navbar SVG, brand PNGs in several
  sizes, the dark-background email banner) and `client/dist/public/`
  (favicons, apple-touch icons)
- **Change:** all brand imagery replaced with the netcontrol.live microphone
  mark at the original dimensions. User-facing text is already driven by the
  `APP_NAME` environment variable, so no code change was needed for text.
- **Upstream:** original Ham.Live artwork.

---

## Legal pages

### Filled-in privacy, cookie, and terms pages
- **Files:** `server/dist/views/privacyPolicy.ejs`,
  `server/dist/views/cookiePolicy.ejs`, `server/dist/views/termsOfUse.ejs`
- **Change:** populated operator, jurisdiction, contact, age, and effective
  date; liability clause set to an at-your-own-risk, no-liability form.
- **Pending:** remove the leftover TEMPLATE banner comments at the top of each
  file; counsel review.
- **Upstream:** placeholder template text.

---

## Real-time chat (Stream)

### Longer SDK connect timeout
- **File:** `server/dist/lib/streamChat.js`
- **Change:** `getInstance` passes `{ timeout: 10000 }`. The SDK default 3s
  was too short in this environment and caused intermittent failures.

### Non-blocking chat-token issuance
- **File:** `server/dist/lib/streamChat.js`
- **Change:** `getChatToken` now backgrounds the slow `upsertStreamUser` call
  (with a `.catch`) and returns the token without waiting on it, while keeping
  `addMembers` awaited. Channel definitions were moved above the upsert.
- **Why:** the original awaited both calls before returning, blocking logins for
  about 10 seconds. An earlier fully-non-blocking attempt broke chat with Stream
  error 17 ("ReadChannel not allowed") because the client read the channel
  before `addMembers` ran, hence `addMembers` stays synchronous.

---

## Roster / net control

### `ui` (undo-check-in) removes a station from the roster immediately
- **Files:** `server/dist/lib/rosterMembership.js`,
  `server/dist/lib/sharedNetOps.js` (`checkState`),
  `server/dist/lib/controllers/liveNetHelpers.js`,
  `server/dist/models/stationInteraction.js`
- **Change:** added a `clearedByNc` flag to the station-interaction doc. The `ui`
  command sets it (and any check-in/out clears it); `shouldKeepInRoster` drops a
  flagged `null`-state station at once instead of holding it for the 3-minute
  lurker grace window. A live presence heartbeat clears the flag, so a real
  viewer behind the callsign reappears as a normal lurker — only a typo'd ghost
  callsign (no heartbeat) stays gone.
- **Why:** net controls reported that on upstream's deployment a mistaken
  check-in typed and then `ui`'d "vanishes and goes away," whereas here the
  cleared call lingered ~3 minutes. The fork had decoupled roster membership
  from the short ~25s presence cutoff (`shouldKeepInRoster`) to stop present-but-
  idle viewers flickering out; that anti-flicker window also caught `ui`'d
  stations. This restores upstream's immediate-removal behaviour for explicit
  `ui` clears while keeping the flicker fix for ordinary lurkers.
- **Upstream:** dropped any `checkedState === null && presence === 'offline'`
  station in `liveNetHelpers` (no `rosterMembership` module, no `clearedByNc`
  field), so an `ui`'d call with no live viewer left the roster right away.
- **Tests:** `tests/server/lib/rosterMembership.test.js` extended with the
  cleared-by-NC cases.

---

## Not applied (intentionally noted)

### Geocoding swap to Nominatim
- A patch to replace Azure Maps with keyless OpenStreetMap Nominatim in
  `server/dist/lib/serverUtils.js` is drafted (`geo_nominatim.py`) but **not
  applied**. The deployment still uses Azure Maps, which is inactive because
  `GEO_KEY` is unset. Decision pending: set a `GEO_KEY`, or apply the swap (and
  then make the failure path fail-soft and add a privacy-policy note).

---

## Re-syncing with upstream

If upstream ever revives and you want to pull changes:

1. Fetch the `upstream` remote and review the diff against the files listed
   above. Those files are where conflicts will land.
2. Remember the changes here are in the **compiled** tree. An upstream that
   ships rebuilt dist files will clobber these; reapply from this catalog (the
   `patch_validation.py` script reapplies the validation set in one pass).
3. Run `validate_test.js` after any model merge to confirm the validators still
   behave as documented.
4. Keep secrets out of the repo. Environment config, tokens, and template IDs
   live in the deployment `.env` and the password manager, not here.
