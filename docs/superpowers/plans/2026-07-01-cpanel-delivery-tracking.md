# cPanel Delivery Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the email provider is SMTP (relaying through cPanel/Exim), poll cPanel's
Track Delivery data and feed it into the existing `EmailLog`/`EmailEvent` pipeline so the
admin email tooling shows delivered/bounce status exactly as it does for SendGrid.

**Architecture:** A gated `setInterval` background task (same pattern as
`scheduledNetStarter`) calls cPanel **API 2** `EmailTrack::search` (user-level token, one
bulk call per cycle), correlates rows to `EmailLog` by recipient + send-time window
(EmailTrack exposes only the Exim queue id, not the RFC Message-ID), and mirrors the
SendGrid webhook's writes: `EmailLog.status` updates + idempotent `EmailEvent` upserts
keyed by a deterministic synthetic id. Config lives in the `EmailSettings` singleton
(new `tracking` sub-doc) with the API token secretBox-encrypted and write-only.

**Tech Stack:** Node built-in `https` (no new npm deps), Mongoose, Jest, existing
`secretBox`/`handleRequest`/`recordAudit` conventions.

**Spec:** `docs/superpowers/specs/2026-07-01-cpanel-delivery-tracking.md` — read it first.

## Global Constraints

- ⚠️ **Fork rule:** server code is patched **directly in `server/dist/**/*.js`** — never run
  `npm run build` (the server `tsc` pass regenerates dist from stale `src` and clobbers
  committed patches). Client rebuild is **client-only**: `npx tsc -p client/tsconfig.json`.
- No new npm dependencies. Node's `https` module for the cPanel call.
- The cPanel API token and SMTP password are secrets: encrypted at rest via
  `server/dist/lib/secretBox.js`, **never** returned by any endpoint, never logged.
- All admin endpoints go through `handleRequest(res, fn, label)` and record `AdminAudit`
  entries (see `server/dist/controllers/emailAdminController.js` for the pattern).
- Conventional Commits. TDD: every task writes its failing test first and watches it fail.
- Status vocabulary written by the poller must match the SendGrid webhook's so the
  existing admin UI needs no changes: `delivered`, `bounce`, `deferred`.
- Run the full suite (`npx jest`) before each commit; all suites green.

---

### Task 1: Poller pure helpers (mapping, synthetic id, sender filter, correlation)

**Files:**
- Create: `server/dist/lib/cpanelDeliveryPoller.js`
- Test: `tests/server/lib/cpanelDeliveryPoller.test.js`

**Interfaces:**
- Produces (used by Tasks 3 & 5):
  - `mapTrackType(type: string) -> 'delivered' | 'bounce' | 'deferred' | null`
    (`success`→`delivered`, `failure`→`bounce`, `defer`→`deferred`, anything else → `null`)
  - `syntheticEventId(msgid, recipient, type) -> string` (`cpt-` + sha256 hex, deterministic)
  - `filterToSender(rows, senderAddress) -> rows` (case-insensitive match of the
    EmailTrack `email` OR `sender` field against our sending address)
  - `correlateRow(trackRow, logRows, windowMs=15*60*1000) -> logRow | null`
    (same recipient case-insensitive AND `|sendunixtime*1000 - createdAt| <= windowMs`;
    if several match, the closest in time wins)

- [ ] **Step 1: Write the failing tests**

```js
// tests/server/lib/cpanelDeliveryPoller.test.js
/* hamlive-oss — MIT License. See LICENSE. */
const {
  mapTrackType, syntheticEventId, filterToSender, correlateRow
} = require('../../../server/dist/lib/cpanelDeliveryPoller');

test('mapTrackType mirrors the SendGrid status vocabulary', () => {
  expect(mapTrackType('success')).toBe('delivered');
  expect(mapTrackType('failure')).toBe('bounce');
  expect(mapTrackType('defer')).toBe('deferred');
  expect(mapTrackType('inprogress')).toBeNull(); // leave EmailLog as-is
  expect(mapTrackType('weird-new-type')).toBeNull();
});

test('syntheticEventId is deterministic and distinguishes type/recipient', () => {
  const a = syntheticEventId('1weh-abc', 'x@y.com', 'success');
  expect(a).toBe(syntheticEventId('1weh-abc', 'x@y.com', 'success')); // idempotency key
  expect(a).toMatch(/^cpt-[0-9a-f]{64}$/);
  expect(a).not.toBe(syntheticEventId('1weh-abc', 'x@y.com', 'failure'));
  expect(a).not.toBe(syntheticEventId('1weh-abc', 'z@y.com', 'success'));
});

test('filterToSender keeps only rows sent by our address (feed contains foreign mail)', () => {
  const rows = [
    { email: 'noreply@netcontrol.live', recipient: 'a@x.com' },
    { email: 'noreply-dmarc-support@google.com', recipient: 'dmarc_rua@netcontrol.live' },
    { sender: 'NoReply@NetControl.Live', email: '', recipient: 'b@x.com' }
  ];
  const kept = filterToSender(rows, 'noreply@netcontrol.live');
  expect(kept).toHaveLength(2);
  expect(kept.map(r => r.recipient)).toEqual(['a@x.com', 'b@x.com']);
});

test('correlateRow matches recipient + send-time window, closest row wins', () => {
  const t0 = Date.now();
  const logRows = [
    { _id: 'L1', recipient: 'a@x.com', createdAt: new Date(t0) },
    { _id: 'L2', recipient: 'a@x.com', createdAt: new Date(t0 - 10 * 60 * 1000) },
    { _id: 'L3', recipient: 'other@x.com', createdAt: new Date(t0) }
  ];
  // EmailTrack times are unix SECONDS
  const hit = correlateRow({ recipient: 'A@X.com', sendunixtime: Math.floor(t0 / 1000) - 60 }, logRows);
  expect(hit._id).toBe('L1');
  // outside the 15-min window → no match
  const miss = correlateRow({ recipient: 'a@x.com', sendunixtime: Math.floor(t0 / 1000) - 3600 }, logRows.slice(0, 1));
  expect(miss).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/server/lib/cpanelDeliveryPoller.test.js`
Expected: FAIL — `Cannot find module '.../cpanelDeliveryPoller'`

