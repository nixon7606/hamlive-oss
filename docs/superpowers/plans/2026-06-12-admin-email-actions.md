# Admin Email Actions (Resend + Suppression) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin *act* on email problems from the Email tab — resend a fresh magic sign-in link, and detect/clear SendGrid suppressions (the usual cause of "I never got it").

**Architecture:** A thin `sendMagicSignInLink(email)` wrapper reuses the existing `magicLogin` strategy (no change to the working login route). A `sendgridSuppression` lib wraps SendGrid's free Suppressions API via the already-bundled `@sendgrid/client`. Two new superUser endpoints (`resend-login`, `unsuppress`) and an enriched `GET /api/admin/email` (now includes suppression status) drive new buttons in the Email tab.

**Tech Stack:** Node/Express, Mongoose 6, `passport-magic-login`, `@sendgrid/client`, EJS, TypeScript (client→dist), Jest + Supertest + `mongodb-memory-server`.

**Scope:** Phase 4 of `docs/superpowers/specs/2026-06-12-admin-email-observability-and-management-design.md`. Net-report resend stays out of scope. Builds on the merged email foundation + Email UI.

**Design note (login safety):** We do NOT modify the existing `/auth/magiclogin` route or the `MagicLoginStrategy` construction — logging in is critical and working. We only ADD an exported helper that calls the same `magicLogin.send(...)` with a synthetic req/res. If a test proves the `authRoutes` module is too entangled to import in isolation, the implementer should report NEEDS_CONTEXT (fallback: extract `magicLogin` into `server/dist/lib/magicAuth.js`).

---

### Task 1: `sendMagicSignInLink(email)` helper

**Files:**
- Modify: `server/dist/routes/authRoutes.js` (add + export the helper; do NOT change the existing route/strategy)
- Test: `tests/server/routes/magicSendHelper.test.js`

**Context:** `magicLogin.send(req, res, next)` reads `req.body.destination`, generates a token, runs the `sendMagicLink` callback (which, when email is disabled, logs the link and sets `req._devMagicLink`), then calls `res.json({...})`. The helper drives that flow with a synthetic req/res and resolves with the dev link (or null when email is enabled). `authRoutes.js` currently ends with `module.exports = router;` — keep that and hang the helper off it.

- [ ] **Step 1: Write the failing test** (`tests/server/routes/magicSendHelper.test.js`)

```js
// Force email "disabled" so the magic-link is returned inline (no real SendGrid call),
// and supply the secret/base_url the strategy needs.
jest.mock('../../../server/dist/lib/configLib', () => ({
  conf: { magic_link_secret: 'test-secret', base_url: 'http://localhost:3000', app_name: 'Ham.Live' }
}));

const authRoutes = require('../../../server/dist/routes/authRoutes');

test('sendMagicSignInLink resolves with a dev magic link when email is disabled', async () => {
  expect(typeof authRoutes.sendMagicSignInLink).toBe('function');
  const result = await authRoutes.sendMagicSignInLink('tester@example.com');
  expect(result.devMagicLink).toMatch(/\/auth\/magiclogin\/callback\?token=/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/routes/magicSendHelper.test.js`
