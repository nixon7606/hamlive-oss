/* hamlive-oss — MIT License. See LICENSE. */
const path = require('path');
const fs = require('fs');
const YAML = require('yaml');
const _ = require('lodash');

// Load environment variables from a root .env file if present.
// Secrets and instance-specific values live in .env (or the real environment),
// never in the committed YAML. See .env.example and INSTALL.md.
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

let baseConfigf;
let commonConfigf;
let conf = {};

try {
    commonConfigf = fs.readFileSync(path.resolve(__dirname, '../commonConfig.yaml'), 'utf8');

    if (process.env.NODE_ENV === 'development') {
        baseConfigf = fs.readFileSync(path.resolve(__dirname, '../devConfig.yaml'), 'utf8');
    } else {
        baseConfigf = fs.readFileSync(path.resolve(__dirname, '../prodConfig.yaml'), 'utf8');
    }

    conf = _.merge(YAML.parse(commonConfigf), YAML.parse(baseConfigf));
} catch (err) {
    console.error(err.stack);
}

// Overlay secrets / instance config from environment variables.
// Every integration is optional: when its variables are absent the related
// feature degrades gracefully (see INSTALL.md, "Local test drive").
const fromEnv = {
    dburi: process.env.MONGODB_URI,
    base_url: process.env.BASE_URL,
    cookie_session_key: process.env.COOKIE_SESSION_KEY,
    magic_link_secret: process.env.MAGIC_LINK_SECRET,
    sendgrid_api_key: process.env.SENDGRID_API_KEY,
    sendgrid_webhook_verification_key: process.env.SENDGRID_WEBHOOK_VERIFICATION_KEY,
    chat_upload_dir: process.env.CHAT_UPLOAD_DIR,
    stream_api_key: process.env.STREAM_API_KEY,
    stream_api_secret: process.env.STREAM_API_SECRET,
    google_client_id: process.env.GOOGLE_CLIENT_ID,
    google_client_secret: process.env.GOOGLE_CLIENT_SECRET,
    qrz_username: process.env.QRZ_USERNAME,
    qrz_password: process.env.QRZ_PASSWORD,
    geo_key: process.env.GEO_KEY,
    cmd_help_url: process.env.CMD_HELP_URL,
    app_name: process.env.APP_NAME,
    // Ads & analytics provider IDs (optional; only used when the matching
    // feature is enabled below). Use your OWN accounts — never the project's.
    adplugg_access_code: process.env.ADPLUGG_ACCESS_CODE,
    google_analytics_id: process.env.GOOGLE_ANALYTICS_ID
};

for (const [key, value] of Object.entries(fromEnv)) {
    if (value !== undefined && value !== '') {
        conf[key] = value;
    }
}

// Feature toggles — OFF by default in the community edition (see commonConfig.yaml).
// Enable explicitly with ADS_ENABLED=true / ANALYTICS_ENABLED=true.
if (process.env.ADS_ENABLED !== undefined) {
    conf.ads_enabled = process.env.ADS_ENABLED === 'true';
}
if (process.env.ANALYTICS_ENABLED !== undefined) {
    conf.analytics_enabled = process.env.ANALYTICS_ENABLED === 'true';
}

// Per-host background-task override. The repo ships scheduledNetStarter enabled
// (see {dev,prod}Config.yaml); a host can disable its scheduled-net auto-start
// without editing committed YAML by setting SCHEDULED_NET_STARTER_ENABLED=false
// in its .env. Gates BOTH the tasksLoader run and the 60s interval in server.js.
if (process.env.SCHEDULED_NET_STARTER_ENABLED !== undefined) {
    _.set(conf, 'background_tasks.scheduledNetStarter.enabled', process.env.SCHEDULED_NET_STARTER_ENABLED === 'true');
}

// Per-host cPanel delivery-poller override. The repo ships cpanelDeliveryPoller
// enabled (see {dev,prod}Config.yaml); a host can disable the 5-minute tracking
// interval without editing committed YAML by setting CPANEL_DELIVERY_POLLER_ENABLED=false
// in its .env. The interval is a cheap no-op unless provider=smtp and tracking are enabled
// (checked per tick inside pollOnce, so admin changes apply without restart).
if (process.env.CPANEL_DELIVERY_POLLER_ENABLED !== undefined) {
    _.set(conf, 'background_tasks.cpanelDeliveryPoller.enabled', process.env.CPANEL_DELIVERY_POLLER_ENABLED === 'true');
}

// ---------------------------------------------------------------------------
// Secret-strength guard
// ---------------------------------------------------------------------------
// Checks that signing secrets meet a minimum strength bar.  Returns an array
// of human-readable problem strings (empty means all OK).  Kept as a pure
// function so it can be unit-tested without side effects.
const WEAK_DEFAULTS = ['dev-cookie-key-change-me', 'dev-magic-link-secret-change-me', 'change-me', 'changeme', 'secret'];
function checkSecrets(c) {
    const problems = [];
    const check = (name, val) => {
        if (!val || typeof val !== 'string' || val.length < 32 || WEAK_DEFAULTS.includes(val)) {
            problems.push(`${name} is missing, too short (<32 chars), or a known default — set a strong unique value.`);
        }
    };
    check('COOKIE_SESSION_KEY', c.cookie_session_key);
    check('MAGIC_LINK_SECRET', c.magic_link_secret);
    return problems;
}

const secretProblems = checkSecrets(conf);
if (secretProblems.length) {
    if (process.env.NODE_ENV === 'production') {
        const msg = 'FATAL: insecure secrets — refusing to start in production:\n  - ' + secretProblems.join('\n  - ');
        console.error(msg);
        throw new Error(msg);
    } else {
        console.warn('WARNING: insecure secrets (OK for local dev, NEVER for production):\n  - ' + secretProblems.join('\n  - '));
    }
}

module.exports.conf = conf;
module.exports.checkSecrets = checkSecrets;
