# In-House Email: Pluggable Transport + Admin Config + Editable Templates

**Date:** 2026-06-30
**Status:** Approved design — ready for implementation plan
**Target:** `staging` branch → staging box for testing

## Goal

Bring email in-house so the app no longer depends on SendGrid's remote dynamic templates,
and give superuser admins a web UI to (a) choose the email provider and configure an SMTP
server, and (b) view/edit the email templates. SendGrid is **kept as a selectable provider**,
not removed. Everything degrades gracefully to console-logging when nothing is configured —
the behavior the app has today with no API key.

## Context (current state)

- **Send chokepoint:** `server/dist/lib/userNotification.js` — `EmailBase` calls
  `sgMail.sendMultiple()`. All upstream machinery (per-recipient rate limiting via
  `emailRateLimiter.js`, dedup, `EmailLog`/`EmailEvent` models, the admin email-activity UI,
  audit logging) is provider-agnostic and **stays unchanged**.
- **Three emails today:**
  - **Magic-link sign-in** — inline HTML in `server/dist/routes/authRoutes.js`.
  - **Net-announce-start** (`NetAnnounceStart`) — inline HTML in `userNotification.js`.
  - **Net Close Report** (`NetCloseReport`) — **remote SendGrid dynamic template**
    `d-c2c75b3765954b5dbc043576c67493a7`; reference HTML saved at
    `docs/email-templates/net-close-report.html` (commit c4fc798).
- **Config:** env-var / YAML driven via `server/dist/lib/configLib.js`, **loaded once at boot**.
  There is **no settings/config Mongoose model** — this design introduces the first one.
- **Admin area:** exists, superuser-gated (`server/dist/views/admin.ejs`,
  `server/dist/routes/adminRoutes.js`, `controllers/adminController.js`), with audit logging
  (`AdminAudit`). New admin features hang off this.
- **TinyMCE** is already self-hosted in the repo (`client/dist/public/tinymce/`, used by
  `myNets.ejs`) and can be reused for the rich-editor toggle.
- **Deploy:** `scripts/deploy.sh` = `git fetch` + `git reset --hard origin/<branch>` +
  `systemctl restart`. **No build step, no `npm install`.** `node_modules` is git-ignored
  (not committed).
- **App signing secret:** `COOKIE_SESSION_KEY` (strength-guarded in `configLib.js`).

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Editable templates | **All three** (magic-link, net-announce, net-close) |
| Provider failure behavior | **Log & drop** after the existing 3-retry loop; no cross-provider failover |
| Template editor UX | **HTML source textarea + TinyMCE toggle**, live preview, send-test-to-me |
| Settings storage | **DB overrides env** (DB → env → console mode); SMTP password encrypted at rest |
| Template engine | **Handlebars** (logic-less; no SSTI; net-close template is already Handlebars) |
| SendGrid | **Kept** as a selectable transport; only its remote *dynamic template* is retired |

## Architecture

```
EmailBase.send()                          (callers unchanged)
   │
   ├─ TemplateService.render(key, data)   → Handlebars template from EmailTemplate (DB),
   │                                         seeded from current source on first boot
   └─ transport.send({ to, subject, html, attachments })
        transport = resolveTransport()    ← per-send, from cached EmailSettings (NOT boot)
          ├─ SmtpTransport       (nodemailer)
          ├─ SendGridTransport   (wraps today's sgMail calls)
          └─ ConsoleTransport    (logs; today's no-key behavior)
```

### Layer 1 — Transport abstraction
- Interface: `send({ to, subject, html, attachments }) → Promise<{ messageId } | { error }>`.
- `ConsoleTransport` and `SendGridTransport` reproduce **exactly** today's behavior, so the
  abstraction lands behavior-preserving before SMTP exists.
- The retry/rate-limit/log flow in `EmailBase` is preserved; only the final "hand off bytes"
  call is swapped from `sgMail.sendMultiple()` to `transport.send()`.

### Layer 2 — SMTP transport + secret box
- `SmtpTransport` uses **nodemailer** (`createTransport({ host, port, secure, auth })`).
- `server/dist/lib/secretBox.js` — small **AES-256-GCM** encrypt/decrypt helper (no existing
  helper to reuse). Key derived via **scrypt** from `EMAIL_SECRET_KEY` if set, else
  `COOKIE_SESSION_KEY`. Stored format includes salt + iv + authTag.
- **Caveat (documented in `.env.example`):** rotating the key invalidates stored SMTP
  passwords (admin re-enters the password).

### Layer 3 — EmailSettings model + send-time resolution ⭐
- New Mongoose model `server/dist/models/emailSettings.js` — **singleton doc**:
  ```
  {
    provider: 'sendgrid' | 'smtp' | 'console',
    smtp: { host, port, secure, user, passwordEnc, fromOverride },
    updatedBy, updatedAt
  }
  ```
- **Send-time resolution (hard requirement):** `resolveTransport()` reads a **cached** copy of
  the settings doc on each send. The cache is **invalidated on admin save** so a provider
  change takes effect on the *next* email **without a service restart**. This is the
  architectural consequence of "DB overrides env" + "test on staging via the web UI" — the
  email path must NOT read provider config at boot the way `configLib` does.
- Resolution order: **DB `provider` (if a settings doc exists) → env vars
  (`SENDGRID_API_KEY` etc.) → ConsoleTransport**.

### Layer 4 — EmailTemplate model + rendering + seeding
- New model `server/dist/models/emailTemplate.js`:
  ```
  { key: 'magic-link' | 'net-announce' | 'net-close', subject, html, updatedBy, updatedAt }
  ```
