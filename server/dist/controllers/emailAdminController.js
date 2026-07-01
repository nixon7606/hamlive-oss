/* hamlive-oss — MIT License. See LICENSE. */
const { handleRequest } = require('../lib/responseUtils');
const { logger } = require('../lib/logger');
const { getAdminAudit } = require('../models/adminAudit');
const { conf } = require('../lib/configLib');
const { loadEmailSettings, saveEmailSettings } = require('../models/emailSettings');
const { encryptSecret, decryptSecret } = require('../lib/secretBox');
const { invalidateTransportCache, getActiveTransport } = require('../lib/emailTransports');
const { renderTemplate, TEMPLATE_KEYS, TEMPLATE_META, getDefault } = require('../lib/templateService');
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
    const t = (doc && doc.tracking) || {};
    // A stored password/token that no longer decrypts (encryption key rotated)
    // would otherwise read as "set" while auth silently fails — flag it so
    // the admin knows to re-enter it.
    let passwordInvalid = false;
    if (s.passwordEnc) {
        try { decryptSecret(s.passwordEnc); }
        catch { passwordInvalid = true; }
    }
    let tokenInvalid = false;
    if (t.tokenEnc) {
        try { decryptSecret(t.tokenEnc); }
        catch { tokenInvalid = true; }
    }
    return {
        provider: (doc && doc.provider) || 'sendgrid',
        smtp: {
            host: s.host || '', port: s.port || 587, secure: Boolean(s.secure),
            user: s.user || '', fromOverride: s.fromOverride || '',
            passwordSet: Boolean(s.passwordEnc),
            passwordInvalid
        },
        tracking: {
            enabled: Boolean(t.enabled), host: t.host || '', port: t.port || 2083,
            user: t.user || '', tlsVerify: t.tlsVerify !== false,
            tokenSet: Boolean(t.tokenEnc), tokenInvalid
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
    // A saved template that doesn't compile would break every send of this
    // email type (magic-link = sign-in down) — reject it at save time.
    try {
        const Handlebars = require('handlebars');
        const data = TEMPLATE_META[key].sample;
        Handlebars.compile(String(subject), { noEscape: true })(data);
        Handlebars.compile(String(html))(data);
    } catch (err) {
        const e = new Error(`template does not compile: ${err.message}`); e.status = 400; throw e;
    }
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

module.exports = { getSettings, putSettings, sendTest, testTracking, listTemplates, getTemplate, putTemplate, previewTemplate, resetTemplate };