Expected: FAIL — `authRoutes.sendMagicSignInLink` is not a function.
(If it instead fails to LOAD the module — e.g. a Google strategy throws at import because `conf.google_client_id` is undefined — report NEEDS_CONTEXT with the error; we'll guard or extract.)

- [ ] **Step 3: Implement the helper** in `authRoutes.js`

Just above `module.exports = router;`, add:
```js
/**
 * Send a fresh magic sign-in link to an address using the same flow as
 * /auth/magiclogin. Resolves with { devMagicLink } (the link is non-null only
 * when email delivery is disabled, mirroring the login route). For admin resend.
 */
function sendMagicSignInLink(email) {
    return new Promise((resolve, reject) => {
        const req = { body: { destination: email } };
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ devMagicLink: req._devMagicLink || null, ...body }); return this; }
        };
        try {
            magicLogin.send(req, res, err => (err ? reject(err) : resolve({ devMagicLink: req._devMagicLink || null })));
        } catch (err) {
            reject(err);
        }
    });
}
```
Then change the export to keep the router AND expose the helper:
```js
module.exports = router;
module.exports.sendMagicSignInLink = sendMagicSignInLink;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/routes/magicSendHelper.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm login route untouched + no regressions**

Confirm via `git diff` that the existing `/magiclogin` route and the `MagicLoginStrategy` construction are unchanged (only the helper + export line are added).
Run: `npx jest` — green except the known pre-existing `localChat uploadImage` failure.

- [ ] **Step 6: Commit**

```bash
git add server/dist/routes/authRoutes.js tests/server/routes/magicSendHelper.test.js
git commit -m "feat(auth): export sendMagicSignInLink helper (reuses magic-login flow)"
```

---

### Task 2: Resend sign-in link endpoint

**Files:**
- Modify: `server/dist/controllers/adminController.js` (add `resendSignInLink`, export it)
- Modify: `server/dist/routes/adminRoutes.js` (register route)
- Test: `tests/server/routes/adminResend.test.js`

- [ ] **Step 1: Write the failing test** (`tests/server/routes/adminResend.test.js`)

```js
const express = require('express');
const request = require('supertest');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/routes/authRoutes', () => ({
  sendMagicSignInLink: jest.fn(async () => ({ devMagicLink: 'http://localhost:3000/auth/magiclogin/callback?token=x' }))
}));
const { sendMagicSignInLink } = require('../../../server/dist/routes/authRoutes');
const { resendSignInLink } = require('../../../server/dist/controllers/adminController');

const app = express();
app.use(express.json());
app.post('/api/admin/email/resend-login', resendSignInLink);

test('resends a sign-in link to the given email', async () => {
  const res = await request(app).post('/api/admin/email/resend-login').send({ email: 'u@x.com' });
  expect(res.status).toBe(200);
  expect(sendMagicSignInLink).toHaveBeenCalledWith('u@x.com');
  expect(res.body.message.sent).toBe(true);
});