- [ ] **Step 3: Write the minimal implementation**

```js
// server/dist/lib/cpanelDeliveryPoller.js
/* hamlive-oss — MIT License. See LICENSE. */
/**
 * cPanel Track Delivery poller — fills the EmailLog/EmailEvent pipeline for
 * SMTP sends the way the SendGrid event webhook does for SendGrid sends.
 * Data source: cPanel API 2 EmailTrack::search (user-level token; NOT UAPI —
 * UAPI has no EmailTrack module). See docs/superpowers/specs/
 * 2026-07-01-cpanel-delivery-tracking.md for the verified endpoint shape.
 */
const crypto = require('crypto');

// EmailTrack `type` → the SendGrid-webhook status vocabulary the admin UI
// already understands. `inprogress` (and unknown types) → null = don't touch.
function mapTrackType(type) {
    if (type === 'success') return 'delivered';
    if (type === 'failure') return 'bounce';
    if (type === 'defer') return 'deferred';
    return null;
}

// Deterministic id for EmailEvent.sgEventId (unique index) — the poller
// re-reads the same EmailTrack rows every cycle for up to 48h, so the upsert
// key must be stable across polls.
function syntheticEventId(msgid, recipient, type) {
    const h = crypto.createHash('sha256').update(`${msgid}|${recipient}|${type}`).digest('hex');
    return `cpt-${h}`;
}

// The EmailTrack feed contains ALL the cPanel account's mail (DMARC reports,
// other domains' forwards) — keep only rows our app sent.
function filterToSender(rows, senderAddress) {
    const want = String(senderAddress || '').toLowerCase();
    if (!want) return [];
    return (rows || []).filter(r =>
        String(r.email || '').toLowerCase() === want ||
        String(r.sender || '').toLowerCase() === want);
}

// EmailTrack has no RFC Message-ID, so correlate on recipient + send-time
// proximity. Multiple candidates → closest createdAt wins.
function correlateRow(trackRow, logRows, windowMs = 15 * 60 * 1000) {
    const rcpt = String(trackRow.recipient || '').toLowerCase();
    const sentMs = Number(trackRow.sendunixtime) * 1000;
    if (!rcpt || !Number.isFinite(sentMs)) return null;
    let best = null, bestDelta = Infinity;
    for (const row of logRows) {
        if (String(row.recipient || '').toLowerCase() !== rcpt) continue;
        const delta = Math.abs(new Date(row.createdAt).getTime() - sentMs);
        if (delta <= windowMs && delta < bestDelta) { best = row; bestDelta = delta; }
    }
    return best;
}

module.exports = { mapTrackType, syntheticEventId, filterToSender, correlateRow };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/server/lib/cpanelDeliveryPoller.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/dist/lib/cpanelDeliveryPoller.js tests/server/lib/cpanelDeliveryPoller.test.js
git commit -m "feat(email): cPanel delivery poller — mapping, synthetic ids, correlation"
```

---

### Task 2: EmailTrack API 2 client (URL builder, response parser, https call)

**Files:**
- Modify: `server/dist/lib/cpanelDeliveryPoller.js` (append; keep Task 1 exports)
- Test: `tests/server/lib/cpanelEmailTrackClient.test.js`

**Interfaces:**
- Consumes: `decryptSecret` from `server/dist/lib/secretBox.js` (throws on bad token).
- Produces (used by Tasks 3 & 5):
  - `buildSearchUrl(tracking) -> string` — `tracking` is
    `{ host, port, user }`; returns the full API 2 URL **with the verified flag params**
    `success=1&defer=1&failure=1&inprogress=1`.
  - `parseSearchResponse(json) -> rows[]` — unwraps `cpanelresult.data`; throws with the
    joined `cpanelresult.errors` text when present (e.g. wrong module/feature).
  - `searchEmailTrack(tracking, { requestImpl }) -> Promise<rows[]>` — decrypts
    `tracking.tokenEnc`, GETs with `Authorization: cpanel USER:TOKEN`, honors
    `tracking.tlsVerify === false` via `rejectUnauthorized: false`, 10 s timeout.
    `requestImpl(url, options) -> Promise<{ statusCode, body }>` is injectable for tests;
    the default implementation wraps `https.request`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/server/lib/cpanelEmailTrackClient.test.js
/* hamlive-oss — MIT License. See LICENSE. */
jest.mock('../../../server/dist/lib/secretBox', () => ({
  decryptSecret: jest.fn(tok => {
    if (tok === 'enc:good') return 'THETOKEN';
    throw new Error('bad auth tag');
  }),
  encryptSecret: jest.fn()
}));

const {
  buildSearchUrl, parseSearchResponse, searchEmailTrack
} = require('../../../server/dist/lib/cpanelDeliveryPoller');

test('buildSearchUrl uses API 2 json-api with the verified boolean flags', () => {
  const url = buildSearchUrl({ host: 'cp.example.com', port: 2083, user: 'acct' });
  expect(url).toContain('https://cp.example.com:2083/json-api/cpanel?');
  expect(url).toContain('cpanel_jsonapi_user=acct');
  expect(url).toContain('cpanel_jsonapi_apiversion=2');
  expect(url).toContain('cpanel_jsonapi_module=EmailTrack');
  expect(url).toContain('cpanel_jsonapi_func=search');
  // the ONLY spelling that returns successes on a real box:
  expect(url).toContain('success=1');
  expect(url).toContain('defer=1');
  expect(url).toContain('failure=1');
  expect(url).toContain('inprogress=1');
});

test('parseSearchResponse unwraps data and surfaces cPanel errors', () => {
  expect(parseSearchResponse({ cpanelresult: { data: [{ msgid: 'a' }] } })).toEqual([{ msgid: 'a' }]);
  expect(parseSearchResponse({ cpanelresult: { data: [] } })).toEqual([]);
  expect(() => parseSearchResponse({ errors: ['Failed to load module “EmailTrack”'] }))
    .toThrow(/EmailTrack/);
  expect(() => parseSearchResponse({ cpanelresult: { error: 'Access denied' } }))
    .toThrow(/Access denied/);
});

