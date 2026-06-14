# Email Capture Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every outbound email and ingest SendGrid delivery events into the app's own Mongo, so later phases can show a per-recipient delivery timeline.

**Architecture:** Two Mongoose collections (`emailLog` per send, `emailEvents` per webhook event). `EmailBase` tags each send with `custom_args` and records an `emailLog`. A new signature-verified `POST /api/sendgrid/events` route upserts events idempotently and advances the matching `emailLog` status. Correlation is via echoed custom args (`hlBatch` + recipient email).

**Tech Stack:** Node/Express, Mongoose 6, `@sendgrid/mail`, `@sendgrid/eventwebhook` (new), Jest + Supertest + `mongodb-memory-server`.

**Scope:** Phases 1–2 of `docs/superpowers/specs/2026-06-12-admin-email-observability-and-management-design.md`. Admin UI, resend, suppression, and hardening are later plans.

---

### Task 1: `emailLog` model

**Files:**
- Create: `server/dist/models/emailLog.js`
- Test: `tests/server/models/emailLog.test.js`

- [ ] **Step 1: Write the failing test**

```js
const mongoose = require('mongoose');
const { emailLogSchema } = require('../../../server/dist/models/emailLog');
const EmailLog = mongoose.model('EmailLog', emailLogSchema);
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-emaillog';

beforeAll(async () => { await mongoose.connect(MONGO_URI); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await EmailLog.deleteMany({}); });

test('creates an emailLog with defaults', async () => {
  const doc = await EmailLog.create({
    recipient: 'a@b.com', type: 'magic-login', subject: 'Sign in', batchId: 'batch1'
  });
  expect(doc.status).toBe('queued');
  expect(doc.recipient).toBe('a@b.com');
  expect(doc.createdAt).toBeInstanceOf(Date);
});

test('requires recipient and batchId', async () => {
  await expect(EmailLog.create({ type: 'magic-login' })).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/models/emailLog.test.js`
Expected: FAIL — `Cannot find module '../../../server/dist/models/emailLog'`.

- [ ] **Step 3: Write minimal implementation**

```js
/* hamlive-oss — MIT License. See LICENSE. */
const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');

const emailLogSchema = new Schema({
    recipient:     { type: String, required: true, index: true },
    type:          { type: String, required: true },
    subject:       { type: String },
    relatedUserId: { type: Schema.Types.ObjectId, ref: 'UserProfile' },
    relatedNetId:  { type: Schema.Types.ObjectId, ref: 'NetProfile' },
    batchId:       { type: String, required: true, index: true },
    sgMessageId:   { type: String },
    status:        { type: String, default: 'queued' },
    lastEventAt:   { type: Date },
    createdAt:     { type: Date, default: Date.now }
});
emailLogSchema.index({ recipient: 1, createdAt: -1 });

module.exports = {
    getEmailLog: db => modelMaker({ db, m: 'EmailLog', s: emailLogSchema }),
    emailLogSchema
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/models/emailLog.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/dist/models/emailLog.js tests/server/models/emailLog.test.js
git commit -m "feat(email): add emailLog model"
```

---

### Task 2: `emailEvents` model

**Files:**
- Create: `server/dist/models/emailEvent.js`
- Test: `tests/server/models/emailEvent.test.js`

- [ ] **Step 1: Write the failing test**

```js
const mongoose = require('mongoose');
const { emailEventSchema } = require('../../../server/dist/models/emailEvent');
const EmailEvent = mongoose.model('EmailEvent', emailEventSchema);
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-emailevent';

beforeAll(async () => { await mongoose.connect(MONGO_URI); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await EmailEvent.deleteMany({}); });

test('sgEventId is unique (idempotent inserts)', async () => {
  await EmailEvent.syncIndexes();
  await EmailEvent.create({ sgEventId: 'evt1', batchId: 'b1', email: 'a@b.com', event: 'delivered' });
  await expect(
    EmailEvent.create({ sgEventId: 'evt1', batchId: 'b1', email: 'a@b.com', event: 'delivered' })
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/models/emailEvent.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
/* hamlive-oss — MIT License. See LICENSE. */
const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');

const emailEventSchema = new Schema({
    sgEventId:   { type: String, required: true, unique: true },
    batchId:     { type: String, index: true },
    email:       { type: String, index: true },
    event:       { type: String, required: true },
    reason:      { type: String },
    sgMessageId: { type: String },
    timestamp:   { type: Date }
});

module.exports = {
    getEmailEvent: db => modelMaker({ db, m: 'EmailEvent', s: emailEventSchema }),
    emailEventSchema
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/models/emailEvent.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/dist/models/emailEvent.js tests/server/models/emailEvent.test.js
git commit -m "feat(email): add emailEvent model with unique sgEventId"
```

