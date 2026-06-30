/* hamlive-oss — MIT License. See LICENSE. */
const { handleRequest } = require('../lib/responseUtils');
const { logger } = require('../lib/logger');
const { getAdminAudit } = require('../models/adminAudit');
const { conf } = require('../lib/configLib');
const { loadEmailSettings, saveEmailSettings } = require('../models/emailSettings');
const { encryptSecret } = require('../lib/secretBox');
const { invalidateTransportCache, getActiveTransport } = require('../lib/emailTransports');
const { renderTemplate, TEMPLATE_KEYS, TEMPLATE_META } = require('../lib/templateService');

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