test('searchEmailTrack decrypts the token and sends the cpanel auth header', async () => {
  const requestImpl = jest.fn(async (url, opts) => ({
    statusCode: 200,
    body: JSON.stringify({ cpanelresult: { data: [{ msgid: 'm1' }] } })
  }));
  const rows = await searchEmailTrack(
    { host: 'cp.example.com', port: 2083, user: 'acct', tokenEnc: 'enc:good', tlsVerify: true },
    { requestImpl }
  );
  expect(rows).toEqual([{ msgid: 'm1' }]);
  const [url, opts] = requestImpl.mock.calls[0];
  expect(url).toContain('cp.example.com');
  expect(opts.headers.Authorization).toBe('cpanel acct:THETOKEN');
  expect(opts.rejectUnauthorized).toBe(true);
});

test('searchEmailTrack maps tlsVerify:false and undecryptable tokens to clear errors', async () => {
  const requestImpl = jest.fn(async () => ({ statusCode: 200, body: '{"cpanelresult":{"data":[]}}' }));
  await searchEmailTrack({ host: 'h', port: 2083, user: 'u', tokenEnc: 'enc:good', tlsVerify: false }, { requestImpl });
  expect(requestImpl.mock.calls[0][1].rejectUnauthorized).toBe(false);

  await expect(
    searchEmailTrack({ host: 'h', port: 2083, user: 'u', tokenEnc: 'enc:BAD', tlsVerify: true }, { requestImpl })
  ).rejects.toThrow(/decrypt/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/server/lib/cpanelEmailTrackClient.test.js`
Expected: FAIL — `buildSearchUrl is not a function`

- [ ] **Step 3: Append the implementation to `cpanelDeliveryPoller.js`**

```js
// append to server/dist/lib/cpanelDeliveryPoller.js (before module.exports; extend exports)
const https = require('https');
const { decryptSecret } = require('./secretBox');
const { logger } = require('./logger');

function buildSearchUrl({ host, port, user }) {
    const qs = new URLSearchParams({
        cpanel_jsonapi_user: user,
        cpanel_jsonapi_apiversion: '2',
        cpanel_jsonapi_module: 'EmailTrack',
        cpanel_jsonapi_func: 'search',
        // Verified on a real box (2026-07-01): bare boolean flags are the only
        // spelling that returns successes; the no-flag default is failures-only.
        success: '1', defer: '1', failure: '1', inprogress: '1'
    });
    return `https://${host}:${Number(port) || 2083}/json-api/cpanel?${qs.toString()}`;
}

function parseSearchResponse(json) {
    const topErrors = json && json.errors;
    if (Array.isArray(topErrors) && topErrors.length) throw new Error(topErrors.join('; '));
    const cr = json && json.cpanelresult;
    if (cr && cr.error) throw new Error(String(cr.error));
    return (cr && Array.isArray(cr.data)) ? cr.data : [];
}

// Default transport — thin https wrapper so tests can inject requestImpl.
function httpsRequestImpl(url, options) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        });
        req.on('error', reject);
        req.setTimeout(options.timeout || 10_000, () => req.destroy(new Error('EmailTrack request timed out')));
        req.end();
    });
}

async function searchEmailTrack(tracking, { requestImpl = httpsRequestImpl } = {}) {
    let token;
    try { token = decryptSecret(tracking.tokenEnc); }
    catch (err) { throw new Error(`cannot decrypt cPanel API token (re-enter it in Email Settings): ${err.message}`); }
    const url = buildSearchUrl(tracking);
    const { statusCode, body } = await requestImpl(url, {
        method: 'GET',
        headers: { Authorization: `cpanel ${tracking.user}:${token}` },
        rejectUnauthorized: tracking.tlsVerify !== false,
        timeout: 10_000
    });
    if (statusCode !== 200) throw new Error(`EmailTrack HTTP ${statusCode}`);
    let json;
    try { json = JSON.parse(body); }
    catch { throw new Error('EmailTrack returned non-JSON (check host/port)'); }
    return parseSearchResponse(json);
}

module.exports = {
    mapTrackType, syntheticEventId, filterToSender, correlateRow,
    buildSearchUrl, parseSearchResponse, searchEmailTrack
};
```

(Remove the Task 1 `module.exports` line — one exports object at the end of the file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/server/lib/cpanelEmailTrackClient.test.js tests/server/lib/cpanelDeliveryPoller.test.js`
Expected: PASS (8 tests across both files)

- [ ] **Step 5: Commit**

```bash
git add server/dist/lib/cpanelDeliveryPoller.js tests/server/lib/cpanelEmailTrackClient.test.js
git commit -m "feat(email): EmailTrack API 2 client with injectable transport"
```

---

### Task 3: `pollOnce` pipeline

**Files:**
- Modify: `server/dist/lib/cpanelDeliveryPoller.js` (append `shouldPoll`, `pollOnce`)
- Test: `tests/server/lib/cpanelPollOnce.test.js`

**Interfaces:**
- Consumes: Task 1 + 2 exports; `loadEmailSettings` from
  `server/dist/models/emailSettings.js`; `getEmailLog` from
  `server/dist/models/emailLog.js`; `getEmailEvent` from
  `server/dist/models/emailEvent.js`; `EMAIL_FROM`-style sender resolution: the sending
  address = `settings.smtp.fromOverride || process.env.EMAIL_FROM || conf.email_from`
  (extract the bare address from a possible `"Name <addr>"` form).
- Produces (used by Tasks 6 & 5):
  - `shouldPoll(settings) -> boolean` — true only when `settings?.provider === 'smtp'`
    and `settings?.tracking?.enabled` and `tracking.host && tracking.user && tracking.tokenEnc`.
  - `pollOnce({ searchImpl } = {}) -> Promise<{ polled, updated, events }>` — the 5-step
    pipeline from the spec; `searchImpl` defaults to `searchEmailTrack` (injectable).

- [ ] **Step 1: Write the failing tests**