---

### Task 3: Record an `emailLog` on send (`EmailBase`)

**Files:**
- Modify: `server/dist/lib/userNotification.js` (constructor `type`; `sendMailToAddrs`/`sendEmailWithRetry`)
- Test: `tests/server/lib/emailLogging.test.js`

**Context:** `sendMailToAddrs(recipients)` computes `allowed`, builds `emailData` via `getEmailData`, then calls `sendEmailWithRetry`. We add: a `type` (constructor param, default `'generic'`), a `batchId` per send, inject `customArgs` into `emailData`, capture `x-message-id` from the SendGrid response, and create one `emailLog` per recipient. Logging is wrapped so it never throws into the caller.

- [ ] **Step 1: Write the failing test**

```js
const mongoose = require('mongoose');
const { emailLogSchema } = require('../../../server/dist/models/emailLog');
const EmailLog = mongoose.models.EmailLog || mongoose.model('EmailLog', emailLogSchema);
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-emaillogging';

// Force email "enabled" path with a stubbed SendGrid client.
jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  sendMultiple: jest.fn(async () => ([{ headers: { 'x-message-id': 'MSG123' } }]))
}));
jest.mock('../../../server/dist/lib/configLib', () => ({
  conf: { sendgrid_api_key: 'SG.test', app_name: 'Ham.Live', email_from: 'Ham <no-reply@x.com>' }
}));

const { EmailBase } = require('../../../server/dist/lib/userNotification');

beforeAll(async () => { await mongoose.connect(MONGO_URI); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await EmailLog.deleteMany({}); });

test('creates an emailLog per recipient with sgMessageId and type', async () => {
  const mail = new EmailBase({ subject: 'Hi', message: '<p>hi</p>', type: 'magic-login' });
  await mail.sendMailToAddrs(['a@b.com']);
  // logging is fire-and-forget inside send; allow the microtask to settle
  await new Promise(r => setTimeout(r, 50));
  const logs = await EmailLog.find({ recipient: 'a@b.com' });
  expect(logs).toHaveLength(1);
  expect(logs[0].type).toBe('magic-login');
  expect(logs[0].sgMessageId).toBe('MSG123');
  expect(logs[0].status).toBe('queued');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/lib/emailLogging.test.js`
Expected: FAIL — `EmailBase` is not exported and/or no emailLog created.

- [ ] **Step 3: Write minimal implementation**

In `userNotification.js`:

1. Add requires near the top (after existing requires):
```js
const crypto = require('crypto');
const { getEmailLog } = require('../models/emailLog');
```

2. In the `EmailBase` constructor, accept and store a `type`:
```js
constructor(param = {}) {
    const { subject, message, body, type } = param;
    this.#subject = subject;
    this.#message = message;
    this.#body = body;
    this.type = type || 'generic';
    if (!body && !(subject && message)) {
        throw new Error('In the constructor, if "body" is missing, both "subject" and "message" are mandatory.');
    }
}
```
(Add `type` as a public field declaration alongside the private `#subject` fields: `type;`.)

3. In `sendMailToAddrs`, after `const { allowed } = checkBulk(...)` block and before the final `try`, generate a batch id and tag the payload, then thread it through:
```js
const batchId = crypto.randomUUID();
try {
    const subject = this.getSubject();
    const emailData = this.getEmailData(allowed, subject);
    emailData.customArgs = { ...(emailData.customArgs || {}), hlType: this.type, hlBatch: batchId };
    const sgMessageId = await this.sendEmailWithRetry(emailData, allowed);
    this.recordEmailLogs(allowed, subject, batchId, sgMessageId);
} catch (err) {
    logger.error(`Failed to send mail: ${err.message}`);
    throw err;
}
```

