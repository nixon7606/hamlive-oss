/* hamlive-oss — MIT License. See LICENSE. */
/**
 * cPanel Track Delivery poller — fills the EmailLog/EmailEvent pipeline for
 * SMTP sends the way the SendGrid event webhook does for SendGrid sends.
 * Data source: cPanel API 2 EmailTrack::search (user-level token; NOT UAPI —
 * UAPI has no EmailTrack module). See docs/superpowers/specs/
 * 2026-07-01-cpanel-delivery-tracking.md for the verified endpoint shape.
 */
const crypto = require('crypto');

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

module.exports = { mapTrackType, syntheticEventId, filterToSender, correlateRow };
