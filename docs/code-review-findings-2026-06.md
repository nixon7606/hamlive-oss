# Code Review Findings — 2026-06-24

Multi-agent review (auth, admin/authz, data layer, email/webhooks, client/XSS,
reliability) of hamlive-oss. Each finding lists severity, location, the issue,
and a suggested fix.

**Fixed on branch `fix/review-criticals`** (not in this list): C1 chat `imageUrl`
stored XSS + sibling `linkifyText` href breakout, C2 process crash handlers +
global Express error handler + non-throwing SSE middleware, M1 `devMagicLink` no
longer returned by resend/unsuppress when email is actually sent.

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## 🟠 High — open

### H1 — `devMagicLink` exposed unauthenticated when email delivery is off
- **Where:** `server/dist/routes/authRoutes.js:29,141`; `server/dist/lib/userNotification.js` (`emailEnabled = Boolean(sendgrid_api_key)`)
- **Issue:** `emailEnabled` is tied only to the presence of a SendGrid key, not `NODE_ENV`. If prod ever boots without `SENDGRID_API_KEY`, the public `POST /auth/magiclogin` returns a working sign-in link to anyone for any email → account takeover. Not currently exploitable (prod has SendGrid configured) but a silent footgun.
- **Fix:** Gate the public `devMagicLink` on an explicit dev flag (`NODE_ENV !== 'production'`), and refuse to boot in production when the SendGrid key is missing.

### H2 — Magic-link JWT written to logs via full request URL
- **Where:** `server/dist/lib/logger.js:70` (logs `req.originalUrl`); applies to `GET /auth/magiclogin/callback?token=<JWT>`
- **Issue:** The complete signed token is logged on every login (and can leak via `Referer`). Anyone with log access can replay it for the token lifetime.
- **Fix:** Log `req.path` instead of `req.originalUrl`, or scrub `?token=` / query strings from logged URLs.

### H3 — Magic links are not single-use; 24h lifetime
- **Where:** `server/dist/routes/authRoutes.js` (strategy `verify` never consumes the `code`; `jwtOptions.expiresIn: '24h'`)
- **Issue:** Only signature + expiry are checked; the same link works repeatedly for 24h. Contradicts the email copy "can only be used once."
- **Fix:** Persist a one-time nonce (the `code`/token id) and invalidate on first successful callback; shorten expiry to ~10–15 min.

### H4 — `CF-Connecting-IP` trusted unconditionally (rate-limit bypass / `lastIp` spoof)
- **Where:** `server/dist/lib/magicLoginLimiter.js:20` (`clientIp()`); app binds `0.0.0.0` (`server.js`)
- **Issue:** The header is trusted with no check the request actually came via Cloudflare. If the origin port is reachable outside the tunnel, an attacker spoofs it for unlimited rate-limit buckets and poisons `lastIp`. **Severity depends on network posture** — if the LXC origin is firewalled to cloudflared only, this is Low.
- **Fix:** Only trust `CF-Connecting-IP` when the peer is a known Cloudflare/cloudflared address; bind the origin to localhost and document the tunnel-only requirement.

### H5 — Change-stream auto-reconnect fires once, then silently stops
- **Where:** `server/dist/lib/realtimeClients.js:35-43,92`
- **Issue:** The reconnect+backoff handler is attached only to the initial change stream; recreated streams only log on error. After the second error, roster/presence pushes die instance-wide until restart (a root cause of "stale roster until refresh").
- **Fix:** Attach the reconnect-with-backoff handler inside `createChangeStream` so every (re)created stream self-heals; track `retryDelay` correctly.

### H6 — RealtimeClients leaks per-net SSE wrapper/flexOpts; pushes to dead nets
- **Where:** `server/dist/lib/realtimeClients.js:154-183` (middleware), `49-68` (schedulePush)
- **Issue:** `middlewareMap` entries are deleted only on net-close, not when the last client disconnects. So `schedulePush` keeps running `genLiveNetDetails` (a DB query) for nets with zero viewers forever, the map grows unbounded (memory), and the first client's `flexOpts` (incl. presence timing) is reused for all later clients.
- **Fix:** Track per-npid client count; delete the map entry when the SSE client list empties. Don't capture one shared `flexOpts` per net.

