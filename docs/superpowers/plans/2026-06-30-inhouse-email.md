# In-House Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard SendGrid dependency with a pluggable email transport (SMTP / SendGrid / console), render all email templates in-house from a database, and give superuser admins a web UI to configure the provider and edit templates.

**Architecture:** A transport interface sits behind the existing `EmailBase` send chokepoint with three implementations (`ConsoleTransport`, `SendGridTransport`, `SmtpTransport`). The active transport is resolved **per-send** from a cached `EmailSettings` singleton document (DB → env → console), and the cache is invalidated whenever an admin saves — so provider changes take effect with no restart. Email bodies are rendered from a Handlebars `EmailTemplate` collection seeded on boot from `.hbs` files. A new admin "Email Settings" area edits both.

**Tech Stack:** Node.js + Express + Mongoose (Mongoose 6), `nodemailer` (SMTP), `handlebars` (templates), AES-256-GCM via Node `crypto`. Tests: Jest (`tests/server/**/*.test.js`) + supertest. EJS views + framework-free client TypeScript (compiled to `client/dist`).

## Global Constraints

- **Patch `dist` directly for server code.** The server runs from `server/dist/**/*.js`; there is **no server build on deploy**. Edit `server/dist/...` directly. (See `CLAUDE.md`, `PATCHES.md`.)
- **Client code must be recompiled.** Edit `client/src/...`, run `npm run build`, and commit the regenerated `client/dist`. (Only Task 9 touches client code.)
- **Record non-trivial `dist` patches in `PATCHES.md`.**
- **Deploy runs no `npm install`** (`scripts/deploy.sh` = `git reset --hard` + `systemctl restart`). New deps require a manual install on the box — see Task 10 and the Deploy section.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`), Prettier formatting.
- **Config keys are snake_case** on the `conf` object: `conf.base_url`, `conf.app_name`, `conf.sendgrid_api_key`, `conf.email_from`, `conf.cookie_session_key`.
- **Mongoose models** are built via `modelMaker({ db, m, s })` from `server/dist/lib/modelMaker.js`.
- **Controllers** wrap logic in `handleRequest(res, async () => ({ message: ... }), 'label')` and audit via `recordAudit(req, { action, targetType, targetId, targetLabel, details })`.
- **No secret is ever returned by an admin API.** The SMTP password is write-only; reads return a boolean "is set" flag only.
- **Test runner:** `npx jest tests/server/<path>.test.js`. DB-backed tests connect to `process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test'` with a per-suite suffix (run `npm run mongo:dev` in another terminal, or set `MONGO_URI`). Pure tests (secretBox, template render) need no DB.

---

## File Structure

**New server files (`server/dist/`):**
- `lib/secretBox.js` — AES-256-GCM encrypt/decrypt for stored secrets.
- `lib/emailTransports.js` — transport interface + `ConsoleTransport`, `SendGridTransport`, `SmtpTransport`, plus `getActiveTransport()` / `invalidateTransportCache()`.
- `lib/templateService.js` — Handlebars render + seed-on-boot + `DEFAULT_TEMPLATE_KEYS` + allowed-variable metadata.
- `models/emailSettings.js` — singleton settings doc + `loadEmailSettings()` / `saveEmailSettings()`.
- `models/emailTemplate.js` — per-key template collection.
- `controllers/emailAdminController.js` — admin endpoints for settings + templates.
- `routes/emailAdminRoutes.js` — wires the endpoints (or extend `adminRoutes.js`; see Task 7).
- `views/emails/magic-link.hbs`, `views/emails/net-announce.hbs`, `views/emails/net-close.hbs` — seed templates.

**Modified server files:**
- `lib/userNotification.js` — `EmailBase` sends via transport; `NetAnnounceStart` / `NetCloseReport` render via `templateService`.
- `routes/authRoutes.js` — magic-link renders via `templateService`.
- `server.js` — call `seedTemplates()` on boot; mount email-admin routes.
- `routes/adminRoutes.js` — mount new email-admin routes (if not a separate router).

**New client files (`client/src/`, compiled to `client/dist`):**
- `public/js/byView/admin/emailSettings.ts` — provider + template editor wiring (imported by the admin entry).

**Modified client/view files:**
- `server/dist/views/admin.ejs` — new "Email Settings" panel markup.
- `client/src/public/js/byView/admin/main.ts` — import/init the email-settings module.

**New test files (`tests/server/`):**
- `lib/secretBox.test.js`, `lib/emailTransports.test.js`, `lib/templateService.test.js`
- `models/emailSettings.test.js`, `models/emailTemplate.test.js`
- `routes/adminEmailSettings.test.js`, `routes/adminEmailTemplates.test.js`

**Docs:** `.env.example`, `docs/email-templates/README.md` (fix EJS→Handlebars note), `PATCHES.md`, `docs/DEPLOY.md` (npm-install step).

---

### Task 0: Dependencies and test script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add runtime deps and a test script**

In `package.json`, add to `"dependencies"` (keep alphabetical):
```json
"handlebars": "^4.7.8",
"nodemailer": "^6.9.14",
```
Add to `"scripts"`:
```json
"test": "jest"
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: `node_modules/handlebars` and `node_modules/nodemailer` exist; lockfile/`package.json` updated.

- [ ] **Step 3: Verify jest runs**

Run: `npx jest tests/server/models/emailLog.test.js`
Expected: existing test passes (confirms harness intact).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add nodemailer + handlebars deps and test script for in-house email"
```

---

### Task 1: secretBox (encrypt/decrypt for stored SMTP password)

**Files:**
- Create: `server/dist/lib/secretBox.js`
- Test: `tests/server/lib/secretBox.test.js`

**Interfaces:**
- Produces: `encryptSecret(plaintext: string) -> string` (self-describing `v1:<saltB64>:<ivB64>:<tagB64>:<ctB64>`), `decryptSecret(token: string) -> string`. Key = scrypt(`process.env.EMAIL_SECRET_KEY || conf.cookie_session_key`, salt, 32). Throws if no key material is available.

- [ ] **Step 1: Write the failing test**

Create `tests/server/lib/secretBox.test.js`:
```js
const { encryptSecret, decryptSecret } = require('../../../server/dist/lib/secretBox');

beforeAll(() => { process.env.EMAIL_SECRET_KEY = 'a'.repeat(40); });

test('round-trips a secret', () => {
  const token = encryptSecret('hunter2');
  expect(token.startsWith('v1:')).toBe(true);
  expect(token).not.toContain('hunter2');
  expect(decryptSecret(token)).toBe('hunter2');
});

test('two encryptions of the same plaintext differ (random salt/iv)', () => {
  expect(encryptSecret('x')).not.toBe(encryptSecret('x'));
});

test('tampering with ciphertext throws on decrypt', () => {
  const token = encryptSecret('secret');
  const parts = token.split(':');
  parts[4] = Buffer.from('tampered').toString('base64');
  expect(() => decryptSecret(parts.join(':'))).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/lib/secretBox.test.js`
Expected: FAIL — "Cannot find module '.../secretBox'".

- [ ] **Step 3: Write the implementation**

Create `server/dist/lib/secretBox.js`:
```js
/* hamlive-oss — MIT License. See LICENSE. */
const crypto = require('crypto');
const { conf } = require('./configLib');

// Master key material: a dedicated EMAIL_SECRET_KEY if set, else the app's
// cookie session key. NOTE: rotating this invalidates every stored SMTP
// password (admins must re-enter it). Documented in .env.example.
function masterKeyMaterial() {
    const m = process.env.EMAIL_SECRET_KEY || conf.cookie_session_key;
    if (!m || typeof m !== 'string' || m.length < 16) {
        throw new Error('secretBox: no key material (set EMAIL_SECRET_KEY or COOKIE_SESSION_KEY)');
    }
    return m;
}

function deriveKey(salt) {
    return crypto.scryptSync(masterKeyMaterial(), salt, 32);
}

function encryptSecret(plaintext) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', salt, iv, tag, ct].map((p, i) => (i === 0 ? p : p.toString('base64'))).join(':');
}

function decryptSecret(token) {
    const [v, saltB64, ivB64, tagB64, ctB64] = String(token).split(':');
    if (v !== 'v1') throw new Error('secretBox: unknown token version');
    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const key = deriveKey(salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/lib/secretBox.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/dist/lib/secretBox.js tests/server/lib/secretBox.test.js
git commit -m "feat(email): add secretBox AES-256-GCM helper for stored SMTP credentials"
```

---

### Task 2: Transport interface + Console/SendGrid transports, wired into EmailBase

This lands the abstraction **behavior-preserving**: with no settings doc, sends go through SendGrid (when `SENDGRID_API_KEY` is set) or console (when not) exactly as today, including the existing 3-attempt retry.

**Files:**
- Create: `server/dist/lib/emailTransports.js`
- Modify: `server/dist/lib/userNotification.js`
- Test: `tests/server/lib/emailTransports.test.js`

**Interfaces:**
- Produces:
  - Normalized message shape: `{ to: string[], from: string, subject: string, html?: string, templateId?: string, templateData?: object, attachments?: Array<{ filename, contentBase64, contentType }> }`.
  - `class ConsoleTransport { async send(msg) -> { messageId: null } }`
  - `class SendGridTransport { constructor(apiKey); async send(msg) -> { messageId } }`
  - `getActiveTransport() -> Promise<transport>` (Task 4 adds settings resolution; this task ships the env/console version).
  - `invalidateTransportCache()`.
  - `buildSendGridPayload(msg)` / attachment adapters (exported for tests).
- Consumes: `secretBox` (Task 1) — not yet; SMTP arrives in Task 3.

- [ ] **Step 1: Write the failing test**

