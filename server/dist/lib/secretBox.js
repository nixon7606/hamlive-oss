/* hamlive-oss — MIT License. See LICENSE. */
const crypto = require('crypto');
const { conf } = require('./configLib');

// Master key material: a dedicated EMAIL_SECRET_KEY if set, else the app's
// cookie session key. NOTE: rotating this invalidates every stored SMTP
// password (admins must re-enter it). Documented in .env.example.
function masterKeyMaterial() {
    const m = process.env.EMAIL_SECRET_KEY || conf.cookie_session_key;
    if (!m || typeof m !== 'string' || m.length < 16) {
        throw new Error('secretBox: no key material (set EMAIL_SECRET_KEY or COOKIE_SESSION_KEY)');
    }
    return m;
}

function deriveKey(salt) {
    return crypto.scryptSync(masterKeyMaterial(), salt, 32);
}

function encryptSecret(plaintext) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', salt, iv, tag, ct].map((p, i) => (i === 0 ? p : p.toString('base64'))).join(':');
}

function decryptSecret(token) {
    const [v, saltB64, ivB64, tagB64, ctB64] = String(token).split(':');
    if (v !== 'v1') throw new Error('secretBox: unknown token version');
    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const key = deriveKey(salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