```js
// tests/server/lib/cpanelPollOnce.test.js
/* hamlive-oss — MIT License. See LICENSE. */
let mockSettings = null;
jest.mock('../../../server/dist/models/emailSettings', () => ({
  loadEmailSettings: jest.fn(async () => mockSettings),
  saveEmailSettings: jest.fn()
}));

const logRows = [];
const logUpdates = [];
jest.mock('../../../server/dist/models/emailLog', () => ({
  getEmailLog: () => ({
    find: () => ({ lean: async () => logRows }),
    updateOne: async (q, u) => { logUpdates.push({ q, u }); return { matchedCount: 1 }; }
  })
}));

const eventUpserts = [];
jest.mock('../../../server/dist/models/emailEvent', () => ({
  getEmailEvent: () => ({
    updateOne: async (q, u, o) => { eventUpserts.push({ q, u, o }); return { upsertedCount: 1 }; }
  })
}));

jest.mock('../../../server/dist/lib/configLib', () => ({ conf: { email_from: 'noreply@netcontrol.live' } }));

const { pollOnce, shouldPoll, syntheticEventId } = require('../../../server/dist/lib/cpanelDeliveryPoller');

const TRACKING = { enabled: true, host: 'cp', port: 2083, user: 'acct', tokenEnc: 'enc:t', tlsVerify: true };

beforeEach(() => { logRows.length = 0; logUpdates.length = 0; eventUpserts.length = 0; });

test('shouldPoll requires smtp provider + enabled + complete tracking config', () => {
  expect(shouldPoll({ provider: 'smtp', tracking: TRACKING })).toBe(true);
  expect(shouldPoll({ provider: 'sendgrid', tracking: TRACKING })).toBe(false);
  expect(shouldPoll({ provider: 'smtp', tracking: { ...TRACKING, enabled: false } })).toBe(false);
  expect(shouldPoll({ provider: 'smtp', tracking: { ...TRACKING, tokenEnc: '' } })).toBe(false);
  expect(shouldPoll(null)).toBe(false);
});

test('no non-terminal rows → zero API calls', async () => {
  mockSettings = { provider: 'smtp', smtp: {}, tracking: TRACKING };
  const searchImpl = jest.fn();
  const r = await pollOnce({ searchImpl });
  expect(searchImpl).not.toHaveBeenCalled();
  expect(r).toEqual({ polled: 0, updated: 0, events: 0 });
});

test('delivered + bounce rows update EmailLog and upsert idempotent EmailEvents', async () => {
  const now = Date.now();
  mockSettings = { provider: 'smtp', smtp: {}, tracking: TRACKING };
  logRows.push(
    { _id: 'L1', batchId: 'B1', recipient: 'a@x.com', status: 'accepted', createdAt: new Date(now - 60_000) },
    { _id: 'L2', batchId: 'B2', recipient: 'b@x.com', status: 'accepted', createdAt: new Date(now - 60_000) }
  );
  const searchImpl = jest.fn(async () => ([
    { msgid: 'm1', type: 'success', email: 'noreply@netcontrol.live', recipient: 'a@x.com',
      sendunixtime: Math.floor(now / 1000) - 30, actionunixtime: Math.floor(now / 1000) - 10 },
    { msgid: 'm2', type: 'failure', reason: 'mailbox unavailable', email: 'noreply@netcontrol.live',
      recipient: 'b@x.com', sendunixtime: Math.floor(now / 1000) - 30, actionunixtime: Math.floor(now / 1000) - 5 },
    // foreign mail in the same account — must be ignored
    { msgid: 'm3', type: 'success', email: 'noreply-dmarc-support@google.com',
      recipient: 'dmarc_rua@netcontrol.live', sendunixtime: Math.floor(now / 1000) }
  ]));
  const r = await pollOnce({ searchImpl });
  expect(r.updated).toBe(2);
  expect(logUpdates).toHaveLength(2);
  expect(logUpdates[0].q).toEqual({ batchId: 'B1', recipient: 'a@x.com' });
  expect(logUpdates[0].u.$set.status).toBe('delivered');
  expect(logUpdates[1].u.$set.status).toBe('bounce');
  // events: idempotent synthetic key in sgEventId, reason carried, exim id in sgMessageId
  expect(eventUpserts).toHaveLength(2);
  expect(eventUpserts[0].q).toEqual({ sgEventId: syntheticEventId('m1', 'a@x.com', 'success') });
  expect(eventUpserts[0].o).toEqual({ upsert: true });
  expect(eventUpserts[1].u.$setOnInsert.reason).toBe('mailbox unavailable');
  expect(eventUpserts[1].u.$setOnInsert.sgMessageId).toBe('m2');
});

test('inprogress rows change nothing; defer maps to deferred (stays pollable)', async () => {
  const now = Date.now();
  mockSettings = { provider: 'smtp', smtp: {}, tracking: TRACKING };
  logRows.push({ _id: 'L1', batchId: 'B1', recipient: 'a@x.com', status: 'accepted', createdAt: new Date(now) });
  const searchImpl = jest.fn(async () => ([
    { msgid: 'm1', type: 'inprogress', email: 'noreply@netcontrol.live', recipient: 'a@x.com', sendunixtime: Math.floor(now / 1000) },
    { msgid: 'm1', type: 'defer', reason: 'greylisted', email: 'noreply@netcontrol.live', recipient: 'a@x.com', sendunixtime: Math.floor(now / 1000) }
  ]));
  await pollOnce({ searchImpl });
  expect(logUpdates).toHaveLength(1);
  expect(logUpdates[0].u.$set.status).toBe('deferred');
});

test('pollOnce is a no-op when shouldPoll is false (provider flipped back to sendgrid)', async () => {
  mockSettings = { provider: 'sendgrid', tracking: TRACKING };
  const searchImpl = jest.fn();
  const r = await pollOnce({ searchImpl });
  expect(searchImpl).not.toHaveBeenCalled();
  expect(r).toEqual({ polled: 0, updated: 0, events: 0 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/server/lib/cpanelPollOnce.test.js`
Expected: FAIL — `pollOnce is not a function`

- [ ] **Step 3: Append the implementation**