Create `tests/server/lib/emailTransports.test.js`:
```js
const { buildSendGridPayload, ConsoleTransport } = require('../../../server/dist/lib/emailTransports');

test('buildSendGridPayload maps normalized html + attachments to SG shape', () => {
  const sg = buildSendGridPayload({
    to: ['a@b.com'], from: 'x@y.com', subject: 'Hi', html: '<b>hi</b>',
    attachments: [{ filename: 'r.csv', contentBase64: 'YWJj', contentType: 'text/csv' }]
  });
  expect(sg.to).toEqual(['a@b.com']);
  expect(sg.html).toBe('<b>hi</b>');
  expect(sg.attachments[0]).toEqual({ content: 'YWJj', filename: 'r.csv', type: 'text/csv', disposition: 'attachment' });
});

test('buildSendGridPayload passes through templateId/templateData (no html)', () => {
  const sg = buildSendGridPayload({ to: ['a@b.com'], from: 'x@y.com', templateId: 'd-1', templateData: { title: 'T' } });
  expect(sg.templateId).toBe('d-1');
  expect(sg.dynamic_template_data).toEqual({ title: 'T' });
  expect(sg.html).toBeUndefined();
});

test('ConsoleTransport returns null messageId and does not throw', async () => {
  const r = await new ConsoleTransport().send({ to: ['a@b.com'], subject: 'Hi', html: '<b>x</b>' });
  expect(r).toEqual({ messageId: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/lib/emailTransports.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `server/dist/lib/emailTransports.js`:
```js
/* hamlive-oss — MIT License. See LICENSE. */
const sgMail = require('@sendgrid/mail');
const { conf } = require('./configLib');
const { logger } = require('./logger');

// ── attachment adapters ────────────────────────────────────────────────────
// Normalized attachment: { filename, contentBase64, contentType }
function toSendGridAttachment(a) {
    return { content: a.contentBase64, filename: a.filename, type: a.contentType, disposition: 'attachment' };
}
function toNodemailerAttachment(a) {
    return { filename: a.filename, content: Buffer.from(a.contentBase64, 'base64'), contentType: a.contentType };
}

function buildSendGridPayload(msg) {
    const out = { to: msg.to, from: msg.from, subject: msg.subject };
    if (msg.html) out.html = msg.html;
    if (msg.templateId) { out.templateId = msg.templateId; out.dynamic_template_data = msg.templateData || {}; }
    if (msg.attachments && msg.attachments.length) out.attachments = msg.attachments.map(toSendGridAttachment);
    if (msg.customArgs) out.customArgs = msg.customArgs;
    return out;
}

// ── transports ─────────────────────────────────────────────────────────────
class ConsoleTransport {
    async send(msg) {
        logger.info(`[email console] Would send "${msg.subject || '(templated)'}" to ${(msg.to || []).join(', ')}`);
        return { messageId: null };
    }
}

class SendGridTransport {
    constructor(apiKey) { this._client = sgMail; this._client.setApiKey(apiKey); }
    async send(msg) {
        const payload = buildSendGridPayload(msg);
        const [response] = await this._client.sendMultiple(payload);
        return { messageId: response?.headers?.['x-message-id'] || null };
    }
}

// ── active-transport resolution (env/console only; Task 4 adds DB settings) ──
let _cached = null;
function invalidateTransportCache() { _cached = null; }

async function buildTransportFromEnv() {
    if (conf.sendgrid_api_key) return new SendGridTransport(conf.sendgrid_api_key);
    return new ConsoleTransport();
}

async function getActiveTransport() {
    if (_cached) return _cached;
    _cached = await buildTransportFromEnv();
    return _cached;
}