test('rejects a missing email with 400', async () => {
  const res = await request(app).post('/api/admin/email/resend-login').send({});
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/routes/adminResend.test.js`
Expected: FAIL — `resendSignInLink` is undefined.

- [ ] **Step 3: Implement the controller** in `adminController.js`

Add the require near the top:
```js
const { sendMagicSignInLink } = require('../routes/authRoutes');
```
Add the controller:
```js
/**
 * POST /api/admin/email/resend-login { email } — send a fresh magic sign-in link
 */
const resendSignInLink = async (req, res) => {
    const email = (req.body && req.body.email || '').trim();
    if (!email) return res.status(400).json({ error: 'email is required' });
    handleRequest(res, async () => {
        await sendMagicSignInLink(email);
        logger.info(`admin resend sign-in link to ${email}`);
        return { message: { sent: true } };
    }, 'admin: resendSignInLink');
};
```
Add `resendSignInLink` to `module.exports`.

- [ ] **Step 4: Register the route** in `adminRoutes.js`

Add `resendSignInLink` to the destructured import and add (under the gate):
```js
router.post('/email/resend-login', resendSignInLink);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/server/routes/adminResend.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add server/dist/controllers/adminController.js server/dist/routes/adminRoutes.js tests/server/routes/adminResend.test.js
git commit -m "feat(admin): resend sign-in link endpoint (superUser)"
```

---

### Task 3: SendGrid suppression library

**Files:**
- Create: `server/dist/lib/sendgridSuppression.js`
- Test: `tests/server/lib/sendgridSuppression.test.js`

**Context:** SendGrid's Suppressions API (free on all plans) has four relevant lists: `bounces`, `blocks`, `spam_reports`, `invalid_emails`. `GET /v3/suppression/<list>/<email>` returns an array (non-empty ⇒ suppressed); `DELETE /v3/suppression/<list>/<email>` removes it. Uses the bundled `@sendgrid/client` (`client.setApiKey`, `client.request({ method, url })`).

- [ ] **Step 1: Write the failing test** (`tests/server/lib/sendgridSuppression.test.js`)

```js
jest.mock('@sendgrid/client', () => ({ setApiKey: jest.fn(), request: jest.fn() }));
jest.mock('../../../server/dist/lib/configLib', () => ({ conf: { sendgrid_api_key: 'SG.test' } }));
const client = require('@sendgrid/client');
const { getSuppressions, removeSuppression } = require('../../../server/dist/lib/sendgridSuppression');

beforeEach(() => client.request.mockReset());

test('getSuppressions returns the lists an email is on', async () => {
  client.request.mockImplementation(async ({ url }) => {
    if (url.includes('/bounces/')) return [{ statusCode: 200 }, [{ created: 1700000000, email: 'u@x.com', reason: '550 no mailbox' }]];
    return [{ statusCode: 200 }, []]; // blocks, spam_reports, invalid_emails: not suppressed
  });
  const result = await getSuppressions('u@x.com');
  expect(result).toEqual([{ list: 'bounces', reason: '550 no mailbox', created: 1700000000 }]);
});

test('removeSuppression issues a DELETE for the right list+email', async () => {
  client.request.mockResolvedValue([{ statusCode: 204 }, {}]);
  await removeSuppression('u@x.com', 'bounces');
  expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
    method: 'DELETE', url: '/v3/suppression/bounces/u%40x.com'
  }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/lib/sendgridSuppression.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`server/dist/lib/sendgridSuppression.js`)

```js
/* hamlive-oss — MIT License. See LICENSE. */
const client = require('@sendgrid/client');
const { conf } = require('./configLib');
const { logger } = require('./logger');

const LISTS = ['bounces', 'blocks', 'spam_reports', 'invalid_emails'];
let configured = false;
function ensureKey() {
    if (!configured && conf.sendgrid_api_key) { client.setApiKey(conf.sendgrid_api_key); configured = true; }
    return Boolean(conf.sendgrid_api_key);
}

/** Returns [{ list, reason, created }] for every suppression list the email is on. */
async function getSuppressions(email) {
    if (!ensureKey()) return [];
    const results = await Promise.all(LISTS.map(async list => {
        try {
            const [, body] = await client.request({ method: 'GET', url: `/v3/suppression/${list}/${encodeURIComponent(email)}` });
            const entry = Array.isArray(body) && body[0];
            return entry ? { list, reason: entry.reason || null, created: entry.created || null } : null;
        } catch (err) {
            logger.warn(`getSuppressions(${list}) failed: ${err.message}`);
            return null;
        }
    }));
    return results.filter(Boolean);
}

/** Removes the email from one suppression list. */
async function removeSuppression(email, list) {
    if (!ensureKey()) throw new Error('SendGrid not configured');
    if (!LISTS.includes(list)) throw new Error(`unknown suppression list: ${list}`);
    await client.request({ method: 'DELETE', url: `/v3/suppression/${list}/${encodeURIComponent(email)}` });
}

module.exports = { getSuppressions, removeSuppression, LISTS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/lib/sendgridSuppression.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/dist/lib/sendgridSuppression.js tests/server/lib/sendgridSuppression.test.js
git commit -m "feat(email): SendGrid suppression lib (lookup + remove)"
```

---

### Task 4: Suppression in search response + unsuppress endpoint

**Files:**
- Modify: `server/dist/controllers/adminController.js` (`listEmailActivity` adds `suppressions`; add `unsuppressEmail`)
- Modify: `server/dist/routes/adminRoutes.js` (register route)
- Test: `tests/server/routes/adminUnsuppress.test.js`

- [ ] **Step 1: Write the failing test** (`tests/server/routes/adminUnsuppress.test.js`)

```js
const express = require('express');
const request = require('supertest');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/lib/sendgridSuppression', () => ({
  getSuppressions: jest.fn(async () => []),
  removeSuppression: jest.fn(async () => {}),
  LISTS: ['bounces', 'blocks', 'spam_reports', 'invalid_emails']
}));
jest.mock('../../../server/dist/routes/authRoutes', () => ({ sendMagicSignInLink: jest.fn(async () => ({ devMagicLink: null })) }));
const { removeSuppression } = require('../../../server/dist/lib/sendgridSuppression');
const { sendMagicSignInLink } = require('../../../server/dist/routes/authRoutes');
const { unsuppressEmail } = require('../../../server/dist/controllers/adminController');

const app = express();
app.use(express.json());
app.post('/api/admin/email/unsuppress', unsuppressEmail);

test('removes a suppression then resends', async () => {
  const res = await request(app).post('/api/admin/email/unsuppress').send({ email: 'u@x.com', list: 'bounces' });
  expect(res.status).toBe(200);
  expect(removeSuppression).toHaveBeenCalledWith('u@x.com', 'bounces');
  expect(sendMagicSignInLink).toHaveBeenCalledWith('u@x.com');
  expect(res.body.message.removed).toBe(true);
});

test('rejects missing email/list with 400', async () => {
  const res = await request(app).post('/api/admin/email/unsuppress').send({ email: 'u@x.com' });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/routes/adminUnsuppress.test.js`
Expected: FAIL — `unsuppressEmail` undefined.

- [ ] **Step 3: Implement** in `adminController.js`

Add requires near the top:
```js
const { getSuppressions, removeSuppression } = require('../lib/sendgridSuppression');
```
Enrich `listEmailActivity` — after computing `logs`/`events`, look up suppressions for the recipient and include them:
```js
        const suppressions = await getSuppressions(recipient);
        return { message: { logs, events, suppressions } };
```
(Replace the existing `return { message: { logs, events } };` in `listEmailActivity`. `getSuppressions` already returns `[]` when SendGrid isn't configured, so this is safe.)

Add the controller:
```js
/**
 * POST /api/admin/email/unsuppress { email, list } — remove a suppression, then resend
 */
const unsuppressEmail = async (req, res) => {
    const email = (req.body && req.body.email || '').trim();
    const list = req.body && req.body.list;
    if (!email || !list) return res.status(400).json({ error: 'email and list are required' });
    handleRequest(res, async () => {
        await removeSuppression(email, list);
        await sendMagicSignInLink(email);
        logger.info(`admin removed ${list} suppression for ${email} and resent link`);
        return { message: { removed: true } };
    }, 'admin: unsuppressEmail');
};
```
(`sendMagicSignInLink` is already required from Task 2.) Add `unsuppressEmail` to `module.exports`.

- [ ] **Step 4: Register the route** in `adminRoutes.js`

Add `unsuppressEmail` to the destructured import and (under the gate):
```js
router.post('/email/unsuppress', unsuppressEmail);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/server/routes/adminUnsuppress.test.js` (2 pass)
Run: `npx jest tests/server/routes/adminEmail.test.js` — the existing email-search test must still pass; its assertions only check `logs`/`events`, and `getSuppressions` returns `[]` without SendGrid configured, so `suppressions: []` is additive. If that test mocks are insufficient (e.g. it now needs the suppression lib), add `jest.mock('../../../server/dist/lib/sendgridSuppression', () => ({ getSuppressions: async () => [], removeSuppression: async () => {}, LISTS: [] }))` to `adminEmail.test.js`.

- [ ] **Step 6: Full suite + commit**

Run: `npx jest` — green except the pre-existing `localChat uploadImage` failure.
```bash
git add server/dist/controllers/adminController.js server/dist/routes/adminRoutes.js tests/server/routes/adminUnsuppress.test.js tests/server/routes/adminEmail.test.js
git commit -m "feat(admin): suppression status in lookup + unsuppress endpoint"
```

---

### Task 5: Email tab — resend + suppression UI

**Files:**
- Modify: `client/src/public/js/byView/admin/main.ts` (recompiles to dist)

**Context:** `loadEmailActivity` (from the Email UI plan) renders `#email-results` from `data.message.logs/events`. The response now also has `data.message.suppressions` (array of `{ list, reason, created }`). Add a suppression banner + a "Resend sign-in link" button + per-suppression "Remove & resend" buttons. Wiring MUST use event delegation on `#email-results` (CSP `script-src-attr 'none'` forbids inline `onclick`). The file already has `esc`, `API`, `statusMsg`, and a delegated-handler pattern.

- [ ] **Step 1: Track the current looked-up recipient.** Near the top of the file (with other module state), add:
```ts
let currentEmailRecipient = '';
```
In `loadEmailActivity`, set it at the start (after the empty-guard): `currentEmailRecipient = recipient;`

- [ ] **Step 2: Render the banner + buttons** inside `loadEmailActivity`, replacing the success render so it prepends a controls/banner block. After computing `logs`/`events` and building the per-log HTML string (call it `logsHtml`), read suppressions and compose:
```ts
        const suppressions = (data.message && data.message.suppressions) || [];
        const supHtml = suppressions.length
            ? `<div class="app-card mb-2" style="border-color: var(--hl-danger);">
                 <div class="text-danger"><strong>Suppressed by SendGrid</strong> — future mail is being dropped:</div>
                 ${suppressions.map((s: any) => `<div class="small mt-1 d-flex justify-content-between align-items-center">
                     <span><span class="badge bg-danger">${esc(s.list)}</span> ${s.reason ? esc(s.reason) : ''}</span>
                     <button class="app-btn app-btn-sm" data-email-action="unsuppress" data-list="${esc(s.list)}">Remove &amp; resend</button>
                   </div>`).join('')}
               </div>`
            : '';
        const controls = `<div class="mb-3"><button class="app-btn app-btn-primary app-btn-sm" data-email-action="resend">Resend sign-in link</button></div>`;
        box.innerHTML = controls + supHtml + logsHtml;
```
(Keep the existing empty-state and error branches as-is; only the populated branch gains `controls + supHtml`.)

- [ ] **Step 3: Add a delegated handler** for the new buttons. Inside the `DOMContentLoaded` block, add:
```ts
    const emailResults = document.getElementById('email-results');
    emailResults?.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest('button[data-email-action]') as HTMLButtonElement | null;
        if (!btn || !emailResults.contains(btn)) return;
        const action = btn.getAttribute('data-email-action');
        const email = currentEmailRecipient;
        if (!email) return;
        btn.disabled = true;
        try {
            if (action === 'resend') {
                const res = await fetch(`${API}/email/resend-login`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
                });
                if (!res.ok) throw new Error((await res.json()).error || 'Failed');
                statusMsg('Sign-in link resent', 'success');
            } else if (action === 'unsuppress') {
                const list = btn.getAttribute('data-list');
                const res = await fetch(`${API}/email/unsuppress`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, list })
                });
                if (!res.ok) throw new Error((await res.json()).error || 'Failed');
                statusMsg('Suppression removed and link resent', 'success');
                loadEmailActivity(email);
            }
        } catch (err) {
            statusMsg(`Error: ${(err as Error).message}`, 'danger');
        } finally {
            btn.disabled = false;
        }
    });
```

- [ ] **Step 4: Recompile** the client TypeScript.

Run: `npx tsc -p client/tsconfig.json`
Expected: exit 0.

- [ ] **Step 5: Verify the compiled output**

Run: `grep -c "data-email-action\|resend-login\|unsuppress" client/dist/public/js/byView/admin/main.js` → expect >0.
Run: `grep -c "onclick=" client/dist/public/js/byView/admin/main.js` → expect `0`.

- [ ] **Step 6: Behavioral check (no client test harness).** With the dev server up and an authed superUser session, open the Email tab, search a recipient, and confirm the **Resend sign-in link** button appears (and a suppression banner appears for a suppressed address, if SendGrid is configured). Note what you verified. (A headless harness like the one used previously can stub `fetch` for `/email` to include a `suppressions` array and assert the banner + buttons render and the delegated POST fires.)

- [ ] **Step 7: Commit (source + compiled dist)**

```bash
git add client/src/public/js/byView/admin/main.ts client/dist/public/js/byView/admin/main.js client/dist/public/js/byView/admin/main.js.map client/dist/public/js/byView/admin/main.d.ts client/dist/public/js/byView/admin/main.d.ts.map
git commit -m "feat(admin): Email tab — resend + remove-suppression actions"
```

---

## Self-Review

**Spec coverage (Phase 4):** `sendMagicSignInLink` reuse (Task 1) ✓; resend endpoint (Task 2) ✓; suppression lookup + remove via free Suppressions API (Task 3) ✓; suppression surfaced in lookup + unsuppress-then-resend endpoint (Task 4) ✓; Email-tab resend button + suppression banner + remove&resend, CSP-safe (Task 5) ✓. Net-report resend explicitly out of scope.

**Type/name consistency:** `sendMagicSignInLink(email)` defined in Task 1, imported in Tasks 2 & 4. `getSuppressions(email)`/`removeSuppression(email, list)`/`LISTS` defined in Task 3, used in Task 4. Response key `suppressions` added in Task 4, read in Task 5. Endpoint paths `/api/admin/email/resend-login` and `/api/admin/email/unsuppress` consistent between routes (Tasks 2/4) and client (Task 5). `data-email-action` attribute + delegated handler both in Task 5.

**Login-safety:** Task 1 only adds a helper + export; the `/magiclogin` route and `MagicLoginStrategy` are untouched (verified in Task 1 Step 5). Fallback to extracting `magicAuth.js` is documented if the module won't import in isolation.

**Deploy note:** No new dependency (`@sendgrid/client` already bundled). Deploy = `git pull` + restart (server JS changed) + Cloudflare purge of `/js/byView/admin/main.js`. No `npm install`.
