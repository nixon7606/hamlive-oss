/* hamlive-oss — MIT License. See LICENSE. */
const sgMail = require('@sendgrid/mail');
const { conf } = require('./configLib');
const { logger } = require('./logger');

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
