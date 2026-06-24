/* hamlive-oss — MIT License. See LICENSE.
 *
 * One-time migration: drop the `magicLink` field from every emaillogs document.
 *
 * A reverted feature (commit 9dfe63d) briefly persisted live magic sign-in URLs
 * into the EmailLog collection. Those are bearer credentials and must not live
 * at rest. This script removes the field from all existing documents. It is
 * idempotent — safe to run repeatedly; documents without the field are untouched.
 *
 * Usage, run from the app root (e.g. /opt/hamlive) so node_modules resolves:
 *   node scripts/purge-emaillog-magiclink.js
 *
 * Reads MONGODB_URI from the environment; if not set (e.g. run outside the
 * systemd unit), it falls back to parsing ./.env. No schema/model needed —
 * it updates the emaillogs collection directly.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

function resolveMongoUri() {
    if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
    const envPath = path.join(__dirname, '..', '.env');
    const line = fs
        .readFileSync(envPath, 'utf8')
        .split('\n')
        .find(l => l.startsWith('MONGODB_URI='));
    if (!line) throw new Error('MONGODB_URI not in environment or .env');
    return line.slice('MONGODB_URI='.length).trim();
}

(async () => {
    await mongoose.connect(resolveMongoUri());
    try {
        const res = await mongoose.connection
            .collection('emaillogs')
            .updateMany({ magicLink: { $exists: true } }, { $unset: { magicLink: '' } });
        console.log(`matched=${res.matchedCount} modified=${res.modifiedCount} — magicLink purged from emaillogs`);
    } finally {
        await mongoose.disconnect();
    }
})().catch(e => {
    console.error(e.message);
    process.exit(1);
});
