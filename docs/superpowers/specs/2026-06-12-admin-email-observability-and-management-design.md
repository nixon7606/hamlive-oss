# Admin: Email Observability, Resend & Management Hardening — Design

**Date:** 2026-06-12
**Status:** Approved (design); spec pending user review
**Branch:** `feature/admin-email-observability`

## Goal

Give site admins the tools to **delegate admin access safely** and **diagnose/fix email
delivery** without leaving the app. Two related areas, built in phases:

1. **Email observability & resend** — see the full delivery timeline of every email the app sent a
   recipient (delivered / bounced / dropped / deferred / opened, with reasons), fix the common
   "signed up but got nothing" case (usually a SendGrid suppression), and resend a sign-in link.
2. **Admin management hardening** — an audit trail, lockout-prevention guardrails, and a searchable
   user list, so handing admin to others is safe and the site is manageable as it grows.

Powered by SendGrid's **free** Event Webhook + Suppressions API (no paid add-on; fits the $15
Essentials plan). All data stored in the app's own Mongo.

## Current state (relevant facts)

- All email goes through `EmailBase` (`server/dist/lib/userNotification.js`) → `sgMail.sendMultiple()`.
  Types: `magic-login` (inline in `authRoutes.js`), `NetAnnounceStart`, `NetCloseReport`.
- **Nothing about sent email is persisted** — no message ID, no history.
- Admin panel (`server/dist/views/admin.ejs` + `client/src/public/js/byView/admin/main.ts`) has
  Users and Nets tabs; endpoints under `/api/admin/*`, all gated by `middleware/superAdminCheck.js`
  (`req.user.superUser`). `adminController.js` already allows editing `superUser`/`locked`.
- Admin client buttons use **event delegation** (no inline `onclick`) per the CSP fix
  (`script-src-attr 'none'`); all new admin UI MUST follow this pattern.
- `@sendgrid/client` is already bundled (no new dep for suppressions). `@sendgrid/eventwebhook` is
  not installed.

## Decisions (locked)

- **Data source:** SendGrid **Event Webhook** (free) + own Mongo store. NOT the paid Activity API.
- **Resend:** **magic sign-in link only** to start; net-report resend deferred.
- **Logging:** capture **all** outbound email types.
- **QoL included:** admin audit log, admin safety guardrails, SendGrid suppression management, user
  search + pagination, and a user-edit → email-history link.
- **Webhook signature verification:** use the official `@sendgrid/eventwebhook` package (security-
  sensitive; do not hand-roll ECDSA). Accepts one `npm install` on deploy. (Fallback if avoiding the
  dep: verify ECDSA P-256 via Node `crypto` — documented but not preferred.)

---

## Part 1 — Email Observability, Resend & Suppression

### 1.1 Data model (2 new collections)

- **`emailLog`** — one doc per outbound send, per recipient:
  `{ recipient, type, subject, relatedUserId?, relatedNetId?, batchId, sgMessageId?, status, lastEventAt?, createdAt }`.
  `status` starts `queued`, advances to the latest event (`delivered`/`bounced`/`dropped`/…).
  Indexes: `{ recipient: 1, createdAt: -1 }`, `{ batchId: 1 }`.
- **`emailEvents`** — one doc per webhook event:
  `{ sgEventId (unique), batchId, email, event, reason?, sgMessageId?, timestamp }`.
  Unique index on `sgEventId` → idempotent processing. Index `{ batchId: 1 }`, `{ email: 1, timestamp: -1 }`.

### 1.2 Capture outbound sends (`EmailBase`)

In `userNotification.js`:
- Generate a `batchId` per send. Inject `customArgs: { hlType, hlBatch }` into the SendGrid payload
  (echoed back on every event for correlation).
- After a successful `sgMail.sendMultiple()`, read `response.headers['x-message-id']` and create one
  `emailLog` per recipient (`status: 'queued'`).
- All of this wrapped in `try/catch` that only logs on failure — **logging must never break email
  delivery**. When SendGrid is disabled, the feature is inert (no logs, no events).

### 1.3 Event webhook receiver

New route **`POST /api/sendgrid/events`** (mounted outside auth/session/CSRF; external caller):
- Body parsed as **raw** (needed for signature verification) — a route-scoped `express.raw()`.
- Verify SendGrid's **Signed Event Webhook** signature via `@sendgrid/eventwebhook` using
  `SENDGRID_WEBHOOK_VERIFICATION_KEY` and the `X-Twilio-Email-Event-Webhook-Signature` /
  `-Timestamp` headers. Reject (401) on missing/invalid signature.
- For each event: upsert into `emailEvents` keyed by `sgEventId` (idempotent); update the matching
  `emailLog` (`hlBatch` + `email`) `status`/`lastEventAt`.
- Return **2xx quickly** (SendGrid retries non-2xx). Processing errors are logged, not surfaced.

### 1.4 Suppression management (free Suppressions API)

A bounced/spam-reported/blocked address is added to a SendGrid **suppression list** and all future
mail is silently dropped — the usual cause of "I never got it." Using the bundled `@sendgrid/client`:
- **Lookup:** check the recipient against bounces / blocks / spam_reports / invalid_emails lists.
- **Remove + resend:** `DELETE` the suppression, then trigger a resend (§1.6).
- Surfaced inside the admin Email view (a "Suppressed (bounced 2026-05-01) — Remove & resend" banner).