```js
// append to server/dist/lib/cpanelDeliveryPoller.js (extend module.exports)
const LOOKBACK_MS = 48 * 60 * 60 * 1000;
const NON_TERMINAL = ['accepted', 'deferred'];

function shouldPoll(settings) {
    const t = settings && settings.tracking;
    return Boolean(settings && settings.provider === 'smtp' &&
        t && t.enabled && t.host && t.user && t.tokenEnc);
}

// Bare address out of "Display Name <addr@host>" (EMAIL_FROM style).
function bareAddress(s) {
    const m = /<([^>]+)>/.exec(String(s || ''));
    return (m ? m[1] : String(s || '')).trim().toLowerCase();
}

function resolveSenderAddress(settings) {
    const { conf } = require('./configLib');
    return bareAddress(
        (settings.smtp && settings.smtp.fromOverride) ||
        process.env.EMAIL_FROM || conf.email_from || '');
}

async function pollOnce({ searchImpl = searchEmailTrack } = {}) {
    const { loadEmailSettings } = require('../models/emailSettings');
    const settings = await loadEmailSettings();
    if (!shouldPoll(settings)) return { polled: 0, updated: 0, events: 0 };

    const { getEmailLog } = require('../models/emailLog');
    const { getEmailEvent } = require('../models/emailEvent');
    const EmailLog = getEmailLog();
    const EmailEvent = getEmailEvent();

    const open = await EmailLog.find({
        status: { $in: NON_TERMINAL },
        createdAt: { $gte: new Date(Date.now() - LOOKBACK_MS) }
    }).lean();
    if (!open.length) return { polled: 0, updated: 0, events: 0 };

    const rows = filterToSender(await searchImpl(settings.tracking), resolveSenderAddress(settings));

    let updated = 0, events = 0;
    for (const row of rows) {
        const status = mapTrackType(row.type);
        if (!status) continue; // inprogress / unknown → leave as-is
        const log = correlateRow(row, open);
        if (!log) continue;
        const when = Number.isFinite(Number(row.actionunixtime))
            ? new Date(Number(row.actionunixtime) * 1000) : new Date();
        try {
            await EmailEvent.updateOne(
                { sgEventId: syntheticEventId(row.msgid, row.recipient, row.type) },
                { $setOnInsert: {
                    sgEventId: syntheticEventId(row.msgid, row.recipient, row.type),
                    batchId: log.batchId,
                    email: log.recipient,
                    event: status,
                    reason: row.reason,
                    sgMessageId: row.msgid,
                    timestamp: when
                } },
                { upsert: true }
            );
            events++;
            await EmailLog.updateOne(
                { batchId: log.batchId, recipient: log.recipient },
                { $set: { status, lastEventAt: when } }
            );
            updated++;
        } catch (err) {
            logger.error(`cpanelDeliveryPoller: row processing failed: ${err.message}`);
        }
    }
    return { polled: rows.length, updated, events };
}

// add to module.exports: shouldPoll, pollOnce
```

Note: the delivered/bounce test asserts `updated: 2` with one update per row — the
counters count **successful writes**, and re-polls of already-terminal rows naturally
drop out because the `EmailLog.find` filter only returns non-terminal rows.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/server/lib/cpanelPollOnce.test.js tests/server/lib/cpanelDeliveryPoller.test.js tests/server/lib/cpanelEmailTrackClient.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/dist/lib/cpanelDeliveryPoller.js tests/server/lib/cpanelPollOnce.test.js
git commit -m "feat(email): pollOnce pipeline — correlate EmailTrack rows into EmailLog/EmailEvent"
```

---

### Task 4: Relabel SMTP send status `queued` → `accepted`

**Files:**
- Modify: `server/dist/lib/userNotification.js` (in `sendMailToAddrs` + `recordEmailLogs`)
- Test: `tests/server/lib/emailLogging.test.js` (extend)

**Interfaces:**
- Consumes: `getActiveTransport`, `SmtpTransport` from `server/dist/lib/emailTransports.js`.
- Produces: `recordEmailLogs(recipients, subject, batchId, sgMessageId, status = 'queued')`
  — new optional 5th param. `sendMailToAddrs` passes `'accepted'` when the active
  transport is an `SmtpTransport`, `'queued'` otherwise (SendGrid's webhook vocabulary
  starts at `queued`).

- [ ] **Step 1: Add the failing test.** `tests/server/lib/emailLogging.test.js` is an
  integration test against the test MongoDB (see its header — `EmailBase` +
  `@sendgrid/mail` mock; the existing test already asserts SendGrid rows stay `queued`).
  Add a nodemailer mock **at the top of the file, next to the @sendgrid/mail mock**:

```js
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn(async () => ({ messageId: '<m@local>' })) }))
}));
```

  and append the new test:

```js
test('SMTP sends record EmailLog rows as accepted (the cPanel poller advances them)', async () => {
  // Point the active transport at SMTP via a real EmailSettings doc in the test DB.
  const { emailSettingsSchema } = require('../../../server/dist/models/emailSettings');
  const EmailSettings = mongoose.models.EmailSettings || mongoose.model('EmailSettings', emailSettingsSchema);
  await EmailSettings.create({ singleton: 'email', provider: 'smtp', smtp: { host: 'localhost', port: 25 } });
  const { invalidateTransportCache } = require('../../../server/dist/lib/emailTransports');
  invalidateTransportCache();
  try {
    const mail = new EmailBase({ subject: 'Hi', message: '<p>hi</p>', type: 'magic-login' });
    await mail.sendMailToAddrs(['smtp-status@b.com']);
    await new Promise(r => setTimeout(r, 50)); // logging is fire-and-forget
    const logs = await EmailLog.find({ recipient: 'smtp-status@b.com' });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('accepted'); // NOT SendGrid's 'queued'
  } finally {
    await EmailSettings.deleteMany({});
    invalidateTransportCache();
  }
});
```

The existing first test (`status).toBe('queued')` for the SendGrid path) is the other
half of the contract — leave it untouched: **SmtpTransport ⇒ 'accepted'; otherwise
'queued'.**

- [ ] **Step 2: Run to verify it fails** — `npx jest tests/server/lib/emailLogging.test.js`

- [ ] **Step 3: Implement**

```js
// server/dist/lib/userNotification.js — sendMailToAddrs, replace the record line:
            const messageId = await this.sendEmailWithRetry(emailData, allowed);
            if (await isRealSenderActive()) {
                const transport = await getActiveTransport(); // cached — cheap
                const initialStatus = transport instanceof SmtpTransport ? 'accepted' : 'queued';
                this.recordEmailLogs(allowed, subject, batchId, messageId, initialStatus);
            }