4. Make `sendEmailWithRetry` return the message id:
```js
async sendEmailWithRetry(emailData, validRecipients) {
    if (!emailEnabled) {
        const subject = emailData.subject || emailData.dynamic_template_data?.subject || '(templated email)';
        logger.info(`[email disabled] Would send "${subject}" to ${validRecipients.join(', ')}`);
        return null;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const [response] = await sgMail.sendMultiple(emailData);
            logger.info(`Mail successfully sent to SendGrid for ${validRecipients.length} recipients`);
            return response?.headers?.['x-message-id'] || null;
        } catch (err) {
            if (attempt < 2) {
                logger.warn(`Failed to send to SendGrid on attempt ${attempt + 1}: ${err.message}. Retrying...`);
            } else {
                logger.error(`Failed to send to SendGrid on final attempt: ${err.message}`);
                throw err;
            }
        }
    }
    return null;
}
```

5. Add a logging helper that never throws into the caller:
```js
recordEmailLogs(recipients, subject, batchId, sgMessageId) {
    if (!emailEnabled) return;
    const EmailLog = getEmailLog();
    Promise.all(recipients.map(r => EmailLog.create({
        recipient: r, type: this.type, subject, batchId, sgMessageId, status: 'queued'
    }))).catch(err => logger.error(`recordEmailLogs() failed: ${err.message}`));
}
```

