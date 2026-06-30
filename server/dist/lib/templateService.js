/* hamlive-oss — MIT License. See LICENSE. */
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const { getEmailTemplate } = require('../models/emailTemplate');
const { logger } = require('./logger');

const EMAIL_DIR = path.resolve(__dirname, '../views/emails');

const DEFAULT_SUBJECTS = {
    'magic-link':   'Sign in to netcontrol.live',
    'net-announce': '{{title}}(★) is going live {{humanTime}} !',
    'net-close':    '{{title}} - Net Close Report'
};

const TEMPLATE_KEYS = ['magic-link', 'net-announce', 'net-close'];

const TEMPLATE_META = {
    'magic-link':   { label: 'Sign-in (magic link)', variables: ['link'],
                      sample: { link: 'https://example.com/auth/magiclogin/callback?token=SAMPLE' } },
    'net-announce': { label: 'Net going live', variables: ['netControl', 'title', 'url', 'favoritesUrl', 'humanTime'],
                      sample: { netControl: 'K1ABC', title: 'Sunday Rag Chew', url: 'https://example.com/p/sunday',
                                favoritesUrl: 'https://example.com/views/favorites', humanTime: 'in 10 minutes' } },
    'net-close':    { label: 'Net Close Report', variables: ['subject', 'title', 'url', 'startedAtString', 'timezoneAbbr', 'formattedAttendees'],
                      sample: { subject: 'Sunday Rag Chew - Net Close Report', title: 'Sunday Rag Chew',
                                url: 'https://example.com/p/sunday', startedAtString: 'Sat, Jun 21, 2026, 7:30 AM MDT',
                                timezoneAbbr: 'MDT',
                                formattedAttendees: [
                                  { role: 'NCS', callSign: 'K1ABC', displayName: 'Al', checkInTime: '7:30 AM', highlight: false },
                                  { role: '', callSign: 'W2DEF', displayName: 'Bea', checkInTime: '7:32 AM', highlight: true }
                                ] } }
};

function getDefault(key) {
    const html = fs.readFileSync(path.join(EMAIL_DIR, `${key}.hbs`), 'utf8');
    return { subject: DEFAULT_SUBJECTS[key], html };
}

async function loadTemplate(key, { useDefault = false } = {}) {
    if (!useDefault) {
        try {
            const doc = await getEmailTemplate().findOne({ key });
            if (doc) return { subject: doc.subject, html: doc.html };
        } catch (err) {
            logger.warn(`templateService: DB load failed for ${key}, using default: ${err.message}`);
        }
    }
    return getDefault(key);
}

async function renderTemplate(key, data, opts = {}) {
    const { subject, html } = await loadTemplate(key, opts);
    return {
        subject: Handlebars.compile(subject, { noEscape: true })(data),
        html: Handlebars.compile(html)(data)
    };
}

async function seedTemplates() {
    const T = getEmailTemplate();
    for (const key of TEMPLATE_KEYS) {
        const exists = await T.findOne({ key }).lean();
        if (!exists) {
            const def = getDefault(key);
            await T.create({ key, subject: def.subject, html: def.html });
            logger.info(`templateService: seeded default email template "${key}"`);
        }
    }
}

module.exports = { TEMPLATE_KEYS, TEMPLATE_META, getDefault, renderTemplate, seedTemplates };