// recordEmailLogs:
    recordEmailLogs(recipients, subject, batchId, sgMessageId, status = 'queued') {
        const EmailLog = getEmailLog();
        Promise.all(recipients.map(r => EmailLog.create({
            recipient: r, type: this.type, subject, batchId, sgMessageId, status
        }))).catch(err => logger.error(`recordEmailLogs() failed: ${err.message}`));
    }
```

Add `SmtpTransport` to the existing `require('./emailTransports')` destructuring at the
top of `userNotification.js`.

- [ ] **Step 4: Run the full suite** — `npx jest` — some tests may assert `status: 'queued'`
  for SMTP paths; update only assertions that encode the old bug.

- [ ] **Step 5: Commit**

```bash
git add server/dist/lib/userNotification.js tests/server/lib/emailLogging.test.js
git commit -m "fix(email): SMTP EmailLog rows start at 'accepted', not SendGrid's 'queued'"
```

---

### Task 5: Settings model + admin endpoints (tracking config, write-only token, test-connection)

**Files:**
- Modify: `server/dist/models/emailSettings.js` (tracking sub-schema + deep-set in save)
- Modify: `server/dist/controllers/emailAdminController.js` (publicSettings, putSettings, new `testTracking`)
- Modify: `server/dist/routes/adminRoutes.js` (register `POST /email/tracking/test`)
- Test: `tests/server/routes/adminEmailSettings.test.js` (extend), `tests/server/routes/adminTrackingTest.test.js` (new)

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` (secretBox), `pollOnce`/`searchEmailTrack`
  from Task 2/3, existing `handleRequest`/`recordAudit`.
- Produces:
  - `EmailSettings.tracking` sub-doc: `{ enabled: Boolean(false), host: String,
    port: Number(2083), user: String, tokenEnc: String, tlsVerify: Boolean(true) }`.
  - `GET /api/admin/email/settings` response gains
    `tracking: { enabled, host, port, user, tlsVerify, tokenSet, tokenInvalid }` (no token).
  - `PUT /api/admin/email/settings` accepts `tracking: {..., token?: string }` — plaintext
    token encrypted to `tokenEnc`, never stored raw; absent token preserves stored one.
  - `POST /api/admin/email/tracking/test` → `{ ok: true, rows: N }` or
    `{ ok: false, error: '...' }` (one live `searchEmailTrack` call; audited).

- [ ] **Step 1: Write failing route tests** — extend `adminEmailSettings.test.js`
  (same mock style already in the file):

```js
// append to tests/server/routes/adminEmailSettings.test.js
test('PUT encrypts a provided tracking token, write-only; GET reports tokenSet, never the token', async () => {
  const res = await request(app).put('/api/admin/email/settings')
    .send({ provider: 'smtp', tracking: { enabled: true, host: 'cp.example.com', port: 2083, user: 'acct', tlsVerify: true, token: 'SECRETTOKEN' } });
  expect(res.status).toBe(200);
  const savedPatch = saveEmailSettings.mock.calls.at(-1)[0];
  expect(savedPatch.tracking.tokenEnc).toBe('enc:SECRETTOKEN');
  expect(savedPatch.tracking).not.toHaveProperty('token');

  const get = await request(app).get('/api/admin/email/settings');
  expect(JSON.stringify(get.body)).not.toContain('SECRETTOKEN');
  expect(JSON.stringify(get.body)).not.toContain('tokenEnc');
  expect(get.body.message.tracking.tokenSet).toBe(true);
});

test('PUT without a token preserves the stored tokenEnc', async () => {
  await request(app).put('/api/admin/email/settings')
    .send({ provider: 'smtp', tracking: { enabled: false, host: 'cp2', port: 2083, user: 'acct', tlsVerify: false } });
  const savedPatch = saveEmailSettings.mock.calls.at(-1)[0];
  expect(savedPatch.tracking).not.toHaveProperty('tokenEnc');
});
```

New file `tests/server/routes/adminTrackingTest.test.js`: mock
`cpanelDeliveryPoller.searchEmailTrack` (jest.mock the module), mount `testTracking`,
assert `{ ok: true, rows: 2 }` on success and `{ ok: false, error }` when the search
throws — modeled directly on `adminEmailSettings.test.js`'s express+supertest harness.

- [ ] **Step 2: Run to verify both fail**

- [ ] **Step 3: Implement**

`server/dist/models/emailSettings.js`:

```js
const trackingSchema = new Schema({
    enabled:   { type: Boolean, default: false },
    host:      { type: String },
    port:      { type: Number, default: 2083 },
    user:      { type: String },
    tokenEnc:  { type: String },   // secretBox token; never returned by APIs
    tlsVerify: { type: Boolean, default: true }
}, { _id: false });

// emailSettingsSchema: add
    tracking:   { type: trackingSchema, default: () => ({}) },

// saveEmailSettings: after the smtp deep-set line, add
    if (patch.tracking) for (const [k, v] of Object.entries(patch.tracking)) set[`tracking.${k}`] = v;
```

`server/dist/controllers/emailAdminController.js`:

```js
// publicSettings(): compute tokenInvalid like passwordInvalid, and add to the return:
        tracking: {
            enabled: Boolean(t.enabled), host: t.host || '', port: t.port || 2083,
            user: t.user || '', tlsVerify: t.tlsVerify !== false,
            tokenSet: Boolean(t.tokenEnc), tokenInvalid
        },
// (const t = (doc && doc.tracking) || {}; tokenInvalid via try { decryptSecret(t.tokenEnc) } catch)

// putSettings(): after the smtp block:
    if (body.tracking) {
        const t = body.tracking;
        patch.tracking = {
            enabled: Boolean(t.enabled), host: t.host, port: t.port,
            user: t.user, tlsVerify: t.tlsVerify !== false
        };
        if (typeof t.token === 'string' && t.token.length > 0) {
            patch.tracking.tokenEnc = encryptSecret(t.token);
        }
    }

// new handler:
const testTracking = (req, res) => handleRequest(res, async () => {
    const doc = await loadEmailSettings();
    const t = doc && doc.tracking;
    if (!t || !t.host || !t.user || !t.tokenEnc) {
        return { message: { ok: false, error: 'tracking is not fully configured' } };
    }
    const { searchEmailTrack } = require('../lib/cpanelDeliveryPoller');
    try {
        const rows = await searchEmailTrack(t);
        recordAudit(req, { action: 'email-tracking-test', targetType: 'emailSettings', targetId: 'singleton', targetLabel: t.host, details: `rows=${rows.length}` });
        return { message: { ok: true, rows: rows.length } };
    } catch (err) {
        return { message: { ok: false, error: err.message } };
    }
}, 'admin: testEmailTracking');
// export testTracking
```

