/* hamlive-oss — MIT License. See LICENSE. */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { conf } = require('../lib/configLib');
const { verifySignature } = require('../lib/sendgridWebhook');
const { getEmailEvent } = require('../models/emailEvent');
const { getEmailLog } = require('../models/emailLog');
const { logger } = require('../lib/logger');

const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false });

// Mounted with express.raw() so req.body is a Buffer (needed for signature check).
router.post('/', webhookLimiter, async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const sig = req.get('X-Twilio-Email-Event-Webhook-Signature');
    const ts = req.get('X-Twilio-Email-Event-Webhook-Timestamp');
    const key = conf.sendgrid_webhook_verification_key || process.env.SENDGRID_WEBHOOK_VERIFICATION_KEY;

    if (!verifySignature(raw, sig, ts, key)) {
        return res.status(401).json({ error: 'invalid signature' });
    }

    const tsSeconds = parseInt(ts, 10);
    if (!Number.isFinite(tsSeconds) || Math.abs(Math.floor(Date.now() / 1000) - tsSeconds) > 600) {
        return res.status(401).json({ error: 'stale timestamp' });
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
