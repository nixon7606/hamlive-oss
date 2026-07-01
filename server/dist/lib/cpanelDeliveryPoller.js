/* hamlive-oss — MIT License. See LICENSE. */
/**
 * cPanel Track Delivery poller — fills the EmailLog/EmailEvent pipeline for
 * SMTP sends the way the SendGrid event webhook does for SendGrid sends.
 * Data source: cPanel API 2 EmailTrack::search (user-level token; NOT UAPI —
 * UAPI has no EmailTrack module). See docs/superpowers/specs/
 * 2026-07-01-cpanel-delivery-tracking.md for the verified endpoint shape.
 */
const crypto = require('crypto');
const https = require('https');
const { decryptSecret } = require('./secretBox');
const { logger } = require('./logger');

// EmailTrack `type` → the SendGrid-webhook status vocabulary the admin UI
// already understands. `inprogress` (and unknown types) → null = don't touch.
function mapTrackType(type) {
    if (type === 'success') return 'delivered';
    if (type === 'failure') return 'bounce';
    if (type === 'defer') return 'deferred';
    return null;
}

// Deterministic id for EmailEvent.sgEventId (unique index) — the poller
// re-reads the same EmailTrack rows every cycle for up to 48h, so the upsert
// key must be stable across polls.
function syntheticEventId(msgid, recipient, type) {
    const h = crypto.createHash('sha256').update(`${msgid}|${recipient}|${type}`).digest('hex');
    return `cpt-${h}`;
}

// The EmailTrack feed contains ALL the cPanel account's mail (DMARC reports,
// other domains' forwards) — keep only rows our app sent.
function filterToSender(rows, senderAddress) {
    const want = String(senderAddress || '').toLowerCase();
    if (!want) return [];
    return (rows || []).filter(r =>
        String(r.email || '').toLowerCase() === want ||
        String(r.sender || '').toLowerCase() === want);
}

// EmailTrack has no RFC Message-ID, so correlate on recipient + send-time
// proximity. Multiple candidates → closest createdAt wins.
function correlateRow(trackRow, logRows, windowMs = 15 * 60 * 1000) {
    const rcpt = String(trackRow.recipient || '').toLowerCase();
    const sentMs = Number(trackRow.sendunixtime) * 1000;
    if (!rcpt || !Number.isFinite(sentMs)) return null;
    let best = null, bestDelta = Infinity;
    for (const row of logRows) {
        if (String(row.recipient || '').toLowerCase() !== rcpt) continue;
        const delta = Math.abs(new Date(row.createdAt).getTime() - sentMs);
        if (delta <= windowMs && delta < bestDelta) { best = row; bestDelta = delta; }
    }
    return best;
}

function buildSearchUrl({ host, port, user }) {
    const qs = new URLSearchParams({
        cpanel_jsonapi_user: user,
        cpanel_jsonapi_apiversion: '2',
        cpanel_jsonapi_module: 'EmailTrack',
        cpanel_jsonapi_func: 'search',
        // Verified on a real box (2026-07-01): bare boolean flags are the only
        // spelling that returns successes; the no-flag default is failures-only.
        success: '1', defer: '1', failure: '1', inprogress: '1'
    });
    return `https://${host}:${Number(port) || 2083}/json-api/cpanel?${qs.toString()}`;
}

function parseSearchResponse(json) {
    const topErrors = json && json.errors;
    if (Array.isArray(topErrors) && topErrors.length) throw new Error(topErrors.join('; '));
    const cr = json && json.cpanelresult;
    if (cr && cr.error) throw new Error(String(cr.error));
    return (cr && Array.isArray(cr.data)) ? cr.data : [];
}

// Default transport — thin https wrapper so tests can inject requestImpl.
function httpsRequestImpl(url, options) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        });
        req.on('error', reject);
        req.setTimeout(options.timeout || 10_000, () => req.destroy(new Error('EmailTrack request timed out')));
        req.end();
    });
}

