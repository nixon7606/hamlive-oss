/* hamlive-oss — MIT License. See LICENSE. */
const { EventWebhook } = require('@sendgrid/eventwebhook');
const { logger } = require('./logger');

/**
 * Verify a SendGrid Signed Event Webhook request.
 * @param {Buffer} rawBody  raw request body bytes
 * @param {string} signature  X-Twilio-Email-Event-Webhook-Signature header
 * @param {string} timestamp  X-Twilio-Email-Event-Webhook-Timestamp header
 * @param {string} publicKey  base64 verification key from SendGrid
 * @returns {boolean}
 */
function verifySignature(rawBody, signature, timestamp, publicKey) {
    if (!publicKey || !signature || !timestamp) return false;
    try {
        const ew = new EventWebhook();
        const ecdsaKey = ew.convertPublicKeyToECDSA(publicKey);
        return ew.verifySignature(ecdsaKey, rawBody, signature, timestamp);
    } catch (err) {
        logger.warn(`SendGrid webhook signature verify error: ${err.message}`);
        return false;
    }
}

module.exports = { verifySignature };
