/* hamlive-oss — MIT License. See LICENSE.
 *
 * Grant (or revoke) the superUser (admin) flag on an account, by email.
 *
 * Usage, run from the app root (/opt/hamlive) so node_modules resolves:
 *   node scripts/grant-admin.js <email>            # grant admin
 *   node scripts/grant-admin.js <email> --revoke   # remove admin
 *
 * Reads MONGODB_URI from the environment; if not set (e.g. run outside the
 * systemd unit), it falls back to parsing ./.env. No schema/model needed —
 * it updates the userprofiles collection directly. A page refresh picks up
 * the change (deserializeUser reads the user fresh each request).
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
    const email = process.argv[2];
    const revoke = process.argv.includes('--revoke');
    if (!email) {
        console.error('Usage: node scripts/grant-admin.js <email> [--revoke]');
        process.exit(1);
    }
    await mongoose.connect(resolveMongoUri());
    try {
        const res = await mongoose.connection
            .collection('userprofiles')
            .updateOne({ email }, { $set: { superUser: !revoke } });
        console.log(`matched=${res.matchedCount} modified=${res.modifiedCount} -> ${email} superUser=${!revoke}`);
        if (res.matchedCount === 0) {
            console.error('No account found with that email — use the exact address you sign in with.');
            process.exitCode = 2;
        }
    } finally {
        await mongoose.disconnect();
    }
})().catch(e => {
    console.error(e.message);
    process.exit(1);
});
