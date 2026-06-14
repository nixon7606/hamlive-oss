# Email Lookup by Callsign + Recent-Sends Browse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin diagnose "they didn't get the email" when they only have a **callsign** (resolve callsign → that user's email → delivery timeline + resend), and browse/export **all sends in a time window** as a fallback when no identifier resolves.

**Architecture:** Extend the existing `GET /api/admin/email` lookup to accept an email *or* a callsign (resolve via `UserProfile.callSign`). Add `GET /api/admin/email/recent` for a time-windowed list of `emailLog` rows (JSON + CSV). Both are read-only superUser endpoints reusing the already-captured `emailLog`/`emailEvents` data. UI lives in the existing Email tab; client wiring is event-delegation only (CSP `script-src-attr 'none'`).

**Tech Stack:** Node/Express, Mongoose 6, EJS, TypeScript (client→dist), Jest + Supertest + `mongodb-memory-server`.

**Context:** Builds on the email observability + actions work already on `staging`. New, user-driven (not in the original spec). Resend/suppression buttons already exist and work once an email is resolved.

---

### Task 1: Callsign-aware email lookup

**Files:**
- Modify: `server/dist/controllers/adminController.js` (`listEmailActivity`)
- Test: `tests/server/routes/adminEmailCallsign.test.js`

**Context:** Current `listEmailActivity` reads `req.query.recipient`, regex-matches `emailLog.recipient`, joins events by `batchId`, and calls `getSuppressions(recipient)`. Enhance it: if the input has no `@`, treat it as a callsign → look up `UserProfile` by `callSign` (case-insensitive, escaped) → use that user's email for all downstream queries; include a `resolved` object (`{ callSign, email }`) so the UI can confirm the match; if no user matches, return empty with `resolved: null` and `notFound: 'callsign'`. When the input *is* an email, behave exactly as today (plus `resolved: null`). `getUserProfile` is already required at the top of the controller.

- [ ] **Step 1: Write the failing test** (`tests/server/routes/adminEmailCallsign.test.js`)

```js
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { emailLogSchema } = require('../../../server/dist/models/emailLog');
const { emailEventSchema } = require('../../../server/dist/models/emailEvent');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/lib/sendgridSuppression', () => ({ getSuppressions: async () => [], removeSuppression: async () => {}, LISTS: [] }));

const EmailLog = mongoose.models.EmailLog || mongoose.model('EmailLog', emailLogSchema);
mongoose.models.EmailEvent || mongoose.model('EmailEvent', emailEventSchema);
const { listEmailActivity } = require('../../../server/dist/controllers/adminController');
const { getUserProfile } = require('../../../server/dist/models/userProfile');

const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-emailcallsign';
const app = express();
app.get('/api/admin/email', listEmailActivity);

beforeAll(async () => { await mongoose.connect(MONGO_URI); getUserProfile(); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => {
  await EmailLog.deleteMany({});
  await mongoose.connection.db.collection('userprofiles').deleteMany({});
});

test('resolves a callsign to the user email and returns that mail', async () => {
  await mongoose.connection.db.collection('userprofiles').insertOne({ callSign: 'KC0XYZ', email: 'op@example.com' });
  await EmailLog.create({ recipient: 'op@example.com', type: 'magic-login', subject: 'Sign in', batchId: 'b1', status: 'delivered' });
  const res = await request(app).get('/api/admin/email').query({ recipient: 'kc0xyz' }); // lowercase → case-insensitive
  expect(res.status).toBe(200);
  expect(res.body.message.resolved).toEqual({ callSign: 'KC0XYZ', email: 'op@example.com' });
  expect(res.body.message.logs).toHaveLength(1);
});

test('unknown callsign returns empty with notFound', async () => {
  const res = await request(app).get('/api/admin/email').query({ recipient: 'NOPE1' });
  expect(res.status).toBe(200);
  expect(res.body.message.logs).toEqual([]);
  expect(res.body.message.resolved).toBeNull();
  expect(res.body.message.notFound).toBe('callsign');
});

test('an email input still works directly (resolved null)', async () => {
  await EmailLog.create({ recipient: 'direct@example.com', type: 'magic-login', subject: 's', batchId: 'b2', status: 'queued' });
  const res = await request(app).get('/api/admin/email').query({ recipient: 'DIRECT@example.com' });
  expect(res.body.message.logs).toHaveLength(1);
  expect(res.body.message.resolved).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/routes/adminEmailCallsign.test.js`
