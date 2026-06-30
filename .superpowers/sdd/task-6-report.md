# Task 6 + 6.5 Implementation Report

## Task 6: Convert emails to render via templateService

### Files changed

**`server/dist/routes/authRoutes.js`**
- Added `const { renderTemplate } = require('../lib/templateService');`
- Replaced ~14-line inline HTML magic-link block with: `const { subject, html } = await renderTemplate('magic-link', { link });` + `new EmailBase({ subject, type: 'magic-login', message: html })`
- Kept `emailEnabled` import (still used by line-18 sgMail.setApiKey gate until Task 6.5 also updates this file)

**`server/dist/lib/userNotification.js`**
- `NetAnnounceStart`: replaced sync constructor (with ~10-line inline HTML) with `static async init()` factory. Inline `require('./templateService')` inside `init()`. Computes `humanTime`, calls `renderTemplate('net-announce', data)`, constructs instance via `new NetAnnounceStart({ body: { from: EMAIL_FROM, subject, html } })`, sets `inst.type`.
- `NetCloseReport`: in `static async init()`, changed `return new NetCloseReport(...)` to `const inst = new NetCloseReport(...)` + added inline `require('./templateService')` + `await renderTemplate('net-close', inst._templateData)` + `inst.body.html = html`. In the private constructor: replaced `super({ body: { templateId: ..., dynamic_template_data: ... } })` with `super({ body: { from, subject, attachments } })` + `this._templateData = { ... }`. Fixed `logger.debug(this.body.dynamic_template_data)` → `logger.debug(this._templateData)`.

**`server/dist/controllers/liveNetController.js`**
- Updated the single call site (line ~284, inside `async liveNetCreatePost`): `new NetAnnounceStart({...})` → `await NetAnnounceStart.init({...})`, wrapped in a `try/catch` so a renderTemplate failure degrades gracefully and cannot abort net creation.

**`docs/email-templates/README.md`**
- Replaced the paragraph advising to convert `{{ }}` → EJS syntax with a note that the app renders these in-house via `server/dist/lib/templateService.js` (seeded from `server/dist/views/emails/*.hbs`), and `{{ }}` is used as-is.

### NetAnnounceStart caller
- Only one caller: `server/dist/controllers/liveNetController.js` ~line 284, inside `async liveNetCreatePost`. Already async; the new `await` + try/catch pattern maintains graceful degradation.
- No other callers found (grepped repo-wide for `NetAnnounceStart`).
- No other callers of `new NetCloseReport` found; `NetCloseReport.init()` is called from `sharedNetOps.js`.

---

## Task 6.5: Transport-aware gating

### Files changed

**`server/dist/lib/emailTransports.js`**
- Added `async function isRealSenderActive()` returning `!(t instanceof ConsoleTransport)` where `t = await getActiveTransport()`.
- Added `isRealSenderActive` to `module.exports`.

**`server/dist/lib/userNotification.js`**
- Merged `isRealSenderActive` into the existing `require('./emailTransports')` import (kept `getActiveTransport, ConsoleTransport`).
- Removed `if (!emailEnabled) return;` from `recordEmailLogs` (caller now decides).
- In `sendMailToAddrs`: wrapped `this.recordEmailLogs(...)` with `if (await isRealSenderActive())`.
- Kept `const emailEnabled = Boolean(conf.sendgrid_api_key)` and the `if (emailEnabled) { sgMail.setApiKey(...) }` block (needed for SendGrid transport init). Kept `emailEnabled` in module.exports (consumed by other importers).

