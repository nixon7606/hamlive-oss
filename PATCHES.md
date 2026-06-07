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
  location saves; when present it must still be 5 to 24 characters. Clearer
  message.
- **Upstream:** `minlength: 5` with no empty guard, so saving a profile with no
  location failed validation. (The sibling `frequency` and `modeDetails` fields
  already had the empty guard; `location` was the inconsistent one.)

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
- **Change:** reworded the duplicate-callsign error to plain guidance.
- **Upstream:** terse message referencing logging out and back in.

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