Expected: FAIL — `resolved` is undefined / callsign not resolved.

- [ ] **Step 3: Implement** — replace the body of `listEmailActivity` in `adminController.js` with:

```js
const listEmailActivity = async (req, res) => {
    handleRequest(res, async () => {
        const input = String(req.query.recipient || '').trim();
        if (!input) return { message: { logs: [], events: [], suppressions: [], resolved: null } };

        let email = input;
        let resolved = null;
        if (!input.includes('@')) {
            // Treat as a callsign → resolve to the user's email.
            const UserProfile = getUserProfile();
            const csEscaped = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const user = await UserProfile.findOne({ callSign: new RegExp('^' + csEscaped + '$', 'i') })
                .select('callSign email').lean();
            if (!user) {
                return { message: { logs: [], events: [], suppressions: [], resolved: null, notFound: 'callsign' } };
            }
            email = user.email;
            resolved = { callSign: user.callSign, email: user.email };
        }

        const EmailLog = getEmailLog();
        const EmailEvent = getEmailEvent();
        const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = new RegExp('^' + escaped + '$', 'i');
        const logs = await EmailLog.find({ recipient: rx }).sort({ createdAt: -1 }).limit(100).lean();
        const batchIds = logs.map(l => l.batchId).filter(Boolean);
        const events = await EmailEvent.find({ batchId: { $in: batchIds } }).sort({ timestamp: 1 }).lean();
        const suppressions = await getSuppressions(email);
        return { message: { logs, events, suppressions, resolved } };
    }, 'admin: listEmailActivity');
};
```
(Note: suppressions now uses the resolved `email`, not the raw input — a correctness fix for the callsign path.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/routes/adminEmailCallsign.test.js` (3 pass)

- [ ] **Step 5: Existing email-search test still passes**

Run: `npx jest tests/server/routes/adminEmail.test.js` (still 2 pass — the response gains `resolved`/`suppressions` keys but its assertions only check `logs`/`events`).
Run: `npx jest` — green except the pre-existing `localChat uploadImage`.

- [ ] **Step 6: Commit**

```bash
git add server/dist/controllers/adminController.js tests/server/routes/adminEmailCallsign.test.js
git commit -m "feat(admin): resolve callsign to email in delivery lookup"
```

---

### Task 2: Recent-sends endpoint (JSON + CSV)

**Files:**
- Modify: `server/dist/controllers/adminController.js` (add `recentEmails`, export it)
- Modify: `server/dist/routes/adminRoutes.js` (register route)
- Test: `tests/server/routes/adminRecentEmails.test.js`

**Context:** Returns `emailLog` rows whose `createdAt` is in `[from, to]`, newest first, capped at 1000, plus per-status counts. `format=csv` streams a download (bypassing `handleRequest`, which emits JSON). Default window: last 24h.

- [ ] **Step 1: Write the failing test** (`tests/server/routes/adminRecentEmails.test.js`)

```js
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { emailLogSchema } = require('../../../server/dist/models/emailLog');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
const EmailLog = mongoose.models.EmailLog || mongoose.model('EmailLog', emailLogSchema);
const { recentEmails } = require('../../../server/dist/controllers/adminController');
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-recentemails';

const app = express();
app.get('/api/admin/email/recent', recentEmails);

beforeAll(async () => { await mongoose.connect(MONGO_URI); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await EmailLog.deleteMany({}); });

test('returns sends within the window with a status summary (JSON)', async () => {
  const now = Date.now();
  await EmailLog.create({ recipient: 'a@x.com', type: 'magic-login', subject: 's1', batchId: 'b1', status: 'delivered', createdAt: new Date(now - 1000) });
  await EmailLog.create({ recipient: 'b@x.com', type: 'magic-login', subject: 's2', batchId: 'b2', status: 'bounce', createdAt: new Date(now - 2000) });
  await EmailLog.create({ recipient: 'c@x.com', type: 'magic-login', subject: 's3', batchId: 'b3', status: 'delivered', createdAt: new Date(now - 10 * 24 * 3600 * 1000) }); // outside 24h
  const from = new Date(now - 24 * 3600 * 1000).toISOString();
  const to = new Date(now + 1000).toISOString();
  const res = await request(app).get('/api/admin/email/recent').query({ from, to });
  expect(res.status).toBe(200);
  expect(res.body.message.rows).toHaveLength(2);
  expect(res.body.message.rows[0].recipient).toBe('a@x.com'); // newest first
  expect(res.body.message.summary.delivered).toBe(1);
  expect(res.body.message.summary.bounce).toBe(1);
});

test('format=csv returns a CSV download', async () => {
  const now = Date.now();
  await EmailLog.create({ recipient: 'a@x.com', type: 'magic-login', subject: 'Hi, there', batchId: 'b1', status: 'delivered', createdAt: new Date(now - 1000) });
  const res = await request(app).get('/api/admin/email/recent')
    .query({ from: new Date(now - 3600 * 1000).toISOString(), to: new Date(now + 1000).toISOString(), format: 'csv' });
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/csv/);
  expect(res.text).toMatch(/recipient,type,subject,status/);
  expect(res.text).toMatch(/a@x.com/);
  expect(res.text).toMatch(/"Hi, there"/); // comma-containing field quoted
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/routes/adminRecentEmails.test.js`
Expected: FAIL — `recentEmails` undefined.

- [ ] **Step 3: Implement** in `adminController.js`. Add a tiny CSV helper near the top (after requires):

```js
function toCsv(rows) {
    const cols = ['createdAt', 'recipient', 'type', 'subject', 'status', 'sgMessageId'];
    const esc = v => {
        const s = v === undefined || v === null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = cols.join(',');
    const lines = rows.map(r => cols.map(c => esc(c === 'createdAt' && r[c] ? new Date(r[c]).toISOString() : r[c])).join(','));
    return [header, ...lines].join('\n');
}
```
Add the controller:
```js
/**
 * GET /api/admin/email/recent?from=<ISO>&to=<ISO>&format=json|csv
 * Sends recorded in the window, newest first (capped), with a status summary.
 */
const recentEmails = async (req, res) => {
    const CAP = 1000;
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 24 * 3600 * 1000);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        return res.status(400).json({ error: 'invalid from/to date' });
    }
    const EmailLog = getEmailLog();
    const found = await EmailLog.find({ createdAt: { $gte: from, $lte: to } })
        .sort({ createdAt: -1 }).limit(CAP + 1).lean();
    const capped = found.length > CAP;
    const rows = found.slice(0, CAP);

    if (req.query.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="email-sends.csv"');
        return res.send(toCsv(rows));
    }
    handleRequest(res, async () => {
        const summary = {};
        for (const r of rows) summary[r.status] = (summary[r.status] || 0) + 1;
        return { message: { rows, summary, capped, count: rows.length } };
    }, 'admin: recentEmails');
};
```
Add `recentEmails` to `module.exports`.

- [ ] **Step 4: Register the route** in `adminRoutes.js` — add `recentEmails` to the destructured import and (under the gate):
```js
router.get('/email/recent', recentEmails);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/server/routes/adminRecentEmails.test.js` (2 pass)
Run: `npx jest` — green except the pre-existing `localChat uploadImage`.

- [ ] **Step 6: Commit**

```bash
git add server/dist/controllers/adminController.js server/dist/routes/adminRoutes.js tests/server/routes/adminRecentEmails.test.js
git commit -m "feat(admin): recent-sends endpoint with status summary + CSV"
```

---

### Task 3: Email tab UI — callsign label/banner + Recent-sends panel

**Files:**
- Modify: `server/dist/views/admin.ejs` (input label/placeholder + Recent-sends section)
- Modify: `client/src/public/js/byView/admin/main.ts` (resolved banner; recent-sends render + CSV; recompiles to dist)

**Context:** `loadEmailActivity` renders `#email-results` and already shows `controls + supHtml + logsHtml`. The response now also has `data.message.resolved` (`{callSign,email}` or null) and possibly `notFound`. The new `recentEmails` endpoint backs a separate panel. All wiring via `addEventListener`/delegation (CSP). Helpers `esc`/`API`/`statusMsg` exist.

- [ ] **Step 1: `admin.ejs` — make the search accept email-or-callsign and add the Recent-sends section.** Replace the `#email-panel` inner card with:

```html
      <div class="tab-pane fade" id="email-panel" role="tabpanel">
        <div class="app-card">
          <div class="app-card-header"><i class="bi bi-envelope"></i> Email Delivery Lookup</div>
          <div class="d-flex gap-2 mb-3" style="max-width: 520px;">
            <input type="text" class="app-input flex-grow-1" id="email-search-input" placeholder="email or callsign" />
            <button class="app-btn app-btn-primary" id="email-search-btn" type="button">Search</button>
          </div>
          <div id="email-results"></div>
        </div>
        <div class="app-card">
          <div class="app-card-header"><i class="bi bi-clock-history"></i> Recent Sends</div>
          <div class="d-flex flex-wrap gap-2 mb-3 align-items-center">
            <button class="app-btn app-btn-sm" data-recent-preset="1">Last 24h</button>
            <button class="app-btn app-btn-sm" data-recent-preset="7">Last 7d</button>
            <button class="app-btn app-btn-sm" data-recent-preset="30">Last 30d</button>
            <span class="text-muted small">or</span>
            <input type="date" class="app-input" id="recent-from" />
            <span class="text-muted small">to</span>
            <input type="date" class="app-input" id="recent-to" />
            <button class="app-btn app-btn-primary app-btn-sm" id="recent-load-btn" type="button">Load</button>
            <button class="app-btn app-btn-sm" id="recent-csv-btn" type="button">Download CSV</button>
          </div>
          <div id="recent-summary" class="small mb-2"></div>
          <div id="recent-results"></div>
        </div>
      </div>
```

- [ ] **Step 2: `main.ts` — show the resolved/notFound banner in `loadEmailActivity`.** Where it builds the populated output (`controls + supHtml + logsHtml`) and the empty branch, incorporate a banner from `data.message`:
   - After parsing `data`, compute:
     ```ts
     const resolved = data.message && data.message.resolved;
     const notFound = data.message && data.message.notFound;
     const banner = resolved
         ? `<div class="small text-secondary mb-2">Showing mail for <strong>${esc(resolved.callSign)}</strong> — ${esc(resolved.email)}</div>`
         : '';
     ```
   - In the **no-logs** branch, if `notFound === 'callsign'`, render: `box.innerHTML = `<p class="text-muted">No account found for callsign “${esc(recipient)}”. Try their email address, or use Recent Sends below.</p>`; return;`
   - In the populated branch, prepend `banner`: `box.innerHTML = banner + controls + supHtml + logsHtml;`

- [ ] **Step 3: `main.ts` — add the Recent-sends renderer + wiring.** Add a function:
```ts
function recentRangeFromControls(presetDays?: number): { from: string; to: string } {
    const to = new Date();
    let from: Date;
    if (presetDays) { from = new Date(Date.now() - presetDays * 24 * 3600 * 1000); }
    else {
        const f = (document.getElementById('recent-from') as HTMLInputElement).value;
        const t = (document.getElementById('recent-to') as HTMLInputElement).value;
        from = f ? new Date(f + 'T00:00:00') : new Date(Date.now() - 24 * 3600 * 1000);
        if (t) to.setTime(new Date(t + 'T23:59:59').getTime());
    }
    return { from: from.toISOString(), to: to.toISOString() };
}

let lastRecentRange = { from: '', to: '' };

async function loadRecentEmails(range: { from: string; to: string }) {
    lastRecentRange = range;
    const box = document.getElementById('recent-results');
    const sum = document.getElementById('recent-summary');
    if (!box || !sum) return;
    box.innerHTML = '<p class="text-muted">Loading…</p>'; sum.innerHTML = '';
    try {
        const res = await fetch(`${API}/email/recent?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const rows = (data.message && data.message.rows) || [];
        const summary = (data.message && data.message.summary) || {};
        const capped = data.message && data.message.capped;
        if (rows.length === 0) { box.innerHTML = '<p class="text-muted">No sends in this window.</p>'; return; }
        sum.innerHTML = `${rows.length} sent` + Object.keys(summary).map(k => ` · ${rows.length && esc(k)}: ${summary[k]}`).join('') + (capped ? ' · <span class="text-warning">(capped at 1000 — narrow the range or use CSV)</span>' : '');
        box.innerHTML = `<table class="table table-dark table-striped table-hover admin-table"><thead><tr>
            <th>Time</th><th>Recipient</th><th>Type</th><th>Subject</th><th>Status</th></tr></thead><tbody>${
            rows.map((r: any) => `<tr>
                <td>${r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}</td>
                <td>${esc(r.recipient)}</td>
                <td>${esc(r.type)}</td>
                <td>${esc(r.subject || '')}</td>
                <td><span class="badge bg-${EVENT_COLORS[r.status] || 'secondary'}">${esc(r.status)}</span></td>
            </tr>`).join('')}</tbody></table>`;
    } catch (err) {
        box.innerHTML = `<p class="text-danger">Error: ${esc((err as Error).message)}</p>`;
    }
}
```
Inside the `DOMContentLoaded` block, add the wiring (delegation for presets; click handlers for load/CSV):
```ts
    const emailPanel = document.getElementById('email-panel');
    emailPanel?.addEventListener('click', (e) => {
        const preset = (e.target as HTMLElement).closest('button[data-recent-preset]') as HTMLButtonElement | null;
        if (preset && emailPanel.contains(preset)) {
            loadRecentEmails(recentRangeFromControls(parseInt(preset.getAttribute('data-recent-preset') as string, 10)));
        }
    });
    document.getElementById('recent-load-btn')?.addEventListener('click', () => loadRecentEmails(recentRangeFromControls()));
    document.getElementById('recent-csv-btn')?.addEventListener('click', () => {
        const range = lastRecentRange.from ? lastRecentRange : recentRangeFromControls();
        window.location.href = `${API}/email/recent?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&format=csv`;
    });
