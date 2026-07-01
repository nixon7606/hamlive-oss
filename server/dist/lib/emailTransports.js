/* hamlive-oss — MIT License. See LICENSE. */
const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');
const { conf } = require('./configLib');
const { logger } = require('./logger');
const { loadEmailSettings } = require('../models/emailSettings');
const { decryptSecret } = require('./secretBox');

// ── attachment adapters ────────────────────────────────────────────────────
// Normalized attachment: { filename, contentBase64, contentType, contentId? }
// contentId is carried through from SG-shaped bodies (content_id) so the
// round-trip is lossless for the NetCloseReport attachments.
function toSendGridAttachment(a) {
    const out = { content: a.contentBase64, filename: a.filename, type: a.contentType, disposition: 'attachment' };
    if (a.contentId) out.content_id = a.contentId;
    return out;
}
function toNodemailerAttachment(a) {
    return { filename: a.filename, content: Buffer.from(a.contentBase64, 'base64'), contentType: a.contentType };
}

function buildSendGridPayload(msg) {
    const out = { to: msg.to, from: msg.from };
    // Only include subject when present — templated emails (NetCloseReport) have no
    // top-level subject in their body, so we must not add one here.
    if (msg.subject) out.subject = msg.subject;
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

class SmtpTransport {
    constructor({ host, port, secure, user, pass, from, fromOverride }) {
        this._from = from;
        this._fromOverride = fromOverride;
        this._tx = nodemailer.createTransport({
            host, port: Number(port), secure: Boolean(secure),
            auth: user ? { user, pass } : undefined
        });
    }
    async send(msg) {
        if (msg.templateId && !msg.html) {
            throw new Error('SmtpTransport cannot render a remote SendGrid template (no html provided)');
        }
        const base = {
            from: this._fromOverride || msg.from || this._from,
            subject: msg.subject,
            html: msg.html
        };
        if (msg.attachments && msg.attachments.length) base.attachments = msg.attachments.map(toNodemailerAttachment);
        // One copy per recipient (SendGrid sendMultiple semantics) so recipients
        // never see each other's addresses in a shared To header.
        const recipients = msg.to || [];
        let firstId = null;
        let failed = 0;
        for (const rcpt of recipients) {
            try {
                const info = await this._tx.sendMail({ ...base, to: rcpt });
                if (!firstId) firstId = info.messageId || null;
            } catch (err) {
                failed++;
                logger.error(`SmtpTransport: send to ${rcpt} failed: ${err.message}`);
            }
        }
        if (recipients.length && failed === recipients.length) {
            throw new Error(`SmtpTransport: all ${failed} recipient send(s) failed`);
        }
        return { messageId: firstId };
    }
}

// ── active-transport resolution (DB → env → console) ─────────────────────────
let _cached = null;
function invalidateTransportCache() { _cached = null; }

async function buildTransport() {
    let settings = null;
    let cacheable = true;
    try { settings = await loadEmailSettings(); }
    catch (err) {
        // Fall back for THIS send only — do not cache, or a transient DB error
        // would pin the fallback (console!) until restart or an admin re-save.
        cacheable = false;
        logger.warn(`emailTransports: settings load failed, falling back to env: ${err.message}`);
    }

    const provider = settings?.provider;
    if (provider === 'smtp' && settings.smtp?.host) {
        const s = settings.smtp;
        const pass = s.passwordEnc ? safeDecrypt(s.passwordEnc) : undefined;
        return { cacheable, transport: new SmtpTransport({ host: s.host, port: s.port, secure: s.secure, user: s.user, pass, from: EMAIL_FROM(), fromOverride: s.fromOverride || undefined }) };
    }
    if (provider === 'sendgrid' && conf.sendgrid_api_key) return { cacheable, transport: new SendGridTransport(conf.sendgrid_api_key) };
    if (provider === 'console') return { cacheable, transport: new ConsoleTransport() };

    // No (usable) DB setting → env fallback, then console.
    if (conf.sendgrid_api_key) return { cacheable, transport: new SendGridTransport(conf.sendgrid_api_key) };
    return { cacheable, transport: new ConsoleTransport() };
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
    const { cacheable, transport } = await buildTransport();
    if (cacheable) _cached = transport;
    return transport;
}

async function isRealSenderActive() {
    const t = await getActiveTransport();
    return !(t instanceof ConsoleTransport);
}

module.exports = {
    buildSendGridPayload, toSendGridAttachment, toNodemailerAttachment,
    ConsoleTransport, SendGridTransport, SmtpTransport,
    getActiveTransport, invalidateTransportCache, isRealSenderActive
};
