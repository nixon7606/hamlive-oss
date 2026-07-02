/* hamlive-oss — MIT License. See LICENSE.
 *
 * Per-recipient email cooldown tracker.
 *
 * Prevents abuse by enforcing a minimum interval between emails sent to the
 * same recipient, regardless of which feature triggered the send. Every email
 * path (magic-link auth, net announcements, net reports) funnels through
 * EmailBase.sendMailToAddrs(), which calls this module before dispatching.
 *
 * The cooldown is in-memory only — it resets on server restart. This is
 * intentional: a restart is a reasonable response to a rate-limit issue, and
 * we avoid needing a database round-trip on every email send.
 *
 * Configure via environment variables:
 *   EMAIL_COOLDOWN_MINUTES  — how long to wait before sending to the same
 *                             address again (default: 5)
 *   EMAIL_MAX_PER_WINDOW    — maximum emails per recipient per window
 *                             (default: 2)
 */

const { logger } = require('./logger');

const DEFAULT_COOLDOWN_MINUTES = 5;
// 2, not 1: a ham who doesn't spot the first sign-in email and resubmits the
// form within the window should get a second one, not a silent skip. Two per
// 5 minutes is still far too slow to email-bomb anyone.
const DEFAULT_MAX_PER_WINDOW = 2;

// In-memory send record: Map<email, Array<timestamp_ms>>
const sendRecords = new Map();

// Periodic cleanup — purge entries older than 2× the cooldown window to
// prevent unbounded memory growth.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

/**
 * Get the configured cooldown window in milliseconds.
 */
function getWindowMs() {
    const minutes =
        parseInt(process.env.EMAIL_COOLDOWN_MINUTES, 10) || DEFAULT_COOLDOWN_MINUTES;
    return minutes * 60 * 1000;
}

/**
 * Get the maximum number of sends allowed per recipient per window.
 */
function getMaxPerWindow() {
    const val = parseInt(process.env.EMAIL_MAX_PER_WINDOW, 10);
    return Number.isFinite(val) && val > 0 ? val : DEFAULT_MAX_PER_WINDOW;
}

/**
 * Check whether an email send to `recipient` is allowed right now.
 *
 * Returns { allowed: boolean, reason?: string }.
 * If allowed, automatically records the send.
 *
 * @param {string} recipient — email address to check
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkAndRecordSend(recipient) {
    const windowMs = getWindowMs();
    const maxPerWindow = getMaxPerWindow();
    const now = Date.now();

    if (!sendRecords.has(recipient)) {
        sendRecords.set(recipient, []);
    }

    const timestamps = sendRecords.get(recipient);

    // Prune entries older than the cooldown window
    const recent = timestamps.filter(ts => now - ts < windowMs);

    if (recent.length >= maxPerWindow) {
        const oldestInWindow = recent[0];
        const remainingMs = windowMs - (now - oldestInWindow);
        const remainingSec = Math.ceil(remainingMs / 1000);
        const reason =
            `Cooldown active for ${recipient} — ` +
            `${recent.length}/${maxPerWindow} sends within the last ` +
            `${getWindowMs() / 60000}min window. Retry in ~${remainingSec}s.`;
        logger.warn(`[emailRateLimiter] ${reason}`);
        sendRecords.set(recipient, recent);
        return { allowed: false, reason };
    }

    // Record this send
    recent.push(now);
    sendRecords.set(recipient, recent);
    logger.debug(`[emailRateLimiter] Send recorded for ${recipient} (${recent.length}/${maxPerWindow} in window)`);
    return { allowed: true };
}

/**
 * Check multiple recipients at once. Returns two arrays:
 *   { allowed: string[], blocked: string[] }
 *
 * Recipients that pass the cooldown check are recorded automatically.
 *
 * @param {string[]} recipients — email addresses to check
 * @returns {{ allowed: string[], blocked: Array<{recipient: string, reason: string}> }}
 */
function checkBulk(recipients) {
    const allowed = [];
    const blocked = [];

    for (const r of recipients) {
        const result = checkAndRecordSend(r);
        if (result.allowed) {
            allowed.push(r);
        } else {
            blocked.push({ recipient: r, reason: result.reason });
        }
    }

    return { allowed, blocked };
}

/**
 * Get the number of seconds remaining in the cooldown for a recipient.
 * Returns 0 if no cooldown is active.
 *
 * @param {string} recipient
 * @returns {number} — seconds remaining, 0 = no cooldown
 */
function getCooldownRemaining(recipient) {
    if (!sendRecords.has(recipient)) return 0;

    const windowMs = getWindowMs();
    const maxPerWindow = getMaxPerWindow();
    const now = Date.now();
    const recent = sendRecords.get(recipient).filter(ts => now - ts < windowMs);

    if (recent.length < maxPerWindow) return 0;

    const oldestInWindow = recent[0];
    const remainingMs = windowMs - (now - oldestInWindow);
    return Math.ceil(Math.max(0, remainingMs) / 1000);
}

/**
 * Manually clear the cooldown for a recipient (e.g., for testing or admin
 * override).
 *
 * @param {string} recipient
 */
function clearCooldown(recipient) {
    sendRecords.delete(recipient);
    logger.info(`[emailRateLimiter] Cooldown cleared for ${recipient}`);
}

/**
 * Reset all cooldown records. Useful in tests.
 */
function resetAll() {
    sendRecords.clear();
}

// Periodic cleanup to prevent memory leaks
setInterval(() => {
    const windowMs = getWindowMs();
    const cutoff = Date.now() - windowMs * 2; // keep 2× window
    let pruned = 0;
    for (const [recipient, timestamps] of sendRecords.entries()) {
        const recent = timestamps.filter(ts => ts > cutoff);
        if (recent.length === 0) {
            sendRecords.delete(recipient);
            pruned++;
        } else {
            sendRecords.set(recipient, recent);
        }
    }
    if (pruned > 0) {
        logger.debug(`[emailRateLimiter] Pruned ${pruned} stale recipient records`);
    }
}, CLEANUP_INTERVAL_MS).unref();

module.exports = {
    checkAndRecordSend,
    checkBulk,
    getCooldownRemaining,
    clearCooldown,
    resetAll,
    getWindowMs,
    getMaxPerWindow
};