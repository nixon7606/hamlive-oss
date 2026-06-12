# Admin Email UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a searchable per-recipient email delivery timeline in the admin panel (the "research why they didn't get it" view).

**Architecture:** A superUser-gated `GET /api/admin/email?recipient=` endpoint returns that recipient's `emailLog` rows plus their `emailEvent` rows. A new "Email" tab in the admin panel searches by address and renders each send with its color-coded event timeline. Client JS uses event delegation / `addEventListener` only (CSP `script-src-attr 'none'` forbids inline handlers).

**Tech Stack:** Node/Express, Mongoose 6, EJS, TypeScript (client compiled to dist), Jest + Supertest + `mongodb-memory-server`, Bootstrap 5.

**Scope:** Phase 3 of `docs/superpowers/specs/2026-06-12-admin-email-observability-and-management-design.md`. Builds on the already-merged email-capture foundation (`emailLog`, `emailEvent` models). Resend, suppression, and the hardening QoL are later plans. The user→email-history link is deferred to the resend plan.

---

### Task 1: Email activity search endpoint

**Files:**
- Modify: `server/dist/controllers/adminController.js` (add `listEmailActivity`, export it)
- Modify: `server/dist/routes/adminRoutes.js` (register the route under the existing superUser gate)
- Test: `tests/server/routes/adminEmail.test.js`

**Context:** Existing admin controllers wrap logic in `handleRequest(res, async () => ({ message: data }), 'label')` (the response body is `{ message: data, ... }`). `adminRoutes.js` already applies `router.use(authCheck(REQ_LOGIN), superAdminCheck)` to every route, so simply registering `/email` there makes it superUser-gated — do not re-implement auth. The test mounts the controller on a bare app to verify data logic; the shared gate is structural and not re-tested here.

- [ ] **Step 1: Write the failing test** (`tests/server/routes/adminEmail.test.js`)

```js
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { emailLogSchema } = require('../../../server/dist/models/emailLog');
const { emailEventSchema } = require('../../../server/dist/models/emailEvent');
const { listEmailActivity } = require('../../../server/dist/controllers/adminController');

const EmailLog = mongoose.models.EmailLog || mongoose.model('EmailLog', emailLogSchema);
const EmailEvent = mongoose.models.EmailEvent || mongoose.model('EmailEvent', emailEventSchema);
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-adminemail';

const app = express();
app.get('/api/admin/email', listEmailActivity);

beforeAll(async () => { await mongoose.connect(MONGO_URI); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await EmailLog.deleteMany({}); await EmailEvent.deleteMany({}); });

test('returns logs and their events for a recipient (case-insensitive)', async () => {
  await EmailLog.create({ recipient: 'user@x.com', type: 'magic-login', subject: 'Sign in', batchId: 'b1', sgMessageId: 'M1', status: 'delivered' });
  await EmailEvent.create({ sgEventId: 'e1', batchId: 'b1', email: 'user@x.com', event: 'delivered', timestamp: new Date() });
  const res = await request(app).get('/api/admin/email').query({ recipient: 'USER@x.com' });
  expect(res.status).toBe(200);
  expect(res.body.message.logs).toHaveLength(1);
  expect(res.body.message.logs[0].sgMessageId).toBe('M1');
  expect(res.body.message.events).toHaveLength(1);
  expect(res.body.message.events[0].event).toBe('delivered');
});

test('blank recipient returns empty result', async () => {
  const res = await request(app).get('/api/admin/email');
  expect(res.status).toBe(200);
  expect(res.body.message.logs).toEqual([]);
  expect(res.body.message.events).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/routes/adminEmail.test.js`
Expected: FAIL — `listEmailActivity` is `undefined` / not a function.

- [ ] **Step 3: Implement the controller**

In `server/dist/controllers/adminController.js`, add requires near the top (with the other model requires):
```js
const { getEmailLog } = require('../models/emailLog');
const { getEmailEvent } = require('../models/emailEvent');
```
Add the controller (follow the existing `listUsers` style):
```js
/**
 * GET /api/admin/email?recipient=<email> — delivery log + events for one recipient
 */
const listEmailActivity = async (req, res) => {
    handleRequest(res, async () => {
        const recipient = String(req.query.recipient || '').trim();
        if (!recipient) return { message: { logs: [], events: [] } };
        const EmailLog = getEmailLog();
        const EmailEvent = getEmailEvent();
        // Case-insensitive exact match; escape regex metacharacters in user input.
        const escaped = recipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = new RegExp('^' + escaped + '$', 'i');
        const logs = await EmailLog.find({ recipient: rx }).sort({ createdAt: -1 }).limit(100).lean();
        const batchIds = logs.map(l => l.batchId).filter(Boolean);
        const events = await EmailEvent.find({ batchId: { $in: batchIds } }).sort({ timestamp: 1 }).lean();
        return { message: { logs, events } };
    }, 'admin: listEmailActivity');
};
```
Add `listEmailActivity` to the file's `module.exports` (it exports the controllers as a named object — add it alongside `listUsers`, `updateUser`, etc.).

