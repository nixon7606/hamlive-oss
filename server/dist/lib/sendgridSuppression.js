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
