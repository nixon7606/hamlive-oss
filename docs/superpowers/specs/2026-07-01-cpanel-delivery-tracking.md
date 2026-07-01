# cPanel Delivery Tracking: EmailTrack Poller for SMTP Sends

**Date:** 2026-07-01
**Status:** Approved design — ready for implementation plan
**Target:** `feat/inhouse-email` branch → staging box (LXC 204) for testing

## Goal

When the email provider is **SMTP** (relaying through a cPanel/Exim server), the admin
email tooling should show the same delivered/bounced status and per-recipient event
timeline it shows for SendGrid — fed by polling cPanel's Track Delivery data instead of
receiving SendGrid's event webhook. No behavior change when the provider is SendGrid or
console.

## Problem

The in-house email feature made SMTP a first-class provider, but the delivery-status
pipeline is SendGrid-only:

- `recordEmailLogs` (`server/dist/lib/userNotification.js`) writes `EmailLog` rows at
  `status: 'queued'`; **only** the SendGrid event webhook
  (`server/dist/routes/sendgridWebhookRoutes.js`) ever advances that status and inserts
  `EmailEvent` timeline rows.
- On SMTP, every `EmailLog` row is stuck at `queued` forever; bounces are invisible;
  the admin Email Activity page misleads.

This is confirmed review finding #6 from the 2026-07-01 whole-branch review.

## Spike results (2026-07-01 — verified against cpanel03.firstlink.com, GO)

- cPanel's Track Delivery data is exposed to **user-level** accounts (no WHM/root) via
  **cPanel API 2** — **not UAPI** (UAPI has no EmailTrack module; `/execute/...` returns
  "module not found").
- Endpoint shape (token auth):

  ```
  GET https://HOST:2083/json-api/cpanel
      ?cpanel_jsonapi_user=USER&cpanel_jsonapi_apiversion=2
      &cpanel_jsonapi_module=EmailTrack&cpanel_jsonapi_func=search
      &success=1&defer=1&failure=1&inprogress=1[&recipient=...]
  Authorization: cpanel USER:APITOKEN
  ```

- **Param spelling matters:** bare boolean flags `success=1&defer=1&failure=1&inprogress=1`
  work; `show_*=1` and `deliverytype=all` silently return empty. The **default (no flags)
  is failures-only** — that's why a healthy system looks empty without them.
- Rows carry: `msgid` (**Exim queue id**, e.g. `1wehY8-000000058OG-2yug`), `type`
  (`success | defer | failure | inprogress`), `message` ("Accepted", ...), `reason`
  (on failures), `sendunixtime`, `actionunixtime`, `sender`, `email` (envelope/from),
  `recipient`, `deliveredto`, `spamscore`.
- **No RFC `Message-ID` header in results** — the nodemailer messageId stored in
  `EmailLog.sgMessageId` cannot be used for correlation.
- The feed contains **all the cPanel account's mail** (DMARC reports, other domains'
  forwards) — the poller must filter to our sending address.