- `server/dist/lib/templateService.js` compiles the stored Handlebars `html` + `subject` with
  the per-key data object and returns finished strings. Handlebars helpers limited to built-ins
  used by the templates (`#each`, `#if`).
- **Seeding on boot:** for any missing key, insert the default from code —
  - `net-close` from `docs/email-templates/net-close-report.html`,
  - `magic-link` and `net-announce` from their current inline HTML (extracted into seed
    constants).
  Fresh installs and the first deploy render identically to today.
- Each key declares an **allowed variable set** (documented + surfaced in the editor):
  - `magic-link`: `{ url, appName }` (plus whatever the current inline template uses —
    confirmed during implementation).
  - `net-announce`: `{ netTitle, url, humanTime }` (confirmed during implementation).
  - `net-close`: `{ subject, title, url, startedAtString, timezoneAbbr, formattedAttendees[] }`
    where each attendee has `{ role, callSign, displayName, checkInTime, highlight }`.

### Layer 5 — Admin UI ("Email Settings")
Added to `admin.ejs` (superuser-gated) with a per-view TypeScript entry under
`client/src/public/js/byView/admin/` (recompiled to `client/dist`). New endpoints under
`/api/admin/email/*` in `adminRoutes.js` / `adminController.js`, **audit-logged** via
`AdminAudit` like existing admin actions.

- **Provider panel:** radio `smtp | sendgrid | console`; SMTP `host / port / secure / user /
  password / fromOverride`; **"Send test email to me"** (renders a chosen template to the
  logged-in admin via the *currently-saved* transport).
- **Template editor:** list the 3 templates → edit `subject` + `html` in a **source textarea
  with a TinyMCE toggle**; **live preview pane** rendered with sample data; **allowed-variable
  chips**; **send-test-to-me**; **"Reset to default"** re-seeds from code.
- **Secret handling:** the SMTP password field is **write-only**. No admin API ever returns the
  decrypted password; the UI shows a "•••• set" indicator when a password exists.

## Endpoints (new)

All under `superAdminCheck`, audit-logged:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/email/settings` | Current provider + SMTP config (password redacted) |
| PUT | `/api/admin/email/settings` | Save provider + SMTP config; encrypt password; invalidate cache |
| POST | `/api/admin/email/test` | Send a test email (chosen template) to the current admin |
| GET | `/api/admin/email/templates` | List templates (key, subject, html, updatedAt) |
| GET | `/api/admin/email/templates/:key` | One template + allowed-variable list + sample data |
| PUT | `/api/admin/email/templates/:key` | Save subject + html |
| POST | `/api/admin/email/templates/:key/preview` | Render with sample data, return HTML (no send) |
| POST | `/api/admin/email/templates/:key/reset` | Re-seed from code default |

## What is removed / retired

- The **remote SendGrid dynamic template** dependency for net-close: the template id is no
  longer used; net-close renders in-house and is sent as inline HTML by whichever transport is
  active.
- SendGrid **webhook + suppression** code (`sendgridWebhook.js`, `sendgridSuppression.js`,
  routes) **stays in place** but is only meaningful when SendGrid is the active provider; under
  SMTP the admin "delivery events" timeline simply shows less (accept/reject at send time, no
  async bounce tracking). No removal in this project.

## New dependencies

- `nodemailer` (SMTP)
- `handlebars` (template rendering)

Both are runtime deps. Because deploy runs **no `npm install`**, see Deploy below.

## Configuration additions (`.env.example`)

- `EMAIL_SECRET_KEY` (optional) — key material for encrypting stored SMTP passwords; falls back
  to `COOKIE_SESSION_KEY`. Documented rotation caveat.
- (Existing `SENDGRID_API_KEY`, `EMAIL_FROM`, etc. remain as env fallbacks.)

## Deploy to staging

1. Land work on the `staging` branch. **Recompile client TS** (`npm run build`) and commit the
   regenerated `client/dist` (per the fork's patch-`dist` rules). Server code is patched
   directly in `server/dist`.
2. **One-time `npm install` on the staging box** (deploy does not install deps) before
   `systemctl restart hamlive`. The deploy runbook step for this feature is:
   `git reset --hard origin/staging` → `npm install` → `systemctl restart hamlive`.
3. With nothing configured, the app runs in **console mode** (no behavior change). Configure
   SMTP or SendGrid via the admin UI to test live sends.

## Testing strategy

- **Unit:** `secretBox` round-trip; `templateService` renders each seed template with sample
  data (snapshot the net-close output against the saved reference HTML); `resolveTransport`
  precedence (DB → env → console) and cache invalidation on save.
- **Transport:** `ConsoleTransport` logs; `SmtpTransport` against a local catch-all SMTP
  (e.g. MailHog/maildev) on staging; `SendGridTransport` parity with today.
- **Behavior-preserving check:** after Layer 1, all three emails still send identically with no
  settings doc present.
- **Manual on staging:** switch provider in the UI, send-test-to-me, confirm next real email
  uses the new provider with no restart; edit a template, preview, send test, reset to default.

## Out of scope (this project)

- In-house bounce/complaint tracking to replace SendGrid webhooks.
- Cross-provider automatic failover.
- Per-email-type provider selection (provider is global).
- Internationalization / multiple template locales.

## Implementation order (each independently testable on staging)

1. Transport abstraction (console + sendgrid, behavior-preserving).
2. SMTP transport + `secretBox`.
3. `EmailSettings` model + per-send resolution + cache invalidation.
4. `EmailTemplate` model + Handlebars rendering + seeding (+ update
   `docs/email-templates/README.md`, which currently says "convert to EJS" — we keep
   Handlebars).
5. Admin UI (provider panel + template editor).