### 1.5 Admin Email view

New **Email tab** in `admin.ejs`:
- Search box (email address) → `GET /api/admin/email?recipient=<email>` (superUser-gated) returns the
  recipient's `emailLog` entries + their `emailEvents` + current suppression status.
- Render each send as a row expandable to its event timeline, color-coded (delivered=green,
  bounce/dropped=red, deferred=amber, open=blue). Show suppression banner when present.
- Buttons: **Resend sign-in link**, and (when suppressed) **Remove suppression & resend**.
- Client JS via **event delegation** (no inline `onclick`).

### 1.6 Resend (magic link)

- **`POST /api/admin/email/resend-login { email }`** (superUser-gated) → sends a fresh magic sign-in
  link to that address. Extract the magic-link send currently inline in `/auth/magiclogin`
  (`authRoutes.js`) into a reusable `sendMagicSignInLink(email)` helper and call it from both places.
- **`POST /api/admin/email/unsuppress { email, list }`** → remove suppression (§1.4), then resend.

### 1.7 Freebie: user → email history

In the existing Edit User modal, add a **"View email history"** action that switches to the Email
tab pre-filled with that user's address.

---

## Part 2 — Admin Management Hardening

### 2.1 Admin audit log

- **`adminAudit`** collection: `{ actorId, actorEmail, action, targetType, targetId, targetLabel,
  details?, createdAt }`. Index `{ createdAt: -1 }`.
- Write an entry on every privileged action: grant/revoke `superUser`, lock/unlock, delete user,
  delete net, resend email, remove suppression. Centralized via a small `recordAudit(req, {...})`
  helper so it can't be forgotten per-endpoint.
- Read-only **Audit tab** in admin: `GET /api/admin/audit?page=` (paginated, newest first).

### 2.2 Safety guardrails

In `adminController.js` `updateUser`/`deleteUser`:
- **No self-demotion:** reject if `req.user._id === targetId` and the change removes `superUser`.
- **No last-admin removal:** reject demoting/deleting a user if they are the only remaining
  `superUser` (`countDocuments({ superUser: true }) <= 1`).
- Client: confirm dialog before granting/revoking admin.
- Return clear 4xx errors the admin UI surfaces.

### 2.3 User search + pagination

- `GET /api/admin/users` gains `?search=` (matches email/callSign/displayName, case-insensitive) and
  `?page=`/`?limit=`; controller returns `{ users, total, page, limit }`.
- Admin Users tab: search box (debounced) + prev/next pagination. Delegated handlers.

---

## Cross-cutting

- **Auth:** every new `/api/admin/*` endpoint uses `superAdminCheck`. The webhook route is the only
  new unauthenticated route and is protected by signature verification instead.
- **CSP:** all new admin client JS uses event delegation (no inline handlers); no CSP change needed.
- **Config / `.env.example`:** add `SENDGRID_WEBHOOK_VERIFICATION_KEY` (documented). Suppressions use
  the existing `SENDGRID_API_KEY`. Operator enables the Event Webhook in SendGrid pointing at
  `https://<host>/api/sendgrid/events` with signature verification on.
- **Dependency:** add `@sendgrid/eventwebhook` (→ deploy needs one `npm install`; note this in the
  deploy steps, which otherwise skip install for CSS/EJS/JS-only changes).
- **TS/build:** admin client changes are TypeScript (`client/src/.../admin/main.ts`) → recompile to
  `dist` and commit both. Server changes live in `server/dist` (the maintained JS).

## Error handling

- Send-logging failures never block email (try/catch, log only).
- Webhook: bad signature → 401; processing error → log + 2xx (avoid SendGrid retry storms);
  duplicate events deduped by `sgEventId`.
- Suppression API failures → surfaced as a non-fatal error in the admin UI; resend still offered.
- Guardrail violations → 4xx with a clear message.

## Testing (server, jest + supertest + mongodb-memory-server)

- Webhook: **rejects invalid/missing signature**; valid payload upserts events **idempotently**
  (same `sgEventId` twice → one doc); updates `emailLog.status`.
- `EmailBase`: on send (mocked `sgMail`), creates `emailLog` with `sgMessageId` + custom args.
- Admin email search: **superUser-gated**; returns logs+events+suppression for a recipient.
- Resend-login: triggers `sendMagicSignInLink` (mocked).
- Guardrails: cannot self-demote; cannot remove last admin.
- Audit: privileged actions write `adminAudit` entries.
- Suppression endpoint: remove calls SendGrid client (mocked) then resend.
- UI verified behaviorally (no client test harness in repo).

## Build order (phased; one plan may split per phase)

1. **Foundation:** `emailLog`/`emailEvents` models + `EmailBase` send-logging.
2. **Webhook:** receiver + signature verify + idempotent upsert.
3. **Email admin UI:** Email tab + search endpoint + timeline.
4. **Resend + suppression:** `sendMagicSignInLink` helper, resend/unsuppress endpoints + UI.
5. **Hardening:** audit log (+ tab), guardrails, user search/pagination, user→email link.

## Out of scope

- Net-report/announce resend (deferred).
- Paid SendGrid Activity API.
- Granular role tiers beyond the existing binary `superUser` (possible future work).
- Outbound email content archival (we store metadata + events, not full bodies).