`server/dist/routes/adminRoutes.js` (next to the other email routes):

```js
router.post('/email/tracking/test', testTracking);
```

(add `testTracking` to the controller destructuring import at the top.)

- [ ] **Step 4: Run** `npx jest tests/server/routes/` — all green.

- [ ] **Step 5: Commit**

```bash
git add server/dist/models/emailSettings.js server/dist/controllers/emailAdminController.js server/dist/routes/adminRoutes.js tests/server/routes/adminEmailSettings.test.js tests/server/routes/adminTrackingTest.test.js
git commit -m "feat(admin): delivery-tracking settings — encrypted write-only token + test endpoint"
```

---

### Task 6: server.js wiring + configLib env override

**Files:**
- Modify: `server/dist/server.js` (below the scheduledNetStarter block, mirror its shape)
- Modify: `server/dist/lib/configLib.js` (env override, mirror `SCHEDULED_NET_STARTER_ENABLED` at line ~75)
- Modify: `.env.example` (document the new toggle)

**Interfaces:**
- Consumes: `pollOnce`, `shouldPoll` (Task 3); `conf.background_tasks` convention.
- Produces: a 5-minute interval that is a cheap no-op unless provider=smtp + tracking
  enabled (the runtime check lives inside `pollOnce`, so admin changes apply without
  restart).

- [ ] **Step 1: configLib override** (after the SCHEDULED_NET_STARTER block):

```js
if (process.env.CPANEL_DELIVERY_POLLER_ENABLED !== undefined) {
    _.set(conf, 'background_tasks.cpanelDeliveryPoller.enabled', process.env.CPANEL_DELIVERY_POLLER_ENABLED === 'true');
}
```

- [ ] **Step 2: server.js** (immediately after the scheduledNetStarter else-block):

```js
// cPanel delivery-tracking poller — advances SMTP EmailLog rows using cPanel's
// Track Delivery data every 5 minutes. Cheap no-op unless the admin enabled
// tracking AND the provider is smtp (checked per tick inside pollOnce, so
// admin-UI changes apply without a restart). Kill switch:
// CPANEL_DELIVERY_POLLER_ENABLED=false in .env.
if (conf.background_tasks?.cpanelDeliveryPoller?.enabled !== false) {
    const { pollOnce } = require('./lib/cpanelDeliveryPoller');
    setInterval(() => {
        pollOnce().catch(err => {
            const { logger } = require('./lib/logger');
            logger.error(`cpanelDeliveryPoller interval error: ${err.message}`);
        });
    }, 5 * 60_000);
} else {
    logger.warn('cpanelDeliveryPoller disabled by config — delivery tracking interval not started');
}
```

- [ ] **Step 3: .env.example** — next to `SCHEDULED_NET_STARTER_ENABLED`:

```
# Disable the cPanel delivery-tracking poller (SMTP delivery/bounce status).
# Configure it in Admin → Email Settings → Delivery Tracking. Default: enabled
# (it is a no-op until tracking is configured and the provider is smtp).
# CPANEL_DELIVERY_POLLER_ENABLED=false
```

- [ ] **Step 4: Boot smoke test** — `node -e "require('./server/dist/lib/cpanelDeliveryPoller')"`
  (module loads standalone) and run the full suite: `npx jest`.

- [ ] **Step 5: Commit**

```bash
git add server/dist/server.js server/dist/lib/configLib.js .env.example
git commit -m "feat(email): start cPanel delivery poller on a gated 5-minute interval"
```

---

### Task 7: Admin UI — Delivery Tracking card

**Files:**
- Modify: `server/dist/views/admin.ejs` (new card inside the Email Settings panel,
  after the SMTP fields block; follow the existing `smtp-fields` markup/classes)
- Modify: `client/src/public/js/byView/admin/emailSettings.ts`
- Rebuild: `npx tsc -p client/tsconfig.json` → commit the four
  `client/dist/public/js/byView/admin/emailSettings.*` outputs
- Test: `tests/client/lib/` — only if a pure helper emerges; the card is DOM wiring
  verified on staging

**Interfaces:**
- Consumes: `GET/PUT /api/admin/email/settings` `tracking` shape (Task 5),
  `POST /api/admin/email/tracking/test`, existing helpers `el/qs/setVal/val/showStatus`,
  `api()` and `apiErrorMessage()`.
- Produces: admin-visible config for everything in the `tracking` sub-doc.

- [ ] **Step 1: admin.ejs** — inside the Email Settings panel, after the `smtp-fields`
  wrapper (ids must match the TS below):

```html
<div id="tracking-fields" class="mt-3 border-top pt-3">
  <h6>Delivery Tracking (cPanel Track Delivery)</h6>
  <p class="text-muted small mb-2">
    Polls your cPanel server every 5 minutes and fills in delivered / bounced status
    for SMTP sends. Create a user-level API token in cPanel → Security → Manage API
    Tokens on the account that owns the sending domain.
  </p>
  <form id="email-tracking-form">
    <div class="form-check mb-2">
      <input class="form-check-input" type="checkbox" name="trackingEnabled" id="tracking-enabled">
      <label class="form-check-label" for="tracking-enabled">Enable delivery tracking</label>
    </div>
    <div class="row g-2">
      <div class="col-md-5"><label class="form-label">cPanel host</label>
        <input class="form-control" name="trackingHost" placeholder="cpanel03.example.com"></div>
      <div class="col-md-2"><label class="form-label">Port</label>
        <input class="form-control" name="trackingPort" type="number" value="2083"></div>
      <div class="col-md-5"><label class="form-label">cPanel user</label>
        <input class="form-control" name="trackingUser"></div>
    </div>
    <div class="row g-2 mt-1">
      <div class="col-md-7"><label class="form-label">API token</label>
        <input class="form-control" name="trackingToken" type="password" autocomplete="new-password">
        <div class="form-text" id="tracking-token-status"></div></div>
      <div class="col-md-5 d-flex align-items-end">
        <div class="form-check">
          <input class="form-check-input" type="checkbox" name="trackingTlsVerify" id="tracking-tls" checked>
          <label class="form-check-label" for="tracking-tls">Verify TLS certificate</label>
        </div>
      </div>
    </div>
    <div class="mt-2">
      <button class="btn btn-sm btn-primary" type="submit">Save tracking</button>
      <button class="btn btn-sm btn-outline-secondary" type="button" id="tracking-test-btn">Test connection</button>
      <span class="ms-2 small" id="tracking-status"></span>
    </div>
  </form>
</div>
```