- [ ] **Step 4: Register the route** in `server/dist/routes/adminRoutes.js`

Add `listEmailActivity` to the destructured import from `../controllers/adminController`, and add the route line with the others:
```js
router.get('/email', listEmailActivity);
```
(It sits under the existing `router.use(authCheck(REQ_LOGIN), superAdminCheck)`, so it is superUser-gated automatically.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/server/routes/adminEmail.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Confirm no regressions + gate wiring**

Run: `npx jest` — green except the known pre-existing `localChat uploadImage` failure.
Confirm by reading `adminRoutes.js` that `/email` is below the `router.use(...superAdminCheck)` line (gated).

- [ ] **Step 7: Commit**

```bash
git add server/dist/controllers/adminController.js server/dist/routes/adminRoutes.js tests/server/routes/adminEmail.test.js
git commit -m "feat(admin): email activity lookup endpoint (superUser)"
```

---

### Task 2: Admin Email tab UI

**Files:**
- Modify: `server/dist/views/admin.ejs` (tab button + panel)
- Modify: `client/src/public/js/byView/admin/main.ts` (search + render; recompiles to `client/dist/public/js/byView/admin/main.js`)

**Context:** `admin.ejs` has `<ul class="nav app-tabs" id="adminTabs">` with `users-tab`/`nets-tab` buttons (each `data-bs-toggle="tab" data-bs-target="#..."`) and a `.tab-content` with `#users-panel`/`#nets-panel`. The TS file already has helpers `esc(s)`, `statusMsg(...)`, the `API` constant (`/api/admin`), and a `DOMContentLoaded` block where listeners are attached with `addEventListener` (NOT inline `onclick` — required by CSP). There is no client test harness; verify behaviorally.

- [ ] **Step 1: Add the Email tab button** in `admin.ejs`, immediately after the `nets-tab` `<li>` (inside `#adminTabs`):

```html
        <li class="nav-item" role="presentation">
          <button class="nav-link" id="email-tab" data-bs-toggle="tab" data-bs-target="#email-panel" type="button" role="tab"><i class="bi bi-envelope"></i> Email</button>
        </li>
```

- [ ] **Step 2: Add the Email panel** in `admin.ejs`, immediately after the `#nets-panel` `</div>` that closes the nets tab-pane (still inside `.tab-content`):

```html
      <div class="tab-pane fade" id="email-panel" role="tabpanel">
        <div class="app-card">
          <div class="app-card-header"><i class="bi bi-envelope"></i> Email Delivery Lookup</div>
          <div class="d-flex gap-2 mb-3" style="max-width: 520px;">
            <input type="email" class="app-input flex-grow-1" id="email-search-input" placeholder="recipient@example.com" />
            <button class="app-btn app-btn-primary" id="email-search-btn" type="button">Search</button>
          </div>
          <div id="email-results"></div>
        </div>
      </div>
```

- [ ] **Step 3: Add the render logic + wiring** in `client/src/public/js/byView/admin/main.ts`

Add this function near the other `load*` functions (e.g., after `loadNets`):
```ts
const EVENT_COLORS: Record<string, string> = {
    delivered: 'success', open: 'info', click: 'info',
    bounce: 'danger', dropped: 'danger', spamreport: 'danger', blocked: 'danger',
    deferred: 'warning', processed: 'secondary', queued: 'secondary'
};

async function loadEmailActivity(recipient: string) {
    const box = document.getElementById('email-results');
    if (!box) return;
    if (!recipient) { box.innerHTML = '<p class="text-muted">Enter an email address to look up.</p>'; return; }
    box.innerHTML = '<p class="text-muted">Loading…</p>';
    try {
        const res = await fetch(`${API}/email?recipient=${encodeURIComponent(recipient)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const logs = (data.message && data.message.logs) || [];
        const events = (data.message && data.message.events) || [];
        if (logs.length === 0) { box.innerHTML = `<p class="text-muted">No emails found for ${esc(recipient)}.</p>`; return; }
        const byBatch: Record<string, any[]> = {};
        for (const ev of events) { (byBatch[ev.batchId] = byBatch[ev.batchId] || []).push(ev); }
        box.innerHTML = logs.map((l: any) => {
            const evs = (byBatch[l.batchId] || []).map((ev: any) => {
                const color = EVENT_COLORS[ev.event] || 'secondary';
                const when = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : '';
                return `<div class="small mb-1"><span class="badge bg-${color}">${esc(ev.event)}</span> <span class="text-muted">${when}</span>${ev.reason ? ' — ' + esc(ev.reason) : ''}</div>`;
            }).join('') || '<div class="small text-muted">No delivery events recorded yet.</div>';
            const sent = l.createdAt ? new Date(l.createdAt).toLocaleString() : '';
            return `<div class="app-card mb-2">
                <div><strong>${esc(l.subject || l.type)}</strong> <span class="text-muted small">(${esc(l.type)})</span></div>
                <div class="small text-muted">Sent ${sent} · status: ${esc(l.status)}${l.sgMessageId ? ' · id ' + esc(l.sgMessageId) : ''}</div>
                <div class="mt-2">${evs}</div>
            </div>`;
        }).join('');
    } catch (err) {
        box.innerHTML = `<p class="text-danger">Error: ${esc((err as Error).message)}</p>`;
    }
}
```
Inside the existing `document.addEventListener('DOMContentLoaded', () => { ... })` block, add (CSP-safe `addEventListener`, no inline handlers):
```ts
    document.getElementById('email-search-btn')?.addEventListener('click', () => {
        const v = (document.getElementById('email-search-input') as HTMLInputElement).value.trim();
        loadEmailActivity(v);
    });
    document.getElementById('email-search-input')?.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
            loadEmailActivity((e.target as HTMLInputElement).value.trim());
        }
    });