6. Export `EmailBase` (add to the file's `module.exports` alongside existing exports):
```js
module.exports.EmailBase = EmailBase;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/lib/emailLogging.test.js`
Expected: PASS.

- [ ] **Step 5: Pass the email `type` from callers**

- In `server/dist/routes/authRoutes.js`, the magic-link `new EmailBase({ subject, message })` → add `type: 'magic-login'`.
- In `server/dist/lib/userNotification.js`, `NetAnnounceStart` and `NetCloseReport` subclasses: set `this.type = 'net-announce'` / `'net-close-report'` in their constructors after `super(...)`.

- [ ] **Step 6: Run full suite to confirm no regressions**

Run: `npx jest`
Expected: previously-passing tests still pass; new test passes. (The pre-existing `localChat uploadImage` failure is unrelated.)

- [ ] **Step 7: Commit**

```bash
git add server/dist/lib/userNotification.js server/dist/routes/authRoutes.js tests/server/lib/emailLogging.test.js
git commit -m "feat(email): record emailLog with sgMessageId + type on send"
```

---

### Task 4: SendGrid webhook signature verification helper

**Files:**
- Create: `server/dist/lib/sendgridWebhook.js`
- Test: `tests/server/lib/sendgridWebhook.test.js`
- Modify: `package.json` (add dependency)

- [ ] **Step 1: Add the dependency**

Run: `npm install @sendgrid/eventwebhook`
Expected: `package.json` gains `@sendgrid/eventwebhook` under dependencies.

- [ ] **Step 2: Write the failing test**

```js
const { verifySignature } = require('../../../server/dist/lib/sendgridWebhook');

test('returns false when verification key is not configured', () => {
  expect(verifySignature(Buffer.from('[]'), 'sig', 'ts', '')).toBe(false);
});

test('returns false on a bad signature', () => {
  // A syntactically-valid base64 key but signature will not match.
  const key = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'A'.repeat(88);
  expect(verifySignature(Buffer.from('[]'), 'badsig', '123', key)).toBe(false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/server/lib/sendgridWebhook.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```js
/* hamlive-oss — MIT License. See LICENSE. */
const { EventWebhook } = require('@sendgrid/eventwebhook');
const { logger } = require('./logger');

/**
 * Verify a SendGrid Signed Event Webhook request.
 * @param {Buffer} rawBody  raw request body bytes
 * @param {string} signature  X-Twilio-Email-Event-Webhook-Signature header
 * @param {string} timestamp  X-Twilio-Email-Event-Webhook-Timestamp header
 * @param {string} publicKey  base64 verification key from SendGrid
 * @returns {boolean}
 */
function verifySignature(rawBody, signature, timestamp, publicKey) {
    if (!publicKey || !signature || !timestamp) return false;
    try {
        const ew = new EventWebhook();
        const ecdsaKey = ew.convertPublicKeyToECDSA(publicKey);
        return ew.verifySignature(ecdsaKey, rawBody, signature, timestamp);
    } catch (err) {
        logger.warn(`SendGrid webhook signature verify error: ${err.message}`);
        return false;
    }
}

module.exports = { verifySignature };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/server/lib/sendgridWebhook.test.js`
Expected: PASS (both return `false`).

- [ ] **Step 6: Commit**

```bash
git add server/dist/lib/sendgridWebhook.js tests/server/lib/sendgridWebhook.test.js package.json package-lock.json
git commit -m "feat(email): add SendGrid webhook signature verification helper"
```

---

### Task 5: Webhook route — ingest events idempotently

**Files:**
- Create: `server/dist/routes/sendgridWebhookRoutes.js`
- Test: `tests/server/routes/sendgridWebhook.test.js`

**Context:** The route delegates signature checking to `verifySignature` (Task 4), which the route test mocks. On valid signature it upserts each event into `emailEvents` (dedup by `sgEventId`) and updates the matching `emailLog` (`hlBatch` + `email`) `status`/`lastEventAt`. It always answers 2xx on valid signature, 401 otherwise.

- [ ] **Step 1: Write the failing test**

```js
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { emailLogSchema } = require('../../../server/dist/models/emailLog');
const { emailEventSchema } = require('../../../server/dist/models/emailEvent');

jest.mock('../../../server/dist/lib/sendgridWebhook', () => ({ verifySignature: jest.fn() }));
const { verifySignature } = require('../../../server/dist/lib/sendgridWebhook');

const EmailLog = mongoose.models.EmailLog || mongoose.model('EmailLog', emailLogSchema);
const EmailEvent = mongoose.models.EmailEvent || mongoose.model('EmailEvent', emailEventSchema);
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-sgwebhook';

const webhookRoutes = require('../../../server/dist/routes/sendgridWebhookRoutes');
const app = express();
app.use('/api/sendgrid/events', express.raw({ type: '*/*' }), webhookRoutes);

beforeAll(async () => { await mongoose.connect(MONGO_URI); await EmailEvent.syncIndexes(); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => {
  await EmailLog.deleteMany({}); await EmailEvent.deleteMany({}); verifySignature.mockReset();
});

const payload = [{
  sg_event_id: 'evt1', email: 'a@b.com', event: 'delivered',
  timestamp: 1700000000, sg_message_id: 'MSG123.recv', hlBatch: 'batch1', hlType: 'magic-login'
}];

test('rejects an invalid signature with 401', async () => {
  verifySignature.mockReturnValue(false);
  const res = await request(app).post('/api/sendgrid/events').send(payload);
  expect(res.status).toBe(401);
  expect(await EmailEvent.countDocuments()).toBe(0);
});

test('valid signature upserts events and advances emailLog status', async () => {
  verifySignature.mockReturnValue(true);
  await EmailLog.create({ recipient: 'a@b.com', type: 'magic-login', subject: 's', batchId: 'batch1' });
  const res = await request(app).post('/api/sendgrid/events').send(payload);
  expect(res.status).toBe(200);
  expect(await EmailEvent.countDocuments()).toBe(1);
  const log = await EmailLog.findOne({ batchId: 'batch1', recipient: 'a@b.com' });
  expect(log.status).toBe('delivered');
});

test('duplicate sg_event_id is idempotent', async () => {
  verifySignature.mockReturnValue(true);
  await request(app).post('/api/sendgrid/events').send(payload);
  await request(app).post('/api/sendgrid/events').send(payload);
  expect(await EmailEvent.countDocuments()).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/server/routes/sendgridWebhook.test.js`
Expected: FAIL — route module not found.

- [ ] **Step 3: Write minimal implementation**

```js
/* hamlive-oss — MIT License. See LICENSE. */
const express = require('express');
const router = express.Router();
const { conf } = require('../lib/configLib');
const { verifySignature } = require('../lib/sendgridWebhook');
const { getEmailEvent } = require('../models/emailEvent');
const { getEmailLog } = require('../models/emailLog');
const { logger } = require('../lib/logger');

// Mounted with express.raw() so req.body is a Buffer (needed for signature check).
router.post('/', async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const sig = req.get('X-Twilio-Email-Event-Webhook-Signature');
    const ts = req.get('X-Twilio-Email-Event-Webhook-Timestamp');
    const key = conf.sendgrid_webhook_verification_key || process.env.SENDGRID_WEBHOOK_VERIFICATION_KEY;

    if (!verifySignature(raw, sig, ts, key)) {
        return res.status(401).json({ error: 'invalid signature' });
    }

    let events = [];
    try { events = JSON.parse(raw.toString('utf8')); } catch { events = []; }

    const EmailEvent = getEmailEvent();
    const EmailLog = getEmailLog();

    for (const e of (Array.isArray(events) ? events : [])) {
        try {
            await EmailEvent.updateOne(
                { sgEventId: e.sg_event_id },
                { $setOnInsert: {
                    sgEventId: e.sg_event_id,
                    batchId: e.hlBatch,
                    email: e.email,
                    event: e.event,
                    reason: e.reason,
                    sgMessageId: e.sg_message_id,
                    timestamp: e.timestamp ? new Date(e.timestamp * 1000) : new Date()
                } },
                { upsert: true }
            );
            if (e.hlBatch && e.email) {
                await EmailLog.updateOne(
                    { batchId: e.hlBatch, recipient: e.email },
                    { $set: { status: e.event, lastEventAt: e.timestamp ? new Date(e.timestamp * 1000) : new Date() } }
                );
            }
        } catch (err) {
            logger.error(`sendgrid webhook event processing failed: ${err.message}`);
        }
    }
    return res.status(200).json({ received: (Array.isArray(events) ? events.length : 0) });
});

module.exports = router;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/server/routes/sendgridWebhook.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/dist/routes/sendgridWebhookRoutes.js tests/server/routes/sendgridWebhook.test.js
git commit -m "feat(email): SendGrid event webhook receiver (idempotent, signed)"
```

---

### Task 6: Mount the webhook route + config docs

**Files:**
- Modify: `server/dist/server.js` (mount before `express.json()`)
- Modify: `.env.example`

- [ ] **Step 1: Mount the route before the global JSON parser**

In `server/dist/server.js`, add the require with the other route requires (~line 35):
```js
const sendgridWebhookRoutes = require('./routes/sendgridWebhookRoutes');
```
Then mount it **before** `app.use(express.json())` (line 179) so it receives the raw body:
```js
// SendGrid event webhook needs the raw body for signature verification — mount
// before the global JSON/urlencoded parsers.
app.use('/api/sendgrid/events', express.raw({ type: '*/*' }), sendgridWebhookRoutes);
```

- [ ] **Step 2: Document the new env var**

In `.env.example`, add under the SendGrid section:
```
# Verification key for SendGrid's Signed Event Webhook (Settings → Mail Settings →
# Event Webhook → enable Signature Verification). Required for /api/sendgrid/events.
SENDGRID_WEBHOOK_VERIFICATION_KEY=
```
And ensure `configLib` exposes it as `conf.sendgrid_webhook_verification_key` (follow how `sendgrid_api_key` is mapped in `server/dist/lib/configLib.js`; mirror that entry).

- [ ] **Step 3: Smoke-test the mount**

Run: `npx jest`
Expected: full suite green except the unrelated pre-existing `localChat uploadImage` failure.

Run (manual, with the dev server up): `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/sendgrid/events -H 'Content-Type: application/json' -d '[]'`
Expected: `401` (no valid signature) — proves the route is mounted and verifying.

- [ ] **Step 4: Commit**

```bash
git add server/dist/server.js .env.example server/dist/lib/configLib.js
git commit -m "feat(email): mount SendGrid webhook route + document verification key env"
```

---

## Self-Review

**Spec coverage (Phases 1–2):** emailLog model (Task 1) ✓; emailEvents model + unique sgEventId (Task 2) ✓; EmailBase send-logging with custom_args + x-message-id capture + non-blocking (Task 3) ✓; webhook signature verify (Task 4) ✓; idempotent event upsert + status advance (Task 5) ✓; raw-body mount before express.json + env doc (Task 6) ✓. Phases 3–5 (admin UI, resend, suppression, hardening) are explicitly out of scope for this plan.

**Type/name consistency:** custom args `hlType`/`hlBatch` used identically in Task 3 (set) and Task 5 (read). `getEmailLog`/`getEmailEvent` factories used consistently. `verifySignature(rawBody, signature, timestamp, publicKey)` signature matches between Task 4 definition and Task 5 usage. `status` advances from `'queued'` (Task 1 default / Task 3) to event name (Task 5).

**Deploy note:** this plan adds a dependency (`@sendgrid/eventwebhook`), so deploying it (unlike the CSS/EJS/JS-only changes) requires `npm install` on the target container before restart.