module.exports = {
    buildSendGridPayload, toSendGridAttachment, toNodemailerAttachment,
    ConsoleTransport, SendGridTransport,
    getActiveTransport, invalidateTransportCache
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/lib/emailTransports.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire EmailBase to use the transport**

In `server/dist/lib/userNotification.js`:

Add near the top imports (after line 8):
```js
const { getActiveTransport } = require('./emailTransports');
```

Replace `sendEmailWithRetry` (lines 128–149) with a transport-based version that builds the normalized message and keeps the 3-attempt retry + disabled-email logging:
```js
    // Build the normalized transport message from this email's body/subject/message.
    buildMessage(validRecipients, subject) {
        const b = this.#body;
        if (b) {
            const msg = { to: validRecipients, from: b.from || EMAIL_FROM, subject };
            if (b.html) msg.html = b.html;
            if (b.templateId) { msg.templateId = b.templateId; msg.templateData = b.dynamic_template_data || {}; }
            if (b.attachments) {
                // b.attachments may already be SG-shaped (content/type) — normalize.
                msg.attachments = b.attachments.map(a => ({
                    filename: a.filename,
                    contentBase64: a.content,
                    contentType: a.type
                }));
            }
            return msg;
        }
        return { to: validRecipients, from: EMAIL_FROM, subject, html: this.#message };
    }

    async sendEmailWithRetry(emailData, validRecipients) {
        // emailData carries customArgs assembled in sendMailToAddrs; merge onto the message.
        const transport = await getActiveTransport();
        if (transport instanceof require('./emailTransports').ConsoleTransport) {
            const subject = emailData.subject || '(templated email)';
            logger.info(`[email disabled] Would send "${subject}" to ${validRecipients.join(', ')}`);
            // Still return null id; recordEmailLogs() is gated on emailEnabled below.
            return null;
        }
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const { messageId } = await transport.send(emailData);
                logger.info(`Mail successfully handed to transport for ${validRecipients.length} recipients`);
                return messageId;
            } catch (err) {
                if (attempt < 2) {
                    logger.warn(`Transport send failed on attempt ${attempt + 1}: ${err.message}. Retrying...`);
                } else {
                    logger.error(`Transport send failed on final attempt: ${err.message}`);
                    throw err;
                }
            }
        }
    }
```

Update `sendMailToAddrs` (around line 94–96) to build the normalized message instead of the SG-only `getEmailData`:
```js
            const subject = this.getSubject();
            const emailData = this.buildMessage(allowed, subject);
            emailData.customArgs = { ...(emailData.customArgs || {}), hlType: this.type, hlBatch: batchId };
            const messageId = await this.sendEmailWithRetry(emailData, allowed);
            this.recordEmailLogs(allowed, subject, batchId, messageId);
```

> **Note:** `getEmailData` (old SG-only builder) is now unused by this path. Leave it in place for this task (a later cleanup can remove it) to keep the diff focused. `recordEmailLogs` stays gated on `emailEnabled` as before — unchanged.

> **Behavior-preservation caveat:** the `instanceof ConsoleTransport` check replaces the old `!emailEnabled` gate. With no `SENDGRID_API_KEY`, `getActiveTransport()` returns a `ConsoleTransport`, so the "would send" log fires exactly as before. With a key set, SendGrid is used as before.

- [ ] **Step 6: Run the full email-related suite to confirm no regressions**

Run: `npx jest tests/server/routes/adminEmail.test.js tests/server/routes/sendgridWebhook.test.js tests/server/lib/emailTransports.test.js`
Expected: PASS. (If any test stubbed `sgMail` directly, adjust to the transport — note it in the commit.)

- [ ] **Step 7: Commit**

```bash
git add server/dist/lib/emailTransports.js server/dist/lib/userNotification.js tests/server/lib/emailTransports.test.js
git commit -m "feat(email): introduce transport abstraction (console + sendgrid), behavior-preserving"
```

---

### Task 3: SMTP transport

**Files:**
- Modify: `server/dist/lib/emailTransports.js`
- Test: `tests/server/lib/emailTransports.test.js` (extend)

**Interfaces:**
- Produces: `class SmtpTransport { constructor({ host, port, secure, user, pass, from }); async send(msg) -> { messageId } }`. Uses `nodemailer.createTransport`. Maps normalized attachments via `toNodemailerAttachment`. Throws a clear error if `msg.templateId` is present without `msg.html` (SMTP cannot render a remote SendGrid template — only relevant before Task 6 converts net-close).

- [ ] **Step 1: Write the failing test**

Append to `tests/server/lib/emailTransports.test.js`:
```js
const nodemailer = require('nodemailer');
const { SmtpTransport } = require('../../../server/dist/lib/emailTransports');

test('SmtpTransport sends html + attachments via nodemailer', async () => {
  const sendMail = jest.fn(async () => ({ messageId: '<abc@local>' }));
  jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });
  const t = new SmtpTransport({ host: 'localhost', port: 1025, secure: false, user: 'u', pass: 'p', from: 'x@y.com' });
  const r = await t.send({
    to: ['a@b.com'], from: 'x@y.com', subject: 'Hi', html: '<b>hi</b>',
    attachments: [{ filename: 'r.csv', contentBase64: 'YWJj', contentType: 'text/csv' }]
  });
  expect(r.messageId).toBe('<abc@local>');
  const arg = sendMail.mock.calls[0][0];
  expect(arg.to).toBe('a@b.com');
  expect(arg.html).toBe('<b>hi</b>');
  expect(arg.attachments[0].filename).toBe('r.csv');
  expect(Buffer.isBuffer(arg.attachments[0].content)).toBe(true);
});

test('SmtpTransport refuses a templateId-only message', async () => {
  const t = new SmtpTransport({ host: 'localhost', port: 1025, secure: false, from: 'x@y.com' });
  await expect(t.send({ to: ['a@b.com'], subject: 'x', templateId: 'd-1', templateData: {} }))
    .rejects.toThrow(/template/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/lib/emailTransports.test.js -t SmtpTransport`
Expected: FAIL — `SmtpTransport is not a constructor`.

- [ ] **Step 3: Write the implementation**

In `server/dist/lib/emailTransports.js`, add `const nodemailer = require('nodemailer');` at the top, and add the class before the resolution section:
```js
class SmtpTransport {
    constructor({ host, port, secure, user, pass, from }) {
        this._from = from;
        this._tx = nodemailer.createTransport({
            host, port: Number(port), secure: Boolean(secure),
            auth: user ? { user, pass } : undefined
        });
    }
    async send(msg) {
        if (msg.templateId && !msg.html) {
            throw new Error('SmtpTransport cannot render a remote SendGrid template (no html provided)');
        }
        const mail = {
            from: msg.from || this._from,
            to: (msg.to || []).join(', '),
            subject: msg.subject,
            html: msg.html
        };
        if (msg.attachments && msg.attachments.length) mail.attachments = msg.attachments.map(toNodemailerAttachment);
        const info = await this._tx.sendMail(mail);
        return { messageId: info.messageId || null };
    }
}
```
Export it: add `SmtpTransport` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/lib/emailTransports.test.js`
Expected: PASS (all transport tests).

- [ ] **Step 5: Commit**

```bash
git add server/dist/lib/emailTransports.js tests/server/lib/emailTransports.test.js
git commit -m "feat(email): add nodemailer SMTP transport"
```

---

### Task 4: EmailSettings model + DB-aware transport resolution with cache invalidation

**Files:**
- Create: `server/dist/models/emailSettings.js`
- Modify: `server/dist/lib/emailTransports.js`
- Test: `tests/server/models/emailSettings.test.js`, extend `tests/server/lib/emailTransports.test.js`

**Interfaces:**
- Produces:
  - Model `EmailSettings` (singleton) via `getEmailSettings(db)`, schema fields: `provider` enum `['sendgrid','smtp','console']` (default `'sendgrid'`), `smtp: { host, port, secure, user, passwordEnc, fromOverride }`, timestamps.
  - `loadEmailSettings() -> Promise<doc|null>` (returns the single doc or null).
  - `saveEmailSettings(patch, actorId) -> Promise<doc>` (upserts the singleton; **does not** encrypt — the controller encrypts the password before calling).
  - Updated `getActiveTransport()`: resolution order **DB provider → env → console**, cached, with `invalidateTransportCache()` clearing it.
- Consumes: `secretBox.decryptSecret` (Task 1), `SmtpTransport`/`SendGridTransport`/`ConsoleTransport` (Tasks 2–3).

- [ ] **Step 1: Write the failing model test**

Create `tests/server/models/emailSettings.test.js`:
```js
const mongoose = require('mongoose');
const { emailSettingsSchema, loadEmailSettings, saveEmailSettings, getEmailSettings } = require('../../../server/dist/models/emailSettings');
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-emailsettings';

beforeAll(async () => { await mongoose.connect(MONGO_URI); getEmailSettings(); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await mongoose.model('EmailSettings').deleteMany({}); });

test('loadEmailSettings returns null when unset', async () => {
  expect(await loadEmailSettings()).toBeNull();
});

test('saveEmailSettings upserts a single doc', async () => {
  await saveEmailSettings({ provider: 'smtp', smtp: { host: 'h', port: 587, secure: true, user: 'u', passwordEnc: 'enc' } }, null);
  await saveEmailSettings({ provider: 'console' }, null);
  const all = await mongoose.model('EmailSettings').find({});
  expect(all.length).toBe(1);
  expect(all[0].provider).toBe('console');
  expect(all[0].smtp.host).toBe('h'); // unset fields preserved
});

test('provider enum rejects garbage', async () => {
  await expect(saveEmailSettings({ provider: 'pigeon' }, null)).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/models/emailSettings.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the model**

Create `server/dist/models/emailSettings.js`:
```js
/* hamlive-oss — MIT License. See LICENSE. */
const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');

const smtpSchema = new Schema({
    host:         { type: String },
    port:         { type: Number, default: 587 },
    secure:       { type: Boolean, default: false },
    user:         { type: String },
    passwordEnc:  { type: String },   // secretBox token; never returned by APIs
    fromOverride: { type: String }
}, { _id: false });

const emailSettingsSchema = new Schema({
    // singleton marker so we always upsert the same row
    singleton:  { type: String, default: 'email', unique: true },
    provider:   { type: String, enum: ['sendgrid', 'smtp', 'console'], default: 'sendgrid' },
    smtp:       { type: smtpSchema, default: () => ({}) },
    updatedBy:  { type: Schema.Types.ObjectId, ref: 'UserProfile' }
}, { timestamps: true });

const getEmailSettings = db => modelMaker({ db, m: 'EmailSettings', s: emailSettingsSchema });

async function loadEmailSettings() {
    return getEmailSettings().findOne({ singleton: 'email' });
}

// patch is a partial { provider?, smtp?: {...} }. Deep-sets smtp fields so a
// password-less save preserves the stored passwordEnc.
async function saveEmailSettings(patch, actorId) {
    const Model = getEmailSettings();
    const set = { updatedBy: actorId || undefined };
    if (patch.provider !== undefined) set.provider = patch.provider;
    if (patch.smtp) for (const [k, v] of Object.entries(patch.smtp)) set[`smtp.${k}`] = v;
    return Model.findOneAndUpdate(
        { singleton: 'email' },
        { $set: set, $setOnInsert: { singleton: 'email' } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
}

module.exports = { emailSettingsSchema, getEmailSettings, loadEmailSettings, saveEmailSettings };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/models/emailSettings.test.js` (requires a mongod — `npm run mongo:dev` or `MONGO_URI`).
Expected: PASS (3 tests).

- [ ] **Step 5: Write the resolver test**

Append to `tests/server/lib/emailTransports.test.js`:
```js
const transports = require('../../../server/dist/lib/emailTransports');
const settingsMod = require('../../../server/dist/models/emailSettings');

afterEach(() => { transports.invalidateTransportCache(); jest.restoreAllMocks(); });

test('getActiveTransport picks SMTP from settings and caches until invalidated', async () => {
  jest.spyOn(settingsMod, 'loadEmailSettings').mockResolvedValue({
    provider: 'smtp', smtp: { host: 'h', port: 587, secure: false, user: 'u', passwordEnc: null }
  });
  const t1 = await transports.getActiveTransport();
  expect(t1).toBeInstanceOf(transports.SmtpTransport);
  // change settings, but cache should still serve the old one
  settingsMod.loadEmailSettings.mockResolvedValue({ provider: 'console' });
  expect(await transports.getActiveTransport()).toBe(t1);
  transports.invalidateTransportCache();
  expect(await transports.getActiveTransport()).toBeInstanceOf(transports.ConsoleTransport);
});
```

- [ ] **Step 6: Update `getActiveTransport` to consult settings**

In `server/dist/lib/emailTransports.js`, replace the resolution section:
```js
const { loadEmailSettings } = require('../models/emailSettings');
const { decryptSecret } = require('./secretBox');

let _cached = null;
function invalidateTransportCache() { _cached = null; }

async function buildTransport() {
    let settings = null;
    try { settings = await loadEmailSettings(); }
    catch (err) { logger.warn(`emailTransports: settings load failed, falling back to env: ${err.message}`); }

    const provider = settings?.provider;
    if (provider === 'smtp' && settings.smtp?.host) {
        const s = settings.smtp;
        const pass = s.passwordEnc ? safeDecrypt(s.passwordEnc) : undefined;
        return new SmtpTransport({ host: s.host, port: s.port, secure: s.secure, user: s.user, pass, from: s.fromOverride || EMAIL_FROM() });
    }
    if (provider === 'sendgrid' && conf.sendgrid_api_key) return new SendGridTransport(conf.sendgrid_api_key);
    if (provider === 'console') return new ConsoleTransport();

    // No (usable) DB setting → env fallback, then console.
    if (conf.sendgrid_api_key) return new SendGridTransport(conf.sendgrid_api_key);
    return new ConsoleTransport();
}

function safeDecrypt(token) {
    try { return decryptSecret(token); }
    catch (err) { logger.error(`emailTransports: failed to decrypt SMTP password: ${err.message}`); return undefined; }
}

function EMAIL_FROM() {
    return process.env.EMAIL_FROM || conf.email_from || `${conf.app_name || 'Ham.Live'} <no-reply@example.com>`;
}

async function getActiveTransport() {
    if (_cached) return _cached;
    _cached = await buildTransport();
    return _cached;
}
```
Keep all three transport classes exported. Remove the old `buildTransportFromEnv`.

> **Circular-import note:** `emailTransports.js` now requires `models/emailSettings.js`, which requires `lib/modelMaker.js` (no cycle back to transports). `userNotification.js` requires `emailTransports`. Verify no `require` cycle by running the suite; if Node logs a partial-module warning, lazy-`require('./secretBox')` inside `safeDecrypt` and `require('../models/emailSettings')` inside `buildTransport`.

- [ ] **Step 7: Run tests**

Run: `npx jest tests/server/lib/emailTransports.test.js`
Expected: PASS (resolver + transport tests).

- [ ] **Step 8: Commit**

```bash
git add server/dist/models/emailSettings.js server/dist/lib/emailTransports.js tests/server/models/emailSettings.test.js tests/server/lib/emailTransports.test.js
git commit -m "feat(email): resolve active transport per-send from EmailSettings (DB > env > console)"
```

---

### Task 5: EmailTemplate model + Handlebars render + seed-on-boot

**Files:**
- Create: `server/dist/models/emailTemplate.js`
- Create: `server/dist/lib/templateService.js`
- Create: `server/dist/views/emails/magic-link.hbs`, `net-announce.hbs`, `net-close.hbs`
- Modify: `server/dist/server.js` (call `seedTemplates()` on boot)
- Test: `tests/server/models/emailTemplate.test.js`, `tests/server/lib/templateService.test.js`

**Interfaces:**
- Produces:
  - Model `EmailTemplate` via `getEmailTemplate(db)`: `{ key (enum, unique), subject, html, updatedBy }` + timestamps.
  - `templateService.TEMPLATE_KEYS = ['magic-link','net-announce','net-close']`.
  - `templateService.TEMPLATE_META` = per-key `{ label, variables: string[], sample: object }`.
  - `templateService.seedTemplates() -> Promise<void>` — upserts any missing key from the `.hbs` files.
  - `templateService.renderTemplate(key, data) -> Promise<{ subject, html }>` — loads the DB doc (falls back to the `.hbs` default if missing), compiles subject+html with Handlebars.
  - `templateService.getDefault(key) -> { subject, html }` (read `.hbs` + the default subject map).

- [ ] **Step 1: Create the seed `.hbs` files**

Create `server/dist/views/emails/net-close.hbs` — copy the contents of `docs/email-templates/net-close-report.html` verbatim (it is already Handlebars).

Create `server/dist/views/emails/magic-link.hbs` (converted from the inline HTML in `authRoutes.js`, `${link}` → `{{link}}`):
```html
<div style="background-color:#f4f2ec; padding:24px 12px; font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border:1px solid #e2ddd0; border-radius:10px; overflow:hidden;">
<tr><td align="center" bgcolor="#23262B" style="background-color:#23262B; padding:20px 0;"><img src="https://netcontrol.live/img/hamlive-logo-tagline-beta-horizontal-darkbg.png" alt="netcontrol.live" width="300" style="display:block; width:300px; max-width:82%; height:auto; border:0;"></td></tr>
<tr><td style="padding:28px 32px 8px 32px; font-family:Georgia,'Times New Roman',serif; color:#23262B; font-size:20px; font-weight:bold;">Finish signing in</td></tr>
<tr><td style="padding:0 32px 20px 32px; color:#444444; font-size:14px; line-height:1.6;">Click the button below to finish signing in to your netcontrol.live account. This link expires shortly and can only be used once.</td></tr>
<tr><td style="padding:0 32px 26px 32px;"><a clicktracking=off href='{{link}}' style="display:inline-block; background-color:#C24A38; color:#ffffff; font-size:15px; font-weight:bold; text-decoration:none; padding:12px 26px; border-radius:6px;">Sign in</a></td></tr>
<tr><td style="padding:0 32px 26px 32px; color:#7a756a; font-size:12px; line-height:1.6;">If the button does not work, paste this link into your browser:<br><a clicktracking=off href='{{link}}' style="color:#C24A38; word-break:break-all;">{{link}}</a></td></tr>
<tr><td bgcolor="#23262B" style="background-color:#23262B; padding:16px 32px; color:#9a9a9a; font-size:11px; line-height:1.6;">If you did not request this, you can safely ignore this email.<br>Sent by <a href="https://netcontrol.live" style="color:#C4933F; text-decoration:none;">netcontrol.live</a> &middot; Amateur Radio Net Control</td></tr>
</table></div>
```

Create `server/dist/views/emails/net-announce.hbs` (converted from `NetAnnounceStart`, `${netControl}`→`{{netControl}}`, `${conf.base_url}${url}`→`{{url}}`, `${title}`→`{{title}}`, favorites link→`{{favoritesUrl}}`):
```html
<div style="background-color:#f4f2ec; padding:24px 12px; font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border:1px solid #e2ddd0; border-radius:10px; overflow:hidden;">
<tr><td align="center" bgcolor="#23262B" style="background-color:#23262B; padding:20px 0;"><img src="https://netcontrol.live/img/hamlive-logo-tagline-beta-horizontal-darkbg.png" alt="netcontrol.live" width="300" style="display:block; width:300px; max-width:82%; height:auto; border:0;"></td></tr>
<tr><td style="padding:28px 32px 6px 32px; font-family:Georgia,'Times New Roman',serif; color:#23262B; font-size:20px; font-weight:bold;">A net is going live</td></tr>
<tr><td style="padding:0 32px 18px 32px; color:#444444; font-size:14px; line-height:1.6;">{{netControl}} is starting <a href='{{url}}' style="color:#C24A38; font-weight:bold; text-decoration:none;">{{title}}</a>.</td></tr>
<tr><td style="padding:0 32px 26px 32px;"><a href='{{url}}' style="display:inline-block; background-color:#C24A38; color:#ffffff; font-size:15px; font-weight:bold; text-decoration:none; padding:12px 26px; border-radius:6px;">Join the net</a></td></tr>
<tr><td bgcolor="#23262B" style="background-color:#23262B; padding:16px 32px; color:#9a9a9a; font-size:11px; line-height:1.6;">To stop these alerts, unfollow (☆) {{title}} at <a href='{{favoritesUrl}}' style="color:#C4933F; text-decoration:none;">your favorites</a>.<br>Sent by <a href="https://netcontrol.live" style="color:#C4933F; text-decoration:none;">netcontrol.live</a> &middot; Amateur Radio Net Control</td></tr>
</table></div>
```

- [ ] **Step 2: Write the failing model test**

Create `tests/server/models/emailTemplate.test.js`:
```js
const mongoose = require('mongoose');
const { emailTemplateSchema, getEmailTemplate } = require('../../../server/dist/models/emailTemplate');
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-emailtemplate';

beforeAll(async () => { await mongoose.connect(MONGO_URI); getEmailTemplate(); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await mongoose.model('EmailTemplate').deleteMany({}); });

test('stores a template keyed uniquely', async () => {
  const T = getEmailTemplate();
  await T.create({ key: 'magic-link', subject: 'S', html: '<b>{{link}}</b>' });
  await expect(T.create({ key: 'magic-link', subject: 'dup', html: 'x' })).rejects.toThrow();
});

test('rejects an unknown key', async () => {
  await expect(getEmailTemplate().create({ key: 'nope', subject: 'S', html: 'x' })).rejects.toThrow();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/server/models/emailTemplate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the model**

Create `server/dist/models/emailTemplate.js`:
```js
/* hamlive-oss — MIT License. See LICENSE. */
const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');

const emailTemplateSchema = new Schema({
    key:       { type: String, required: true, unique: true, enum: ['magic-link', 'net-announce', 'net-close'] },
    subject:   { type: String, required: true },
    html:      { type: String, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'UserProfile' }
}, { timestamps: true });

module.exports = {
    emailTemplateSchema,
    getEmailTemplate: db => modelMaker({ db, m: 'EmailTemplate', s: emailTemplateSchema })
};
```

- [ ] **Step 5: Run model test**

Run: `npx jest tests/server/models/emailTemplate.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the failing templateService test**

Create `tests/server/lib/templateService.test.js`:
```js
const ts = require('../../../server/dist/lib/templateService');

test('renders the net-close default with sample data', async () => {
  // getDefault reads the .hbs file; render compiles with provided data (no DB).
  const out = await ts.renderTemplate('net-close', {
    subject: 'My Net - Net Close Report', title: 'My Net', url: 'https://x/y',
    startedAtString: 'Sat, Jun 21, 2026, 7:30 AM MDT', timezoneAbbr: 'MDT',
    formattedAttendees: [{ role: 'NCS', callSign: 'K1ABC', displayName: 'Al', checkInTime: '7:30 AM', highlight: true }]
  }, { useDefault: true });
  expect(out.subject).toBe('My Net - Net Close Report');
  expect(out.html).toContain('K1ABC');
  expect(out.html).toContain('My Net');
  expect(out.html).toContain('background-color:#faf3e2'); // highlight branch rendered
});

test('renders magic-link default with the link', async () => {
  const out = await ts.renderTemplate('magic-link', { link: 'https://x/login?token=abc' }, { useDefault: true });
  expect(out.html).toContain('https://x/login?token=abc');
});

test('TEMPLATE_META lists variables for each key', () => {
  expect(ts.TEMPLATE_KEYS).toEqual(['magic-link', 'net-announce', 'net-close']);
  expect(ts.TEMPLATE_META['net-close'].variables).toContain('formattedAttendees');
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx jest tests/server/lib/templateService.test.js`
Expected: FAIL — module not found.

- [ ] **Step 8: Write templateService**

Create `server/dist/lib/templateService.js`:
```js
/* hamlive-oss — MIT License. See LICENSE. */
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const { getEmailTemplate } = require('../models/emailTemplate');
const { logger } = require('./logger');

const EMAIL_DIR = path.resolve(__dirname, '../views/emails');

const DEFAULT_SUBJECTS = {
    'magic-link':   'Sign in to netcontrol.live',
    'net-announce': '{{title}}(★) is going live {{humanTime}} !',
    'net-close':    '{{title}} - Net Close Report'
};

const TEMPLATE_KEYS = ['magic-link', 'net-announce', 'net-close'];

const TEMPLATE_META = {
    'magic-link':   { label: 'Sign-in (magic link)', variables: ['link'],
                      sample: { link: 'https://example.com/auth/magiclogin/callback?token=SAMPLE' } },
    'net-announce': { label: 'Net going live', variables: ['netControl', 'title', 'url', 'favoritesUrl', 'humanTime'],
                      sample: { netControl: 'K1ABC', title: 'Sunday Rag Chew', url: 'https://example.com/p/sunday',
                                favoritesUrl: 'https://example.com/views/favorites', humanTime: 'in 10 minutes' } },
    'net-close':    { label: 'Net Close Report', variables: ['subject', 'title', 'url', 'startedAtString', 'timezoneAbbr', 'formattedAttendees'],
                      sample: { subject: 'Sunday Rag Chew - Net Close Report', title: 'Sunday Rag Chew',
                                url: 'https://example.com/p/sunday', startedAtString: 'Sat, Jun 21, 2026, 7:30 AM MDT',
                                timezoneAbbr: 'MDT',
                                formattedAttendees: [
                                  { role: 'NCS', callSign: 'K1ABC', displayName: 'Al', checkInTime: '7:30 AM', highlight: false },
                                  { role: '', callSign: 'W2DEF', displayName: 'Bea', checkInTime: '7:32 AM', highlight: true }
                                ] } }
};

function getDefault(key) {
    const html = fs.readFileSync(path.join(EMAIL_DIR, `${key}.hbs`), 'utf8');
    return { subject: DEFAULT_SUBJECTS[key], html };
}

async function loadTemplate(key, { useDefault = false } = {}) {
    if (!useDefault) {
        try {
            const doc = await getEmailTemplate().findOne({ key });
            if (doc) return { subject: doc.subject, html: doc.html };
        } catch (err) {
            logger.warn(`templateService: DB load failed for ${key}, using default: ${err.message}`);
        }
    }
    return getDefault(key);
}

async function renderTemplate(key, data, opts = {}) {
    const { subject, html } = await loadTemplate(key, opts);
    return {
        subject: Handlebars.compile(subject, { noEscape: true })(data),
        html: Handlebars.compile(html)(data)
    };
}

async function seedTemplates() {
    const T = getEmailTemplate();
    for (const key of TEMPLATE_KEYS) {
        const exists = await T.findOne({ key }).lean();
        if (!exists) {
            const def = getDefault(key);
            await T.create({ key, subject: def.subject, html: def.html });
            logger.info(`templateService: seeded default email template "${key}"`);
        }
    }
}

module.exports = { TEMPLATE_KEYS, TEMPLATE_META, getDefault, renderTemplate, seedTemplates };
```

> **Handlebars escaping note:** the subject is compiled with `noEscape: true` (plain text, no HTML entities). The HTML body uses default escaping — `{{title}}` is HTML-escaped, which is correct/desired for user-supplied net titles. The net-close `.hbs` relies only on `{{#each}}`, `{{#if}}`, and `{{var}}` — all standard Handlebars.

- [ ] **Step 9: Run templateService test**

Run: `npx jest tests/server/lib/templateService.test.js`
Expected: PASS (3 tests).

- [ ] **Step 10: Seed on boot**

In `server/dist/server.js`, after the Mongo connection is established (find where other one-time startup tasks run — search for existing post-connect setup), add:
```js
const { seedTemplates } = require('./lib/templateService');
// ... after mongoose connection is open:
seedTemplates().catch(err => logger.error(`seedTemplates failed: ${err.message}`));
```
> Locate the exact insertion point by reading `server/dist/server.js` for where the DB connection resolves (e.g. inside the `mongoose.connect(...).then(...)` or an `async function start()`); place the call there so a connection exists.

- [ ] **Step 11: Commit**

```bash
git add server/dist/models/emailTemplate.js server/dist/lib/templateService.js server/dist/views/emails server/dist/server.js tests/server/models/emailTemplate.test.js tests/server/lib/templateService.test.js
git commit -m "feat(email): add EmailTemplate model, Handlebars templateService, seed-on-boot"
```

---

### Task 6: Convert the three emails to render via templateService

**Files:**
- Modify: `server/dist/lib/userNotification.js` (`NetAnnounceStart`, `NetCloseReport`)
- Modify: `server/dist/routes/authRoutes.js` (magic-link)
- Modify: `docs/email-templates/README.md` (fix EJS→Handlebars note)
- Test: extend coverage by asserting the rendered output still contains key markers (reuse templateService test) + a manual send check.

**Interfaces:**
- Consumes: `templateService.renderTemplate(key, data)`.
- The emails now pass `html` (rendered) into `EmailBase` instead of inline HTML / `templateId`.

- [ ] **Step 1: Convert magic-link (authRoutes.js)**

In `server/dist/routes/authRoutes.js`, add import:
```js
const { renderTemplate } = require('../lib/templateService');
```
Replace the `new EmailBase({ subject, type, message: '<div>...' })` block (lines ~65–78) with:
```js
            const { subject, html } = await renderTemplate('magic-link', { link });
            const email = new EmailBase({ subject, type: 'magic-login', message: html });
            await email.sendMailToAddrs([destination]);
```

- [ ] **Step 2: Convert NetAnnounceStart (userNotification.js)**

`NetAnnounceStart` builds HTML in its constructor, but `renderTemplate` is async — a constructor can't await. Convert it to the same static-`init` factory pattern `NetCloseReport` uses.

Replace the `NetAnnounceStart` class with:
```js
class NetAnnounceStart extends EmailBase {
    static async init({ netControl, netProfileDoc: { title }, liveNetDoc: { countdownTimer, url } }) {
        const humanTime = countdownTimer <= 1
            ? 'now'
            : 'in ' + humanizeDuration(countdownTimer * 60 * 1000, { largest: 2, round: true, delimiter: '--', units: ['h', 'm'] });
        const { renderTemplate } = require('./templateService');
        const data = {
            netControl, title, humanTime,
            url: `${conf.base_url}${url}`,
            favoritesUrl: `${conf.base_url}/views/favorites`
        };
        const { subject, html } = await renderTemplate('net-announce', data);
        const inst = new NetAnnounceStart({ body: { from: EMAIL_FROM, subject, html } });
        inst.type = 'net-announce';
        return inst;
    }
}
```
Then update the caller in `server/dist/controllers/liveNetController.js` (around lines 284–290): change `new NetAnnounceStart({...})` to `await NetAnnounceStart.init({...})`. Read that call site and adjust the surrounding `await`/async accordingly.

> **EMAIL_FROM:** `userNotification.js` defines `EMAIL_FROM` as a module constant — reuse it.

- [ ] **Step 3: Convert NetCloseReport (userNotification.js)**

In `NetCloseReport`'s `super({ body: {...} })` (lines ~310–325), the body currently sets `templateId` + `dynamic_template_data`. Render in-house instead. Because `super()` can't await, render in the static `init()` (which is already async) and pass the finished HTML down through the private constructor.

In `static async init(...)`, after computing nothing-yet, the constructor does the formatting. Simplest: move the `dynamic_template_data` assembly + render into `init`. Concretely:
- In `init`, after building the return data, compute `formattedAttendees`, `startedAtString`, `timezoneAbbr` (currently done in the constructor) — OR keep the constructor building `dynamic_template_data` on the instance, then render in `init` after construction.

Recommended minimal change: keep the constructor as-is but **store** the template data on the instance instead of as `body.dynamic_template_data`, then render in `init`:

In the constructor's `super({ body: {...} })`, replace `templateId` + `dynamic_template_data` with a plain marker and stash data:
```js
        super({
            body: {
                from: EMAIL_FROM,
                subject: `${title} - Net Close Report`,
                attachments: attachments
            }
        });
        this._templateData = {
            subject: `${title} - Net Close Report`,
            url: `${conf.base_url}${url}`,
            title,
            formattedAttendees,
            startedAtString: started ? NetCloseReport.#fmtDatetime(startedAt, netTZ) : '',
            timezoneAbbr: new Intl.DateTimeFormat('en-US', { timeZone: netTZ, timeZoneName: 'short' })
                .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || 'Local'
        };
```
Then in `static async init(...)`, after `const inst = new NetCloseReport(NetCloseReport.#_internal, {...})`, render and inject the html:
```js
        const { renderTemplate } = require('./templateService');
        const { html } = await renderTemplate('net-close', inst._templateData);
        inst.body.html = html;   // EmailBase.buildMessage will pick up body.html
        return inst;
```
> `EmailBase.get body()` returns the private `#body`; assigning `inst.body.html = html` mutates that object in place (same reference). Confirm by checking `buildMessage` reads `b.html`. The `subject` already lives in `body.subject`.

- [ ] **Step 4: Fix the README note**

In `docs/email-templates/README.md`, replace the paragraph that says to convert `{{ }}` → EJS `<%= %>` with a note that the app **renders these with Handlebars** in-house (`server/dist/lib/templateService.js`, seeded from `server/dist/views/emails/*.hbs`), so the `{{ }}` syntax is used as-is.

- [ ] **Step 5: Manual render sanity check**

Run: `npx jest tests/server/lib/templateService.test.js`
Expected: PASS (unchanged — confirms templates still render).

Then a quick local smoke (optional, needs dev DB + dev server): trigger a magic-login from the UI in console mode and confirm the "[email console] Would send" log shows the rendered subject.

- [ ] **Step 6: Commit**

```bash
git add server/dist/lib/userNotification.js server/dist/routes/authRoutes.js server/dist/controllers/liveNetController.js docs/email-templates/README.md
git commit -m "feat(email): render magic-link, net-announce, net-close from in-house Handlebars templates"
```

---

### Task 7: Admin backend — settings endpoints (GET/PUT) + test endpoint

**Files:**
- Create: `server/dist/controllers/emailAdminController.js`
- Modify: `server/dist/routes/adminRoutes.js` (mount new routes)
- Test: `tests/server/routes/adminEmailSettings.test.js`

**Interfaces:**
- Produces (all under `/api/admin/email`, behind `authCheck(REQ_LOGIN)` + `superAdminCheck`, audited):
  - `GET /settings` → `{ message: { provider, smtp: { host, port, secure, user, fromOverride, passwordSet: boolean }, envFallback: { sendgrid: boolean } } }` — **never** returns the password.
  - `PUT /settings` → body `{ provider, smtp: { host, port, secure, user, password?, fromOverride } }`. Encrypts `password` via `secretBox` only if a non-empty string is provided (empty/absent preserves existing); saves via `saveEmailSettings`; calls `invalidateTransportCache()`; audits; returns the same shape as GET.
  - `POST /test` → body `{ key }` (one of TEMPLATE_KEYS, default `'magic-link'`). Renders that template with `TEMPLATE_META[key].sample` and sends to the **current admin's** email via the active transport; returns `{ message: { sent: boolean, via: providerName } }`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/routes/adminEmailSettings.test.js`:
```js
const express = require('express');
const request = require('supertest');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/models/emailSettings', () => {
  let doc = null;
  return {
    loadEmailSettings: jest.fn(async () => doc),
    saveEmailSettings: jest.fn(async (patch) => { doc = { provider: patch.provider, smtp: { ...(doc?.smtp), ...(patch.smtp) } }; return doc; })
  };
});
jest.mock('../../../server/dist/lib/secretBox', () => ({ encryptSecret: jest.fn(p => `enc:${p}`), decryptSecret: jest.fn() }));
jest.mock('../../../server/dist/lib/emailTransports', () => ({ invalidateTransportCache: jest.fn(), getActiveTransport: jest.fn() }));
jest.mock('../../../server/dist/models/adminAudit', () => ({ getAdminAudit: () => ({ create: jest.fn(async () => ({})) }) }));

const { getSettings, putSettings } = require('../../../server/dist/controllers/emailAdminController');
const { saveEmailSettings } = require('../../../server/dist/models/emailSettings');
const { encryptSecret } = require('../../../server/dist/lib/secretBox');
const { invalidateTransportCache } = require('../../../server/dist/lib/emailTransports');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { _id: '1', email: 'admin@x.com' }; next(); });
app.get('/api/admin/email/settings', getSettings);
app.put('/api/admin/email/settings', putSettings);

test('GET settings never leaks the password and reports passwordSet', async () => {
  const res = await request(app).get('/api/admin/email/settings');
  expect(res.status).toBe(200);
  expect(JSON.stringify(res.body)).not.toMatch(/passwordEnc|password"/i);
  expect(res.body.message).toHaveProperty('provider');
});

test('PUT encrypts a provided password, saves, and invalidates cache', async () => {
  const res = await request(app).put('/api/admin/email/settings')
    .send({ provider: 'smtp', smtp: { host: 'h', port: 587, secure: true, user: 'u', password: 'hunter2' } });
  expect(res.status).toBe(200);
  expect(encryptSecret).toHaveBeenCalledWith('hunter2');
  expect(saveEmailSettings).toHaveBeenCalled();
  const savedPatch = saveEmailSettings.mock.calls[0][0];
  expect(savedPatch.smtp.passwordEnc).toBe('enc:hunter2');
  expect(savedPatch.smtp).not.toHaveProperty('password');
  expect(invalidateTransportCache).toHaveBeenCalled();
});

test('PUT without a password does not call encrypt (preserves existing)', async () => {
  encryptSecret.mockClear();
  const res = await request(app).put('/api/admin/email/settings')
    .send({ provider: 'smtp', smtp: { host: 'h2', port: 25, secure: false, user: 'u' } });
  expect(res.status).toBe(200);
  expect(encryptSecret).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/routes/adminEmailSettings.test.js`
Expected: FAIL — controller module not found.

- [ ] **Step 3: Write the controller**

Create `server/dist/controllers/emailAdminController.js`:
```js
/* hamlive-oss — MIT License. See LICENSE. */
const { handleRequest } = require('../lib/responseUtils');
const { logger } = require('../lib/logger');
const { getAdminAudit } = require('../models/adminAudit');
const { conf } = require('../lib/configLib');
const { loadEmailSettings, saveEmailSettings } = require('../models/emailSettings');
const { encryptSecret } = require('../lib/secretBox');
const { invalidateTransportCache, getActiveTransport } = require('../lib/emailTransports');
const { renderTemplate, TEMPLATE_KEYS, TEMPLATE_META } = require('../lib/templateService');
const { getEmailTemplate } = require('../models/emailTemplate');

function recordAudit(req, entry) {
    try {
        getAdminAudit().create({
            actorId: req.user && req.user._id,
            actorLabel: (req.user && (req.user.email || req.user.callSign)) || 'unknown',
            ...entry
        }).catch(err => logger.error(`recordAudit failed: ${err.message}`));
    } catch (err) { logger.error(`recordAudit failed: ${err.message}`); }
}

function publicSettings(doc) {
    const s = (doc && doc.smtp) || {};
    return {
        provider: (doc && doc.provider) || 'sendgrid',
        smtp: {
            host: s.host || '', port: s.port || 587, secure: Boolean(s.secure),
            user: s.user || '', fromOverride: s.fromOverride || '',
            passwordSet: Boolean(s.passwordEnc)
        },
        envFallback: { sendgrid: Boolean(conf.sendgrid_api_key) }
    };
}

const getSettings = (req, res) => handleRequest(res, async () => {
    const doc = await loadEmailSettings();
    return { message: publicSettings(doc) };
}, 'admin: getEmailSettings');

const putSettings = (req, res) => handleRequest(res, async () => {
    const body = req.body || {};
    const patch = {};
    if (body.provider) patch.provider = body.provider;
    if (body.smtp) {
        const s = body.smtp;
        patch.smtp = {
            host: s.host, port: s.port, secure: Boolean(s.secure), user: s.user, fromOverride: s.fromOverride
        };
        if (typeof s.password === 'string' && s.password.length > 0) {
            patch.smtp.passwordEnc = encryptSecret(s.password);
        }
    }
    const doc = await saveEmailSettings(patch, req.user && req.user._id);
    invalidateTransportCache();
    recordAudit(req, { action: 'email-settings-update', targetType: 'emailSettings', targetId: 'singleton', targetLabel: patch.provider || doc.provider, details: `provider=${doc.provider}` });
    return { message: publicSettings(doc) };
}, 'admin: putEmailSettings');

const sendTest = (req, res) => handleRequest(res, async () => {
    const key = TEMPLATE_KEYS.includes(req.body && req.body.key) ? req.body.key : 'magic-link';
    const to = req.user && req.user.email;
    if (!to) return { message: { sent: false, error: 'admin has no email on file' } };
    const { subject, html } = await renderTemplate(key, TEMPLATE_META[key].sample);
    const transport = await getActiveTransport();
    await transport.send({ to: [to], from: process.env.EMAIL_FROM || conf.email_from || `${conf.app_name || 'Ham.Live'} <no-reply@example.com>`, subject: `[TEST] ${subject}`, html });
    recordAudit(req, { action: 'email-test-send', targetType: 'emailTemplate', targetId: key, targetLabel: to, details: `via ${transport.constructor.name}` });
    return { message: { sent: true, via: transport.constructor.name } };
}, 'admin: sendTestEmail');

module.exports = { getSettings, putSettings, sendTest };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/routes/adminEmailSettings.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Mount the routes**

In `server/dist/routes/adminRoutes.js`, add to the controller import and routes:
```js
const { getSettings, putSettings, sendTest } = require('../controllers/emailAdminController');
// ... with the other routes (already behind authCheck + superAdminCheck via router.use):
router.get('/email/settings', getSettings);
router.put('/email/settings', putSettings);
router.post('/email/test', sendTest);
```

- [ ] **Step 6: Commit**

```bash
git add server/dist/controllers/emailAdminController.js server/dist/routes/adminRoutes.js tests/server/routes/adminEmailSettings.test.js
git commit -m "feat(admin): email provider settings endpoints (get/put/test), password write-only"
```

---

### Task 8: Admin backend — template endpoints (list/get/put/preview/reset)

**Files:**
- Modify: `server/dist/controllers/emailAdminController.js`
- Modify: `server/dist/routes/adminRoutes.js`
- Test: `tests/server/routes/adminEmailTemplates.test.js`

**Interfaces:**
- Produces (all under `/api/admin/email`, audited):
  - `GET /templates` → `{ message: { templates: [{ key, label, subject, updatedAt }] } }`.
  - `GET /templates/:key` → `{ message: { key, label, subject, html, variables, sample } }`.
  - `PUT /templates/:key` → body `{ subject, html }`; upserts the doc; audits; returns the saved `{ key, subject, html }`.
  - `POST /templates/:key/preview` → body `{ subject, html }` (the unsaved editor content); renders with `TEMPLATE_META[key].sample`; returns `{ message: { subject, html } }` — **no save, no send**.
  - `POST /templates/:key/reset` → re-seeds the doc from `getDefault(key)`; audits; returns the default `{ subject, html }`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/routes/adminEmailTemplates.test.js`:
```js
const express = require('express');
const request = require('supertest');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/models/adminAudit', () => ({ getAdminAudit: () => ({ create: jest.fn(async () => ({})) }) }));
const store = {};
jest.mock('../../../server/dist/models/emailTemplate', () => ({
  getEmailTemplate: () => ({
    findOne: ({ key }) => ({ lean: async () => store[key] || null, then: undefined }),
    findOneAndUpdate: async ({ key }, update) => { store[key] = { key, ...update.$set }; return store[key]; }
  })
}));

const { listTemplates, getTemplate, putTemplate, previewTemplate, resetTemplate } = require('../../../server/dist/controllers/emailAdminController');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { _id: '1', email: 'admin@x.com' }; next(); });
app.get('/t', listTemplates);
app.get('/t/:key', getTemplate);
app.put('/t/:key', putTemplate);
app.post('/t/:key/preview', previewTemplate);

test('preview renders provided html with sample data without saving', async () => {
  const res = await request(app).post('/t/magic-link/preview').send({ subject: 'S {{link}}', html: '<a>{{link}}</a>' });
  expect(res.status).toBe(200);
  expect(res.body.message.html).toContain('http'); // sample link rendered
  expect(store['magic-link']).toBeUndefined(); // not saved
});

test('GET unknown key 404s', async () => {
  const res = await request(app).get('/t/bogus');
  expect(res.status).toBe(500); // handleRequest maps thrown error; assert message
  expect(res.body.error).toMatch(/unknown template/i);
});
```
> Note: the mocked `findOne` returns an object exposing `.lean()`; match how the controller calls it (use `.lean()` consistently). Adjust the mock if the controller awaits `findOne(...)` directly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/routes/adminEmailTemplates.test.js`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Add the controller functions**

Append to `server/dist/controllers/emailAdminController.js` (and add `getDefault` to the templateService import):
```js
const { getDefault } = require('../lib/templateService'); // add to existing templateService import line

function assertKey(key) {
    if (!TEMPLATE_KEYS.includes(key)) { const e = new Error(`unknown template key: ${key}`); e.status = 404; throw e; }
}

const listTemplates = (req, res) => handleRequest(res, async () => {
    const T = getEmailTemplate();
    const templates = await Promise.all(TEMPLATE_KEYS.map(async key => {
        const doc = await T.findOne({ key }).lean();
        const def = getDefault(key);
        return { key, label: TEMPLATE_META[key].label, subject: (doc && doc.subject) || def.subject, updatedAt: doc && doc.updatedAt };
    }));
    return { message: { templates } };
}, 'admin: listEmailTemplates');

const getTemplate = (req, res) => handleRequest(res, async () => {
    const key = req.params.key; assertKey(key);
    const doc = await getEmailTemplate().findOne({ key }).lean();
    const def = getDefault(key);
    return { message: {
        key, label: TEMPLATE_META[key].label,
        subject: (doc && doc.subject) || def.subject,
        html: (doc && doc.html) || def.html,
        variables: TEMPLATE_META[key].variables, sample: TEMPLATE_META[key].sample
    } };
}, 'admin: getEmailTemplate');

const putTemplate = (req, res) => handleRequest(res, async () => {
    const key = req.params.key; assertKey(key);
    const { subject, html } = req.body || {};
    if (!subject || !html) { const e = new Error('subject and html are required'); e.status = 400; throw e; }
    const doc = await getEmailTemplate().findOneAndUpdate(
        { key }, { $set: { key, subject, html, updatedBy: req.user && req.user._id } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    recordAudit(req, { action: 'email-template-update', targetType: 'emailTemplate', targetId: key, targetLabel: TEMPLATE_META[key].label, details: `subject="${subject}"` });
    return { message: { key, subject: doc.subject, html: doc.html } };
}, 'admin: putEmailTemplate');

const previewTemplate = (req, res) => handleRequest(res, async () => {
    const key = req.params.key; assertKey(key);
    const { subject, html } = req.body || {};
    const Handlebars = require('handlebars');
    const data = TEMPLATE_META[key].sample;
    return { message: {
        subject: Handlebars.compile(String(subject || ''), { noEscape: true })(data),
        html: Handlebars.compile(String(html || ''))(data)
    } };
}, 'admin: previewEmailTemplate');

const resetTemplate = (req, res) => handleRequest(res, async () => {
    const key = req.params.key; assertKey(key);
    const def = getDefault(key);
    const doc = await getEmailTemplate().findOneAndUpdate(
        { key }, { $set: { key, subject: def.subject, html: def.html, updatedBy: req.user && req.user._id } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    recordAudit(req, { action: 'email-template-reset', targetType: 'emailTemplate', targetId: key, targetLabel: TEMPLATE_META[key].label, details: 'reset to default' });
    return { message: { key, subject: doc.subject, html: doc.html } };
}, 'admin: resetEmailTemplate');

module.exports = { getSettings, putSettings, sendTest, listTemplates, getTemplate, putTemplate, previewTemplate, resetTemplate };
```
> Replace the existing `module.exports` line with the expanded one above.

> **Error mapping:** `handleRequest` returns HTTP 500 on thrown errors (per the test mock and the real helper). If you want true 404/400 status codes, that requires changing `handleRequest` — out of scope; the thrown `message` is asserted instead. Keep the `e.status` assignments (harmless, future-friendly).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/routes/adminEmailTemplates.test.js`
Expected: PASS (adjust the `findOne().lean()` mock shape if the first run reveals a mismatch, then re-run).

- [ ] **Step 5: Mount the routes**

In `server/dist/routes/adminRoutes.js`, extend the import and add:
```js
const { /* existing */ listTemplates, getTemplate, putTemplate, previewTemplate, resetTemplate } = require('../controllers/emailAdminController');
router.get('/email/templates', listTemplates);
router.get('/email/templates/:key', getTemplate);
router.put('/email/templates/:key', putTemplate);
router.post('/email/templates/:key/preview', previewTemplate);
router.post('/email/templates/:key/reset', resetTemplate);
```

- [ ] **Step 6: Commit**

```bash
git add server/dist/controllers/emailAdminController.js server/dist/routes/adminRoutes.js tests/server/routes/adminEmailTemplates.test.js
git commit -m "feat(admin): email template endpoints (list/get/put/preview/reset)"
```

---

### Task 9: Admin UI — "Email Settings" panel (EJS + client TS)

> **This task touches client code.** Edit `client/src/...`, then `npm run build`, then commit the regenerated `client/dist`. First **read** `server/dist/views/admin.ejs` and `client/src/public/js/byView/admin/main.ts` to match the existing panel structure, fetch helpers, and styling conventions — reproduce that pattern; do not invent a new one.

**Files:**
- Modify: `server/dist/views/admin.ejs` (add the panel markup)
- Create: `client/src/public/js/byView/admin/emailSettings.ts`
- Modify: `client/src/public/js/byView/admin/main.ts` (import + init the module)
- Build artifact: `client/dist/public/js/byView/admin/*` (regenerated)

**Interfaces (the contract this UI consumes — all under `/api/admin/email`):**
- `GET /settings` → `{ message: { provider, smtp: { host, port, secure, user, fromOverride, passwordSet }, envFallback } }`
- `PUT /settings` body `{ provider, smtp: { host, port, secure, user, password?, fromOverride } }`
- `POST /test` body `{ key }` → `{ message: { sent, via } }`
- `GET /templates` → `{ message: { templates: [{ key, label, subject, updatedAt }] } }`
- `GET /templates/:key` → `{ message: { key, label, subject, html, variables, sample } }`
- `PUT /templates/:key` body `{ subject, html }`
- `POST /templates/:key/preview` body `{ subject, html }` → `{ message: { subject, html } }`
- `POST /templates/:key/reset` → `{ message: { subject, html } }`

- [ ] **Step 1: Add the panel markup to `admin.ejs`**

Add a new collapsible/section panel "Email Settings" alongside the existing admin panels (match the existing markup pattern you read). It contains two sub-sections:

Provider sub-section:
```html
<section id="email-settings-panel" class="admin-panel">
  <h2>Email Settings</h2>
  <form id="email-provider-form">
    <fieldset>
      <legend>Provider</legend>
      <label><input type="radio" name="provider" value="smtp"> SMTP</label>
      <label><input type="radio" name="provider" value="sendgrid"> SendGrid</label>
      <label><input type="radio" name="provider" value="console"> Console (log only)</label>
    </fieldset>
    <div id="smtp-fields">
      <label>Host <input name="host" type="text"></label>
      <label>Port <input name="port" type="number" value="587"></label>
      <label>Secure (TLS) <input name="secure" type="checkbox"></label>
      <label>Username <input name="user" type="text"></label>
      <label>Password <input name="password" type="password" placeholder="•••• (leave blank to keep)"></label>
      <span id="smtp-password-status"></span>
      <label>From override <input name="fromOverride" type="text" placeholder="Name &lt;addr@example.com&gt;"></label>
    </div>
    <button type="submit">Save provider settings</button>
    <span id="email-settings-status" role="status"></span>
  </form>
  <div id="email-test">
    <label>Test template
      <select id="email-test-key">
        <option value="magic-link">Sign-in (magic link)</option>
        <option value="net-announce">Net going live</option>
        <option value="net-close">Net Close Report</option>
      </select>
    </label>
    <button id="email-test-send" type="button">Send test to me</button>
    <span id="email-test-status" role="status"></span>
  </div>
</section>

<section id="email-templates-panel" class="admin-panel">
  <h2>Email Templates</h2>
  <ul id="email-template-list"></ul>
  <div id="email-template-editor" hidden>
    <h3 id="et-title"></h3>
    <p>Variables: <span id="et-vars"></span></p>
    <label>Subject <input id="et-subject" type="text"></label>
    <div class="et-toolbar">
      <button type="button" id="et-mode-source" class="active">Source</button>
      <button type="button" id="et-mode-rich">Rich</button>
    </div>
    <textarea id="et-html" rows="18" spellcheck="false"></textarea>
    <div id="et-rich" hidden></div>
    <div class="et-actions">
      <button type="button" id="et-preview">Preview</button>
      <button type="button" id="et-test">Send test to me</button>
      <button type="button" id="et-reset">Reset to default</button>
      <button type="button" id="et-save">Save template</button>
      <span id="et-status" role="status"></span>
    </div>
    <iframe id="et-preview-frame" title="Email preview" style="width:100%;height:480px;border:1px solid #ccc;"></iframe>
  </div>
</section>
```

- [ ] **Step 2: Write the client module**

Create `client/src/public/js/byView/admin/emailSettings.ts`. Mirror the fetch/error conventions of the existing admin module you read. Core behaviors:
```ts
// Pseudocode-precise: use the project's existing fetch helper if one exists in admin/main.ts.
async function api(path: string, init?: RequestInit) {
  const res = await fetch(`/api/admin/email${path}`, {
    headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...init
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'request failed');
  return body.message;
}

export async function initEmailSettings() {
  const panel = document.getElementById('email-settings-panel');
  if (!panel) return; // not on this page

  // 1. Load + populate provider form
  const s = await api('/settings');
  setRadio('provider', s.provider);
  setVal('host', s.smtp.host); setVal('port', s.smtp.port);
  (document.querySelector('[name=secure]') as HTMLInputElement).checked = s.smtp.secure;
  setVal('user', s.smtp.user); setVal('fromOverride', s.smtp.fromOverride);
  document.getElementById('smtp-password-status')!.textContent = s.smtp.passwordSet ? 'password is set' : 'no password set';
  toggleSmtpFields(s.provider);

  // 2. provider radio toggles smtp field visibility
  panel.querySelectorAll('[name=provider]').forEach(r =>
    r.addEventListener('change', e => toggleSmtpFields((e.target as HTMLInputElement).value)));

  // 3. Save provider settings
  document.getElementById('email-provider-form')!.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const payload = {
      provider: (f.querySelector('[name=provider]:checked') as HTMLInputElement)?.value,
      smtp: {
        host: val(f, 'host'), port: Number(val(f, 'port')), secure: (f.querySelector('[name=secure]') as HTMLInputElement).checked,
        user: val(f, 'user'), fromOverride: val(f, 'fromOverride'),
        ...(val(f, 'password') ? { password: val(f, 'password') } : {})
      }
    };
    await api('/settings', { method: 'PUT', body: JSON.stringify(payload) });
    status('email-settings-status', 'Saved. New provider applies to the next email — no restart needed.');
    (f.querySelector('[name=password]') as HTMLInputElement).value = '';
  });

  // 4. Send test (provider panel)
  document.getElementById('email-test-send')!.addEventListener('click', async () => {
    const key = (document.getElementById('email-test-key') as HTMLSelectElement).value;
    const r = await api('/test', { method: 'POST', body: JSON.stringify({ key }) });
    status('email-test-status', r.sent ? `Sent via ${r.via}` : `Not sent: ${r.error || 'unknown'}`);
  });

  await initTemplateEditor();
}
```
Template editor behaviors (`initTemplateEditor`):
- `GET /templates` → render the `<ul>` list; clicking an item `GET /templates/:key`, fills `#et-subject` + `#et-html`, shows variables, reveals `#email-template-editor`.
- **Source/Rich toggle:** Source shows the `<textarea>`; Rich initializes TinyMCE on a hidden div seeded from the textarea and syncs back on change. Initialize TinyMCE the same way `myNets` does (read `client/src/public/js/byView/myNets/main.ts` for the exact `tinymce.init({...})` config and the self-hosted script path) — reuse that config. On toggling back to Source, write the rich HTML into the textarea.
- **Preview:** `POST /templates/:key/preview` with the current `#et-subject`/`#et-html`; write `message.html` into the `#et-preview-frame` via `frame.srcdoc = html`.
- **Send test:** `POST /test` with the editor's `key`.
- **Reset:** confirm, `POST /templates/:key/reset`, refill the editor from the response.
- **Save:** `PUT /templates/:key` with `{ subject, html }`; show saved status.

Include the small helpers (`setRadio`, `setVal`, `val`, `status`, `toggleSmtpFields`) as plain functions.

- [ ] **Step 3: Wire into the admin entry**

In `client/src/public/js/byView/admin/main.ts`, import and call (wrapped in the existing error-isolation helper if present, mirroring how other admin sub-inits are called):
```ts
import { initEmailSettings } from './emailSettings.js';
// ... in the bootstrap:
initEmailSettings().catch(err => console.error('initEmailSettings failed', err));
```

- [ ] **Step 4: Build the client**

Run: `npm run build`
Expected: `client/dist/public/js/byView/admin/emailSettings.js` (+ updated `main.js`) generated with no TypeScript errors.

- [ ] **Step 5: Manual UI smoke (local)**

Start the app (`npm run dev`), sign in as a superuser, open the admin page:
- Provider panel loads current settings; switching to SMTP reveals fields; saving shows the no-restart message.
- "Send test to me" in console mode logs `[email console] Would send "[TEST] …"`.
- Template list loads; opening net-close shows the HTML; Preview renders the styled email in the iframe; Source/Rich toggle works; Save persists; Reset restores.

- [ ] **Step 6: Commit**

```bash
git add server/dist/views/admin.ejs client/src/public/js/byView/admin/emailSettings.ts client/src/public/js/byView/admin/main.ts client/dist/public/js/byView/admin
git commit -m "feat(admin): Email Settings UI — provider config + template editor with preview/test"
```

---

### Task 10: Config docs, PATCHES.md, deploy runbook

**Files:**
- Modify: `.env.example`
- Modify: `PATCHES.md`
- Modify: `docs/DEPLOY.md`

- [ ] **Step 1: Document new env in `.env.example`**

Add (near the email/SendGrid section):
```bash
# ── Email (in-house) ────────────────────────────────────────────────────────
# Provider, SMTP host, and credentials are normally configured in the admin UI
# (/views/admin → Email Settings) and stored in the database. These env vars are
# FALLBACKS used only when no admin settings exist:
#   SENDGRID_API_KEY  — if set and no DB provider is chosen, email uses SendGrid.
#   EMAIL_FROM        — default From address.
# EMAIL_SECRET_KEY encrypts the SMTP password stored in the database (AES-256-GCM).
# If unset, the app derives the key from COOKIE_SESSION_KEY. NOTE: changing
# EMAIL_SECRET_KEY (or COOKIE_SESSION_KEY when it is the fallback) invalidates the
# stored SMTP password — an admin must re-enter it in the UI.
# EMAIL_SECRET_KEY=change-me-to-a-long-random-string
```

- [ ] **Step 2: Record the divergence in `PATCHES.md`**

Add an entry describing: in-house email — new `dist` files (`lib/secretBox.js`, `lib/emailTransports.js`, `lib/templateService.js`, `models/emailSettings.js`, `models/emailTemplate.js`, `controllers/emailAdminController.js`, `views/emails/*.hbs`), modified `userNotification.js`/`authRoutes.js`/`adminRoutes.js`/`server.js`, and that net-close no longer uses the SendGrid dynamic template `d-c2c75b3765954b5dbc043576c67493a7`. Note new deps `nodemailer` + `handlebars` (require `npm install` on deploy).

- [ ] **Step 3: Add the npm-install deploy step to `docs/DEPLOY.md`**

Document that this release adds dependencies, so the deploy for it is:
```bash
# on the box, in $APP_DIR:
git reset --hard origin/staging
npm install                 # REQUIRED this release: nodemailer + handlebars are new
systemctl restart hamlive
```
Note that subsequent deploys without dependency changes don't need `npm install`.

- [ ] **Step 4: Commit**

```bash
git add .env.example PATCHES.md docs/DEPLOY.md
git commit -m "docs: document in-house email env, PATCHES entry, and npm-install deploy step"
```

---

### Task 11: Full-suite verification + deploy to staging

- [ ] **Step 1: Run the whole server suite**

Run: `npx jest --selectProjects server` (with `npm run mongo:dev` running, or `MONGO_URI` set)
Expected: all suites PASS, including the pre-existing email/admin tests.

- [ ] **Step 2: Lint/format**

Run: `npx prettier --check "server/dist/lib/emailTransports.js" "server/dist/lib/templateService.js" "server/dist/controllers/emailAdminController.js"` (or `npx prettier --write` then re-stage).

- [ ] **Step 3: Push to staging branch**

```bash
git checkout staging
git merge --ff-only main   # or rebase the feature commits onto staging per your workflow
git push origin staging
```
> If work was done on `main`, cherry-pick/merge the email commits onto `staging` instead. Confirm the intended branch with the maintainer before pushing.

- [ ] **Step 4: Deploy to the staging box (with the one-time install)**

On the staging box in `$APP_DIR` (or via the `deploy.sh` REMOTE_EXEC wrapper):
```bash
git reset --hard origin/staging
npm install
systemctl restart hamlive
```

- [ ] **Step 5: Staging acceptance checklist**
- App boots; `seedTemplates` logged three seeded templates on first run.
- Admin → Email Settings loads; default provider reflects env (SendGrid if `SENDGRID_API_KEY` set, else console).
- Configure SMTP against a test inbox (e.g. a maildev/Mailpit container or a real test mailbox); Save; "Send test to me" arrives via SMTP **without** a restart.
- Trigger a real magic-login → email arrives rendered from the template.
- Edit the net-close template, Save, run a net close (or send-test) → change reflected.
- Switch provider back to SendGrid → next send uses SendGrid.

---

## Self-Review

**Spec coverage:**
- Transport abstraction (console/sendgrid/smtp) → Tasks 2, 3. ✓
- Per-send resolution + cache invalidation (DB→env→console) → Task 4. ✓
- Encrypted SMTP password → Tasks 1, 7. ✓
- EmailTemplate model + Handlebars + seeding → Task 5. ✓
- All three emails rendered in-house → Task 6. ✓
- Admin provider config + test send → Task 7. ✓
- Admin template editor (source + TinyMCE toggle, preview, test, reset) → Tasks 8, 9. ✓
- Log-&-drop failure behavior → preserved in Task 2 (3-retry then throw/log). ✓
- README EJS→Handlebars fix → Task 6. ✓
- Deploy npm-install + env docs → Task 10; staging deploy → Task 11. ✓
- Out-of-scope items (bounce tracking, failover, per-type provider) → not implemented. ✓

**Placeholder scan:** Backend tasks contain complete code. Task 9 (UI) intentionally specifies behavior + exact API contracts and instructs reading the existing admin/myNets modules for the precise fetch/TinyMCE patterns — UI glue follows established repo patterns that are the source of truth, so it is described structurally with full markup and pseudocode-precise logic rather than copied verbatim from files not yet read.

**Type consistency:** Normalized message shape `{ to, from, subject, html?, templateId?, templateData?, attachments:[{filename, contentBase64, contentType}] }` is used identically across Tasks 2/3/4/6. `publicSettings` shape matches the UI contract in Task 9. `TEMPLATE_KEYS`/`TEMPLATE_META` defined in Task 5 and consumed in Tasks 7/8/9.

**Known follow-up (not blockers):** `handleRequest` maps thrown errors to HTTP 500, so the 404/400 `e.status` values are advisory until a future change threads status through `handleRequest`. `getEmailData` in `userNotification.js` is left dead after Task 2 and can be removed in a later cleanup.