- [ ] **Step 2: emailSettings.ts** — extend the interfaces and `initProviderSection`:

```ts
interface TrackingConfig {
    enabled?: boolean; host?: string; port?: number; user?: string;
    tlsVerify?: boolean; tokenSet?: boolean; tokenInvalid?: boolean;
}
// EmailSettingsResponse gains: tracking?: TrackingConfig;

function fillTracking(t: TrackingConfig): void {
    const en = qs<HTMLInputElement>('[name=trackingEnabled]');
    if (en) en.checked = t.enabled ?? false;
    setVal('trackingHost', t.host ?? '');
    setVal('trackingPort', t.port ?? 2083);
    setVal('trackingUser', t.user ?? '');
    const tls = qs<HTMLInputElement>('[name=trackingTlsVerify]');
    if (tls) tls.checked = t.tlsVerify !== false;
    const st = el('tracking-token-status');
    if (st) {
        st.textContent = t.tokenInvalid
            ? '⚠ stored token can no longer be decrypted (encryption key changed) — re-enter it'
            : t.tokenSet ? 'token is set' : 'no token set';
    }
}

// in initProviderSection(), after toggleSmtpFields(...): fillTracking(settings.tracking ?? {});
// visibility: show #tracking-fields only when provider === 'smtp' — extend toggleSmtpFields:
//   const tf = el('tracking-fields'); if (tf) tf.hidden = provider !== 'smtp';

// submit handler (next to the provider form handler):
el('email-tracking-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const token = val(f, 'trackingToken');
    const tracking: Record<string, unknown> = {
        enabled: qs<HTMLInputElement>('[name=trackingEnabled]', f)?.checked ?? false,
        host: val(f, 'trackingHost'),
        port: Number(val(f, 'trackingPort')) || 2083,
        user: val(f, 'trackingUser'),
        tlsVerify: qs<HTMLInputElement>('[name=trackingTlsVerify]', f)?.checked ?? true,
    };
    if (token) tracking['token'] = token;
    try {
        const s = await api('/settings', { method: 'PUT', body: JSON.stringify({ tracking }) }) as EmailSettingsResponse;
        showStatus('tracking-status', 'Saved.');
        const tokEl = qs<HTMLInputElement>('[name=trackingToken]', f);
        if (tokEl) tokEl.value = '';
        fillTracking(s.tracking ?? {});
    } catch (err) {
        showStatus('tracking-status', `Error: ${(err as Error).message}`);
    }
});

// test button:
el('tracking-test-btn')?.addEventListener('click', async () => {
    showStatus('tracking-status', 'Testing…');
    try {
        const r = await api('/tracking/test', { method: 'POST', body: '{}' }) as { ok?: boolean; rows?: number; error?: string };
        showStatus('tracking-status', r.ok ? `OK — ${r.rows} tracked deliveries visible` : `Failed: ${r.error ?? 'unknown'}`);
    } catch (err) {
        showStatus('tracking-status', `Error: ${(err as Error).message}`);
    }
});
```

- [ ] **Step 3: Client-only rebuild + client tests**

Run: `npx tsc -p client/tsconfig.json && npx jest tests/client`
Expected: compiles clean; only `client/dist/public/js/byView/admin/emailSettings.*` change
(`git status --short` to confirm no other dist churn).

- [ ] **Step 4: Commit**

```bash
git add server/dist/views/admin.ejs client/src/public/js/byView/admin/emailSettings.ts client/dist/public/js/byView/admin/emailSettings.js client/dist/public/js/byView/admin/emailSettings.js.map client/dist/public/js/byView/admin/emailSettings.d.ts client/dist/public/js/byView/admin/emailSettings.d.ts.map
git commit -m "feat(admin): Delivery Tracking card — cPanel host/user/token config + test connection"
```

---

### Task 8: Docs + full verification

**Files:**
- Modify: `PATCHES.md` (extend the in-house email entry: new
  `server/dist/lib/cpanelDeliveryPoller.js`, the emailSettings/controller/routes/server.js/
  configLib/admin.ejs modifications, the client files, the new env toggle; note the
  API-2-not-UAPI gotcha and the `success=1&defer=1&failure=1&inprogress=1` flag requirement)
- Modify: `docs/DEPLOY.md` — note: no new npm deps for this feature; deploy is
  reset+restart only
- Test: full suite

- [ ] **Step 1:** Write the PATCHES.md addition (follow the existing entry's format).
- [ ] **Step 2:** `npx jest` — all suites green.
- [ ] **Step 3:** Commit:

```bash
git add PATCHES.md docs/DEPLOY.md
git commit -m "docs: catalog cPanel delivery-tracking divergences in PATCHES.md"
```

---

### Task 9: Staging validation (user-assisted — not a subagent task)

1. Push `feat/inhouse-email` / fast-forward `staging`; deploy to LXC 204
   (`fetch` → `reset --hard origin/staging` → `systemctl restart hamlive` — **no npm install
   needed**, no new deps).
2. **Rotate the cPanel API token** (the spike token was pasted into chat), create the new
   one on the account that owns the sending domain.
3. Admin → Email Settings → Delivery Tracking: enter host/user/token, enable, **Test
   connection** (expect `OK — N tracked deliveries visible`).
4. Send a test email → within ~5 min the admin email lookup should show `delivered`.
5. Send to a nonexistent mailbox at a real domain → expect `bounce` with a reason.
6. Confirm the SendGrid path is untouched (flip provider to sendgrid if configured; webhook
   tests already cover it).
