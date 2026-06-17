/* hamlive-oss — MIT License. See LICENSE.
 *
 * One-time local setup: create a .env from .env.example if one does not exist.
 * Cross-platform (Windows / macOS / Linux). Run with: bun run setup
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const example = path.join(root, '.env.example');
const target = path.join(root, '.env');

if (fs.existsSync(target)) {
    console.log('.env already exists — leaving it untouched.');
} else {
    fs.copyFileSync(example, target);
    console.log('Created .env from .env.example.');
    console.log('Defaults are set up for a zero-account local test drive.');
}

const certKey = path.join(root, 'server', 'dist', 'ssl', 'dev-server_key.pem');
if (!fs.existsSync(certKey)) {
    console.log('\nNo local dev TLS certificate found.');
    console.log('Generate one with:  bun run gen-certs   (requires openssl)');
}

console.log('\nNext steps:');
console.log('  1. docker compose up -d     # start local MongoDB');
console.log('  2. bun run dev             # start the app');
console.log('  3. open http://localhost:3000 and sign in with an email link');
console.log('     (with no email provider configured, the sign-in link appears right on the page)');
