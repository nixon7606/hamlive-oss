/* hamlive-oss — MIT License. See LICENSE. */

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { logger } = require('./logger');

// Generous on purpose: the per-recipient cooldown in EmailBase.sendMailToAddrs()
// (1 email / 5 min per address) is the real anti-abuse control. This HTTP limiter
// only guards a single IP from hammering the endpoint, so it can be loose enough
// not to block shared/NAT'd networks (clubs, events, public Wi-Fi) where many
// operators legitimately sign in from one public IP.
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PER_WINDOW = 20;

// Resolve the real client IP. Behind a Cloudflare Tunnel the origin connection is
// the local cloudflared daemon, so req.ip is loopback (::1) for EVERY visitor —
// keying the limiter on it bucketed all sign-ins together and threw 429s at real
// users during busy periods. CF-Connecting-IP is the true visitor IP (Cloudflare
// always sets it; trustworthy because the origin is reachable only via the tunnel).
function clientIp(req) {
    return (req.headers && req.headers['cf-connecting-ip'])
        || req.ip
        || (req.connection && req.connection.remoteAddress)
        || '';
}

const magicLoginLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: MAX_PER_WINDOW,
    standardHeaders: true,
    legacyHeaders: false,
    // Key on the real per-visitor IP, not the shared ::1 socket. ipKeyGenerator
    // normalizes IPv6 (/56) so the limit isn't trivially bypassable (express-rate-limit v8).
    keyGenerator: req => ipKeyGenerator(clientIp(req)),
    handler: (req, res, _next, options) => {
        logger.warn(`[magicLoginLimiter] blocked sign-in attempt from ${clientIp(req)}`);
        res.status(options.statusCode).json(options.message);
    },
    message: { error: 'Too many sign-in attempts. Please try again in a few minutes.' }
});

module.exports = { magicLoginLimiter, clientIp, WINDOW_MS, MAX_PER_WINDOW };