### H7 — SSE `init()` is fire-and-forget at module load (silent real-time loss)
- **Where:** `server/dist/routes/sseLiveNetRoutes.js:7`; `realtimeClients.js:30-73`
- **Issue:** `init()` opens a *second* MongoClient (separate from the mongoose pool) at require time; its promise is discarded and a connect failure only logs. The app boots "healthy" but change-stream-driven real-time updates never work; the duplicate pool is never closed on shutdown.
- **Fix:** Initialize explicitly during bootstrap after DB is up, await it, surface failures, and close it on shutdown.

### H8 — `checkState` fire-and-forget `dia.save()` for known stations
- **Where:** `server/dist/lib/sharedNetOps.js:253`
- **Issue:** For already-known stations the doc is saved without `await` and not collected into `Promise.all`; the response returns before the write settles. Risk: silent lost updates, stale roster broadcast, and unhandled rejection on failure.
- **Fix:** Collect the saves and `await Promise.all(...)` before returning; handle rejection.

---

## 🟡 Medium — open

### M2 — CSV formula injection in email & audit exports
- **Where:** `server/dist/controllers/adminController.js:21-39` (`toCsv`, `auditCsv`)
- **Issue:** Cell values are quote-escaped but not neutralized for spreadsheet formula triggers (`= + - @`, leading tab/CR). Net `title` (fully user-controlled) and email subject/recipient flow into cells; opening the CSV in Excel/Sheets can execute formulas.
- **Fix:** Prefix any cell starting with `= + - @ \t \r` with a single quote before quote-escaping.

### M3 — Type-fragile admin safety guardrails
- **Where:** `server/dist/controllers/adminController.js:104`
- **Issue:** `locked`/`superUser` use strict `=== true/false`, but the values come unparsed from `req.body`; Mongoose casts `"true"`/`0` to real booleans on write, so `{"locked":"true"}` / `{"superUser":0}` bypass the self-lockout and last-admin guardrails while still persisting.
- **Fix:** Normalize to a real boolean before the guardrail checks (or reject non-boolean values for these fields).

### M4 — Missing indexes on `StationInteraction` (hot, growable)
- **Where:** `server/dist/models/stationInteraction.js`
- **Issue:** Created one-per-check-in and queried by `{liveNet,userProfile}` (chat moderation path) and `{netProfile}` (net close) with no indexes → collection scans.
- **Fix:** `index({ liveNet: 1, userProfile: 1 })` and `index({ netProfile: 1 })`.

### M5 — Scheduler can double-open / miss occurrences under tick jitter
- **Where:** `server/dist/lib/backgroundTasks/scheduledNetStarter.js:98-129`; interval `server.js`
- **Issue:** The "minute diff 0 or 1" match over a 60s interval, with no re-entrancy guard and the auto-start guard persisted only *after* net creation, allows a rare double-open (duplicate emails/LiveNet attempt) or overlapping runs if one run exceeds 60s.
- **Fix:** Add an in-flight guard around the interval; persist `lastAutoStartedAt` atomically via a conditional update so two ticks can't both win.

### M6 — `closeNet` not idempotent (duplicate close-report emails)
- **Where:** `server/dist/lib/sharedNetOps.js:703`
- **Issue:** An NCS `close` racing the idle-closer can both pass pre-checks and run the delete sequence; the close-report email path isn't idempotent → duplicate emails / SSE events.
- **Fix:** Claim the close atomically: `findOneAndUpdate({_id, closing:{$ne:true}}, {closing:true})` and bail if no doc matched.