```
(`EVENT_COLORS` already exists in the file from the earlier Email-tab work.)

- [ ] **Step 4: Recompile** — `npx tsc -p client/tsconfig.json` (exit 0).

- [ ] **Step 5: Verify compiled output**

Run: `grep -c "loadRecentEmails\|data-recent-preset\|recent-csv-btn\|resolved" client/dist/public/js/byView/admin/main.js` → expect >0.
Run: `grep -c "onclick=" client/dist/public/js/byView/admin/main.js` → expect `0`.

- [ ] **Step 6: Behavioral check (no client test harness).** Build the static-HTML + `python3 -m http.server` harness (ES modules don't load over `file://`) like prior tasks: include `#email-panel` with the new elements plus the elements `main.js` touches on load; stub `fetch` so `/email?recipient=<callsign>` returns `{message:{logs:[...],events:[],suppressions:[],resolved:{callSign:'KC0XYZ',email:'op@x.com'}}}` and `/email/recent` returns `{message:{rows:[{createdAt:Date.now(),recipient:'a@x.com',type:'magic-login',subject:'s',status:'delivered'}],summary:{delivered:1},capped:false,count:1}}`; click Search and a preset; assert `#email-results` shows "Showing mail for KC0XYZ" and `#recent-results` shows the row + `#recent-summary` shows "1 sent". Report what you verified.