- cPanel API 2 caps results (~250 rows/query).

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Data source | cPanel API 2 `EmailTrack::search`, user-level API token (never WHM) |
| Where config lives | Admin UI: new "Delivery Tracking" card in Email Settings; DB singleton |
| Token storage | Encrypted at rest via `secretBox` (like SMTP password), **write-only** |
| Poll cadence | Every **5 min**, only when provider=smtp + tracking enabled + non-terminal rows exist |
| Lookback window | **48 h**; rows older than that age out (stop polling for them) |
| Correlation | **recipient + send-time window** (EmailTrack has no Message-ID header) |
| Event idempotency | Deterministic synthetic id = `hash(exim msgid + recipient + type)` stored in `EmailEvent.sgEventId` (unique index already exists) |
| Status mapping | `success`→`delivered`, `failure`→`bounce` (with `reason`), `defer`→`deferred` (non-terminal), `inprogress`→ leave as-is |
| SMTP send status | Relabel `queued` → **`accepted`** at send time (honesty fix; lifecycle reads `accepted → delivered / deferred / bounce`) |
| TLS to cPanel | Verify by default; explicit admin toggle to allow self-signed (visible warning) |
| Cloudflare | Non-issue: poller is an outbound app→cPanel call; use the real cPanel host, not a proxied domain |
| Scope exclusions | No opens/clicks (needs a pixel; Exim can't see it), no suppression-list building yet, SendGrid webhook path untouched |

## Architecture

```
server.js (setInterval, gated like scheduledNetStarter)
   └─ cpanelDeliveryPoller.poll()             every 5 min
        1. EmailLog.find({ status: accepted|deferred, createdAt > now-48h, provider smtp })
        2. none? → return (zero API calls when idle)
        3. ONE EmailTrack::search call (flags + our sender; client-side filter regardless)
        4. correlate rows → EmailLog by (recipient, sendunixtime ≈ createdAt window)
        5. map type → status; EmailLog.updateOne + EmailEvent upsert (synthetic id)
```

### New module: `server/dist/lib/cpanelDeliveryPoller.js`

- `pollOnce({ db })` — the 5-step pipeline above; exported for tests and the admin
  "Test connection" button.
- `searchEmailTrack(settings, params)` — HTTP call (built-in `fetch` or `https`), token
  from `secretBox.decryptSecret`, TLS verify per setting. Times out sanely (10 s).
- Started from `server.js` behind `conf.background_tasks?.cpanelDeliveryPoller?.enabled
  !== false` **and** runtime check that provider=smtp + tracking enabled (re-checked
  every tick — admin can enable/disable without restart because settings are re-read).

### Settings: extend the `EmailSettings` singleton (`server/dist/models/emailSettings.js`)

```
tracking: {
  enabled:   Boolean (default false),
  host:      String,        // real cPanel host, e.g. cpanel03.example.com
  port:      Number (2083),
  user:      String,        // cPanel account that OWNS the sending domain
  tokenEnc:  String,        // secretBox-encrypted API token, write-only
  tlsVerify: Boolean (default true)
}
```

- `GET /api/admin/email/settings` returns `tracking` with `tokenSet` /
  `tokenInvalid` booleans (mirror of the SMTP `passwordSet`/`passwordInvalid` pattern)
  and **never** the token.
- `PUT` accepts `tracking.token` (plaintext, write-only) → `encryptSecret` → `tokenEnc`.
- New `POST /api/admin/email/tracking/test` — one `EmailTrack::search` call, returns
  row-count or the error text (mirrors send-test). Audited like the other email admin
  actions.

### Admin UI (`server/dist/views/admin.ejs` + `client/src/.../admin/emailSettings.ts`)

New "Delivery Tracking" card inside the Email Settings panel: enable toggle, host, port,
cPanel user, API token (password-type input, write-only), TLS-verify checkbox with
warning when off, "Test connection" button + status line. Only relevant when provider is
SMTP — hide/disable otherwise (same pattern as `toggleSmtpFields`).

### Send-path relabel (`server/dist/lib/userNotification.js`)

`recordEmailLogs` writes `status: 'accepted'` instead of `'queued'` for non-SendGrid
transports (SendGrid keeps `queued` — its webhook vocabulary starts there).

### Status/event writes (mirror `sendgridWebhookRoutes.js` exactly)

- `EmailLog.updateOne({ batchId, recipient }, { $set: { status, lastEventAt } })` — but
  correlation finds the row first by recipient+time, then uses its `batchId`.
- `EmailEvent.updateOne({ sgEventId: syntheticId }, { $setOnInsert: {...} },
  { upsert: true })` — `event` = mapped status, `reason` from EmailTrack, `sgMessageId`
  = Exim `msgid`, `timestamp` = `actionunixtime`. Existing admin timeline UI reads these
  fields as-is; no UI change needed for the lookup page.

## Testing

- Unit: correlation (recipient+time window, multiple candidates, no match), status
  mapping, synthetic-id determinism/idempotency (same row polled twice → one event),
  age-out, zero-rows-no-API-call gate, sender filtering (foreign account mail ignored).
- Route: settings PUT/GET round-trip (token write-only, tokenSet/tokenInvalid), test
  endpoint success/error paths.
- Staging validation: real send (delivered), forced bounce (nonexistent mailbox at a
  real domain), confirm timeline in admin email lookup.

## Operational notes

- **Rotate the cPanel API token** that was pasted into chat during the spike, before
  entering the new one in the admin UI.
- The cPanel account for the token must be the one that **owns the sending domain**
  (Track Delivery is per-account; e.g. netcontrol.live's owner account).
- Deploy: no new npm dependencies planned (use Node's built-in https/fetch).