async function searchEmailTrack(tracking, { requestImpl = httpsRequestImpl } = {}) {
    let token;
    try { token = decryptSecret(tracking.tokenEnc); }
    catch (err) { throw new Error(`cannot decrypt cPanel API token (re-enter it in Email Settings): ${err.message}`); }
    const url = buildSearchUrl(tracking);
    const { statusCode, body } = await requestImpl(url, {
        method: 'GET',
        headers: { Authorization: `cpanel ${tracking.user}:${token}` },
        rejectUnauthorized: tracking.tlsVerify !== false,
        timeout: 10_000
    });
    if (statusCode !== 200) throw new Error(`EmailTrack HTTP ${statusCode}`);
    let json;
    try { json = JSON.parse(body); }
    catch { throw new Error('EmailTrack returned non-JSON (check host/port)'); }
    return parseSearchResponse(json);
}

const LOOKBACK_MS = 48 * 60 * 60 * 1000;
const NON_TERMINAL = ['accepted', 'deferred'];

function shouldPoll(settings) {
    const t = settings && settings.tracking;
    return Boolean(settings && settings.provider === 'smtp' &&
        t && t.enabled && t.host && t.user && t.tokenEnc);
}

// Bare address out of "Display Name <addr@host>" (EMAIL_FROM style).
function bareAddress(s) {
    const m = /<([^>]+)>/.exec(String(s || ''));
    return (m ? m[1] : String(s || '')).trim().toLowerCase();
}

function resolveSenderAddress(settings) {
    const { conf } = require('./configLib');
    return bareAddress(
        (settings.smtp && settings.smtp.fromOverride) ||
        process.env.EMAIL_FROM || conf.email_from || '');
}

async function pollOnce({ searchImpl = searchEmailTrack } = {}) {
    const { loadEmailSettings } = require('../models/emailSettings');
    const settings = await loadEmailSettings();
    if (!shouldPoll(settings)) return { polled: 0, updated: 0, events: 0 };

    const { getEmailLog } = require('../models/emailLog');
    const { getEmailEvent } = require('../models/emailEvent');
    const EmailLog = getEmailLog();
    const EmailEvent = getEmailEvent();

    const open = await EmailLog.find({
        status: { $in: NON_TERMINAL },
        createdAt: { $gte: new Date(Date.now() - LOOKBACK_MS) }
    }).lean();
    if (!open.length) return { polled: 0, updated: 0, events: 0 };

    const rows = filterToSender(await searchImpl(settings.tracking), resolveSenderAddress(settings));

    let updated = 0, events = 0;
    for (const row of rows) {
        const status = mapTrackType(row.type);
        if (!status) continue; // inprogress / unknown → leave as-is
        const log = correlateRow(row, open);
        if (!log) continue;
        const when = Number.isFinite(Number(row.actionunixtime))
            ? new Date(Number(row.actionunixtime) * 1000) : new Date();
        try {
            await EmailEvent.updateOne(
                { sgEventId: syntheticEventId(row.msgid, row.recipient, row.type) },
                { $setOnInsert: {
                    sgEventId: syntheticEventId(row.msgid, row.recipient, row.type),
                    batchId: log.batchId,
                    email: log.recipient,
                    event: status,
                    reason: row.reason,
                    sgMessageId: row.msgid,
                    timestamp: when
                } },
                { upsert: true }
            );
            events++;
            await EmailLog.updateOne(
                { batchId: log.batchId, recipient: log.recipient },
                { $set: { status, lastEventAt: when } }
            );
            updated++;
        } catch (err) {
            logger.error(`cpanelDeliveryPoller: row processing failed: ${err.message}`);
        }
    }
    return { polled: rows.length, updated, events };
}

module.exports = {
    mapTrackType, syntheticEventId, filterToSender, correlateRow,
    buildSearchUrl, parseSearchResponse, searchEmailTrack,
    shouldPoll, pollOnce
};