### M7 — Unescaped callSign/title in net-announce email HTML
- **Where:** `server/dist/lib/userNotification.js:240`; admin write path `adminController.js:113` (`findByIdAndUpdate` without `runValidators`)
- **Issue:** `netControl` (callSign) and net `title` are interpolated raw into HTML sent to all followers. Normal paths validate, but admin `updateUser` skips validators, so a superadmin could store markup that renders in followers' inboxes.
- **Fix:** HTML-escape interpolated values in the email template (correct regardless of source), and/or add `{ runValidators: true }` to the admin update.

### M8 — Timers not cleared/`unref`'d on shutdown; chat instance leak
- **Where:** `server.js` (scheduler interval, startup timeout); `realtimeClients.js:66` (self-rescheduling push); `sseChat.js` (`_pruneTimer`)
- **Issue:** Timers aren't tracked/cleared on shutdown (keep the event loop alive); a chat instance that idles without an explicit net-close leaks its `ChatSSEInstance` + prune timer.
- **Fix:** Track and clear all timers in the graceful-shutdown path; remove `streams` entries when a chat instance empties.

### M9 — `dailyDispatch` driven by request traffic + hardcoded timezone
- **Where:** `server/dist/lib/dailyProcessingDispatch.js:14-76` (mounted globally)
- **Issue:** Daily maintenance runs off request traffic (won't run if idle around the day boundary) and hardcodes `America/Los_Angeles`.
- **Fix:** Drive daily maintenance from a timer/cron; make the TZ configurable.

---

## 🟢 Low — open

| ID | Where | Issue | Fix |
|----|-------|-------|-----|
| L1 | `adminController.js:229` `updateNetSchedule` | Only privileged mutation with no `recordAudit` | Add an `update-net` audit entry |
| L2 | admin `:id` params | No ObjectId validation → 500 instead of 400 (superadmin-only) | `validator.isMongoId(id)` guard |
| L3 | `adminController.js:396` | Operator injection on audit `action` filter (`?action[$ne]=`), admin-only | `if (typeof req.query.action === 'string')` |
| L4 | `sharedNetOps.js:203` | Implicit global `qrzInQuotaWait` (non-strict module) | Declare `let` or drop the unused capture |
| L5 | chat edit input `value` | Self-XSS only (author-edits-own) | **Fixed** alongside C1 (now uses `escapeAttr`) |
| L6 | `widgets/stations.ts:92` avatar `src` | Unescaped, but source is trusted (Gravatar/Google) | Escape the attribute (defense-in-depth) |
| L7 | `systemNotifications.ts:142` | Raw `innerHTML` of admin-authored message (no create route today) | Sanitize/allowlist, or document trust |
| L8 | `byView/login/main.ts` | Magic-link `code` logged to console (dev flow only) | Drop the `console.log` |
| L9 | `server.js` CSRF check | Passes when both Origin and Referer are absent | Fail closed for state-changing methods, or use CSRF tokens |
| L10 | `systemNotification.js` | Duplicate index (`unique` + `index`) → startup warning | Drop `index: true` |
| L11 | `chatBan.js:66` | "One active ban per net" not enforced (non-unique index) | Partial unique index on active bans, or fix the comment |
| L12 | `userProfile.js`, `qrzCache.js`, etc. | PII at rest unencrypted (email, lastIp, googleId, geo) | Accept as documented risk, or field-encrypt if required |
| L13 | `server.js:97` | `mongoose.connect` failure logs but doesn't exit → zombie process | `process.exit(1)` on connect failure |
| L14 | `lib/responseUtils.js` | `handleRequest` returns 500 for client-caused errors | Map known client errors to 4xx |

---

## ✅ Verified clean (no action)
SendGrid webhook signature verification (ECDSA, fail-closed, raw body, 600s
replay window, idempotent on unique `sgEventId`, rate-limited). No mass-assignment
(explicit allowlists everywhere). Regex inputs escaped (no ReDoS). Suppression API
safe (no SSRF/token leak). Cookie/session flags correct. Secrets fatal-checked in
prod. Banned-user enforcement per request. The magic-link "never persisted"
invariant (DB/CSV/logs) holds.