**`server/dist/routes/authRoutes.js`**
- Added `const { isRealSenderActive } = require('../lib/emailTransports');`
- Replaced `if (!emailEnabled)` guard in `sendMagicLink` with `if (!(await isRealSenderActive()))` (guard was already inside an async function).
- Made `/magiclogin` route handler `async` and replaced `if (!emailEnabled)` dev-link gate with `if (!(await isRealSenderActive()))`.
- Left `emailEnabled` import intact (still needed for the sgMail init block in userNotification, and this import is from userNotification — it's a no-op cost to keep, not worth an unrelated cleanup commit).

**`server/dist/controllers/adminController.js`**
- Removed `const { emailEnabled } = require('../lib/userNotification');`
- Added `const { isRealSenderActive } = require('../lib/emailTransports');`
- In `resendSignInLink`: replaced `emailEnabled ? null : ...` with `const realSender = await isRealSenderActive(); realSender ? null : ...`
- In `unsuppressEmail`: same pattern.

**`server/dist/lib/serverUtils.js`**
- Added top-level `const { isRealSenderActive } = require('./emailTransports');` (no require cycle: emailTransports → configLib/logger/emailSettings/secretBox — none import serverUtils).
- In `addServerInfo`: replaced `const emailEnabled = Boolean(conf.sendgrid_api_key);` with `const emailEnabled = await isRealSenderActive();`.

### require cycle check
Confirmed no cycle. `emailTransports.js` imports: `configLib`, `logger`, `emailSettings`, `secretBox`, `nodemailer`, `@sendgrid/mail`. None of these transitively import `serverUtils`. Top-level `require` is safe; no inline fallback needed.

---

## TDD evidence — sendGating.test.js

**Approach**: RED step confirmed by running the test before implementing `isRealSenderActive` (test failed with `TypeError: transports.isRealSenderActive is not a function`). GREEN after adding the function to `emailTransports.js`.

**Test** (`tests/server/lib/sendGating.test.js`):
```
✓ isRealSenderActive is false in console mode, true for SMTP   (1 test)
```

Uses `mockSettings` (not `_settings`) so jest's babel hoisting can reference the variable in the mock factory. Mocks `emailSettings.loadEmailSettings` to return `{ provider: 'console' }` → ConsoleTransport → `false`, then `{ provider: 'smtp', smtp: { host: 'h', ... } }` → SmtpTransport → `true`. Calls `invalidateTransportCache()` between settings changes.

---

## Direct class-init coverage (post-review addition)

**`tests/server/lib/emailClassConversion.test.js`** (new, commit `f331698`) directly instantiates both converted classes:

- `NetAnnounceStart.init()`: asserts `body.html` contains the net title, `body.subject` matches the title, `inst.type === 'net-announce'`, `body.templateId === undefined` (SendGrid path gone). Bonus: `countdownTimer <= 1` → humanTime "now" branch.
- `NetCloseReport.init()`: asserts `body.html` contains a callsign (K1ABC), `body.subject === 'Sunday Rag Chew - Net Close Report'`, `body.templateId === undefined`, `body.dynamic_template_data === undefined`, `body.attachments.length === 2`, `inst.type === 'net-close-report'`.

The `templateId === undefined` assertion is load-bearing: it proves the SendGrid template path is actually gone, not just that templates can render in isolation.

**`tests/server/security/accessControlValidation.test.js`** — added the same `emailSettings` mock pattern as the other admin tests. The valid-email test case was hanging (5 s timeout) because `resendSignInLink` now calls `isRealSenderActive()` → `loadEmailSettings()` after Task 6.5; the 400-path tests passed because invalid input returns before that call.

## Regression suite results

**Task 6 commit**: 31 suites, 191 tests — all PASS.

**Task 6.5 commit**: 32 suites, 192 tests — all PASS.

**Post-review commit** (`f331698`): 45 suites, 256 tests — all PASS.

---

## Pre-existing tests adjusted

Three tests were updated to add `jest.mock('../../../server/dist/models/emailSettings', ...)` returning `null` (no DB settings → ConsoleTransport fallback, no real MongoDB connection needed):

1. **`tests/server/routes/magicSendHelper.test.js`** — `sendMagicLink` now calls `await isRealSenderActive()` → `loadEmailSettings()`. Without the mock, the test hung (5 s timeout) waiting for a MongoDB connection that never arrived. Added mock so `buildTransport` fast-paths to ConsoleTransport. Test assertion unchanged.

2. **`tests/server/routes/adminResend.test.js`** — `resendSignInLink` now calls `await isRealSenderActive()` inside `handleRequest`. Same DB-hang failure mode. Added mock. Assertion (`message.sent === true`) unchanged; `devMagicLink` becomes non-null (console mode returns the link) but the test doesn't assert on it.

3. **`tests/server/routes/adminUnsuppress.test.js`** — `unsuppressEmail` same pattern. Mock added. Assertion (`message.removed === true`) unchanged.

No assertion was weakened in any of these changes.

---

## Concerns / notes

- The `emailEnabled` variable in `authRoutes.js` (imported from `userNotification`) is still present after both tasks. It's now unused in the send path. A future cleanup commit could remove it, but Task 6.5 does not introduce the import — it was pre-existing — so it was left to avoid scope creep. Worth a follow-up.
- The "force-exit" worker warning in test output is pre-existing (open MongoDB handles from the `emailLogging.test.js` suite); it is not introduced by these changes.