```

- [ ] **Step 4: Recompile the client TypeScript**

Run: `npx tsc -p client/tsconfig.json`
Expected: exit 0, no errors.

- [ ] **Step 5: Verify the compiled output**

Run: `grep -c "loadEmailActivity\|email-results\|email-search-btn" client/dist/public/js/byView/admin/main.js`
Expected: a non-zero count (the new logic is present in dist).
Run: `grep -c "onclick=" client/dist/public/js/byView/admin/main.js`
Expected: `0` (still no inline handlers — CSP-safe).

- [ ] **Step 6: Behavioral check (no client test harness exists)**

With the dev server running and logged in as a superUser (magic-link login, then set `superUser:true` if needed), open `/views/admin`, click the **Email** tab, type a recipient that has received mail, and confirm the timeline renders. If running headless, confirm at minimum that `curl -s 'http://localhost:3000/api/admin/email?recipient=<addr>'` behind an authed superUser session returns `{ message: { logs, events } }`. Note in your report exactly what you verified.

- [ ] **Step 7: Commit (source + compiled dist + view)**

```bash
git add server/dist/views/admin.ejs client/src/public/js/byView/admin/main.ts client/dist/public/js/byView/admin/main.js client/dist/public/js/byView/admin/main.js.map client/dist/public/js/byView/admin/main.d.ts client/dist/public/js/byView/admin/main.d.ts.map
git commit -m "feat(admin): Email tab — per-recipient delivery timeline"
```

---

## Self-Review

**Spec coverage (Phase 3):** superUser-gated `GET /api/admin/email?recipient=` returning logs+events (Task 1) ✓; Email tab with search + color-coded per-send event timeline (Task 2) ✓; CSP-safe client JS via `addEventListener` (Task 2, verified by the `onclick=` count = 0) ✓. Suppression banner, resend button, and user→email-history link are explicitly out of scope (later plans).

**Type/name consistency:** endpoint path `/api/admin/email` and response shape `{ message: { logs, events } }` match between Task 1 (controller) and Task 2 (`loadEmailActivity` reads `data.message.logs`/`.events`). Events grouped by `batchId`, which both the `emailLog` and `emailEvent` documents carry (from the foundation plan). `esc`/`API` reused from the existing file. Element IDs (`email-panel`, `email-results`, `email-search-input`, `email-search-btn`) match between the EJS (Task 2 steps 1–2) and the TS wiring (step 3).

**Deploy note:** Task 2 changes compiled JS + EJS only (no new dependency), so deploying this is a `git pull` + Cloudflare purge of `/js/byView/admin/main.js` + a service restart (EJS template change). No `npm install` needed.