- [ ] **Step 7: Commit (source + compiled dist + view)**

```bash
git add server/dist/views/admin.ejs client/src/public/js/byView/admin/main.ts client/dist/public/js/byView/admin/main.js client/dist/public/js/byView/admin/main.js.map client/dist/public/js/byView/admin/main.d.ts client/dist/public/js/byView/admin/main.d.ts.map
git commit -m "feat(admin): Email tab — callsign banner + Recent Sends browse/CSV"
```

---

## Self-Review

**Coverage:** callsign→email resolution in lookup (Task 1) ✓; recent-sends JSON + CSV with status summary, presets + custom range (Tasks 2 & 3) ✓; CSP-safe UI, callsign placeholder + resolved banner + "no account found" message (Task 3) ✓.

**Type/name consistency:** response keys `resolved`/`notFound` (Task 1) read in Task 3; `rows`/`summary`/`capped` (Task 2) read in Task 3; endpoint paths `/api/admin/email` and `/api/admin/email/recent` consistent between routes (Tasks 1/2) and client (Task 3); `EVENT_COLORS` reused; element IDs (`recent-from/to`, `recent-load-btn`, `recent-csv-btn`, `recent-summary`, `recent-results`, `data-recent-preset`) match between EJS (Task 3 Step 1) and TS (Steps 2–3).

**Edge cases:** invalid from/to → 400; results capped at 1000 with a visible note + CSV for bulk; callsign that matches no user → clear "no account found" message pointing to email or Recent Sends; suppressions query now uses the resolved email (correctness fix).

**Deploy note:** No new dependency. Deploy = `git pull` + restart (server JS + EJS changed) + Cloudflare purge of `/js/byView/admin/main.js`.
