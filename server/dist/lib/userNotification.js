/* hamlive-oss — MIT License. See LICENSE. */

const { getUserProfile } = require('../models/userProfile');
const { conf } = require('../lib/configLib');
const { checkBulk } = require('./emailRateLimiter');
const crypto = require('crypto');
const { getEmailLog } = require('../models/emailLog');
const { getActiveTransport, ConsoleTransport, SmtpTransport, isRealSenderActive } = require('./emailTransports');

// Email delivery is optional. When SENDGRID_API_KEY is absent, messages are
// logged to the server console instead of being sent (see INSTALL.md,
// "Local test drive"). The sender address is configurable via EMAIL_FROM and
// must be a verified sender in your SendGrid account when email is enabled.
const EMAIL_FROM =
    process.env.EMAIL_FROM || conf.email_from || `${conf.app_name || 'Ham.Live'} <no-reply@example.com>`;
const humanizeDuration = require('humanize-duration');
const { getFlexOptionsByUser, fetchChatLog } = require('../lib/serverUtils');
const { logger } = require('./logger');
// NOTE: roomHistory import removed - now using fetchChatLog from serverUtils which uses GetStream
const slugify = require('slugify');
const mongoose = require('mongoose');
const validator = require('validator');

class EmailBase {
    #subject;
    #message;
    #body;
    type;

    constructor(param = {}) {
        const { subject, message, body, type } = param;

        this.#subject = subject;
        this.#message = message;
        this.#body = body;
        this.type = type || 'generic';

        if (!body && !(subject && message)) {
            throw new Error('In the constructor, if "body" is missing, both "subject" and "message" are mandatory.');
        }
    }

    get body() {
        return this.#body;
    }

    async sendMailToAddrs(recipients) {
        if (!Array.isArray(recipients)) {
            const error = 'Invalid parameter: recipients should be an array';
            logger.error(`sendMailToAddrs() ${error}`);
            throw new Error(error);
        }

        if (!recipients.length) {
            const error = 'Invalid parameter: recipients array is empty';
            logger.error(`sendMailToAddrs() ${error}`);
            throw new Error(error);
        }

        const uniqueRecipients = this.getUniqueRecipients(recipients);
        const validRecipients = this.getValidRecipients(uniqueRecipients);

        if (validRecipients.length !== uniqueRecipients.length) {
            logger.error('sendMailToAddrs() contains invalid email addresses');
            throw new Error('Invalid email addresses in recipients');
        }

        if (uniqueRecipients.length !== recipients.length) {
            logger.warn('sendMailToAddrs() contains duplicate email addresses');
        }

        // Per-recipient cooldown: skip recipients that were recently emailed
        const { allowed, blocked } = checkBulk(validRecipients);
        if (blocked.length > 0) {
            for (const b of blocked) {
                logger.warn(
                    `[emailRateLimiter] Skipping ${b.recipient} — ${b.reason}`
                );
            }
        }
        if (allowed.length === 0) {
            logger.warn(
                'sendMailToAddrs() — all recipients are in cooldown, no email sent'
            );
            return;
        }

        const batchId = crypto.randomUUID();
        try {
            const subject = this.getSubject();
            const emailData = this.buildMessage(allowed, subject);
            emailData.customArgs = { ...(emailData.customArgs || {}), hlType: this.type, hlBatch: batchId };
            const messageId = await this.sendEmailWithRetry(emailData, allowed);
            if (await isRealSenderActive()) {
                const transport = await getActiveTransport(); // cached — cheap
                const initialStatus = transport instanceof SmtpTransport ? 'accepted' : 'queued';
                this.recordEmailLogs(allowed, subject, batchId, messageId, initialStatus);
            }
        } catch (err) {
            logger.error(`Failed to send mail: ${err.message}`);
            throw err;
        }
    }

    getUniqueRecipients(recipients) {
        return [...new Set(recipients)];
    }

    getValidRecipients(uniqueRecipients) {
        return uniqueRecipients.filter(email => validator.isEmail(email));
    }

    getSubject() {
        return this.#subject || this.body?.subject || this.body?.dynamic_template_data?.subject;
    }

    // Build the normalized transport message from this email's body/subject/message:
    // - body branch: uses b.subject (present for html bodies, absent for templated) rather than
    //   the passed subject param, so NetCloseReport never gains a spurious top-level subject.
    // - attachments: normalized to { filename, contentBase64, contentType, contentId? } with
    //   content_id carried through so the round-trip is lossless.
    buildMessage(validRecipients, subject) {
        const b = this.#body;
        if (b) {
            const msg = { to: validRecipients, from: b.from || EMAIL_FROM };
            if (b.subject) msg.subject = b.subject;
            if (b.html) msg.html = b.html;
            if (b.templateId) { msg.templateId = b.templateId; msg.templateData = b.dynamic_template_data || {}; }
            if (b.attachments) {
                // b.attachments may already be SG-shaped (content/type) — normalize, preserving content_id.
                msg.attachments = b.attachments.map(a => ({
                    filename: a.filename,
                    contentBase64: a.content,
                    contentType: a.type,
                    ...(a.content_id ? { contentId: a.content_id } : {}),
                }));
            }
            return msg;
        }
        return { to: validRecipients, from: EMAIL_FROM, subject, html: this.#message };
    }

    async sendEmailWithRetry(emailData, validRecipients) {
        // emailData carries customArgs assembled in sendMailToAddrs; merge onto the message.
        const transport = await getActiveTransport();
        if (transport instanceof ConsoleTransport) {
            const subject = emailData.subject || '(templated email)';
            logger.info(`[email disabled] Would send "${subject}" to ${validRecipients.join(', ')}`);
            // Still return null id; the caller gates EmailLog writes on isRealSenderActive().
            return null;
        }
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const { messageId } = await transport.send(emailData);
                logger.info(`Mail successfully handed to transport for ${validRecipients.length} recipients`);
                return messageId;
            } catch (err) {
                if (attempt < 2) {
                    logger.warn(`Transport send failed on attempt ${attempt + 1}: ${err.message}. Retrying...`);
                } else {
                    logger.error(`Transport send failed on final attempt: ${err.message}`);
                    throw err;
                }
            }
        }
    }
    recordEmailLogs(recipients, subject, batchId, sgMessageId, status = 'queued') {
        const EmailLog = getEmailLog();
        Promise.all(recipients.map(r => EmailLog.create({
            recipient: r, type: this.type, subject, batchId, sgMessageId, status
        }))).catch(err => logger.error(`recordEmailLogs() failed: ${err.message}`));
    }

    async sendMailToUPIDs({ upids, db = mongoose.connection }) {
        try {
            const UserProfile = getUserProfile(db);

            if (!Array.isArray(upids)) {
                logger.error('sendMailToUPIDs() expects upids array as param');
                throw new Error('Invalid parameter: UPIDs should be an array');
            }

            if (!upids.length) {
                logger.error('sendMailToUPIDs() UPIDs array length 0');
                throw new Error('Invalid parameter: UPIDs array is empty');
            }

            const users = await Promise.all(
                upids.map(upid =>
                    UserProfile.findById(upid).catch(err => {
                        logger.error(`Error fetching user profile for UPID ${upid}: ${err.message}`);
                        return null;
                    })
                )
            ).then(users => users.filter(user => user !== null));

            if (!users.length) {
                logger.warn('No valid user profiles found for provided UPIDs');
                return;
            }

            const boolArray = await Promise.all(
                users.map(async user => {
                    try {
                        return (await getFlexOptionsByUser({ user, cachedResponse: false, db })).email;
                    } catch (err) {
                        logger.error(`Error fetching flex options for user ${user._id}: ${err.message}`);
                        return false;
                    }
                })
            );

            const recipients = users.filter((value, index) => boolArray[index]).map(user => user.email);

            if (recipients?.length) {
                await this.sendMailToAddrs(recipients);
            } else {
                logger.info(
                    `All intended recipients of "${
                        this.body?.subject || this.body.dynamic_template_data.subject
                    }" have email disabled`
                );
            }
        } catch (err) {
            logger.error(`Error in sendMailToUPIDs: ${err.message}`);
        }
    }
}

class NetAnnounceStart extends EmailBase {
    static async init({ netControl, netProfileDoc: { title }, liveNetDoc: { countdownTimer, url } }) {
        const humanTime = countdownTimer <= 1
            ? 'now'
            : 'in ' + humanizeDuration(countdownTimer * 60 * 1000, { largest: 2, round: true, delimiter: '--', units: ['h', 'm'] });
        const { renderTemplate } = require('./templateService');
        const data = {
            netControl, title, humanTime,
            url: `${conf.base_url}${url}`,
            favoritesUrl: `${conf.base_url}/views/favorites`
        };
        const { subject, html } = await renderTemplate('net-announce', data);
        const inst = new NetAnnounceStart({ body: { from: EMAIL_FROM, subject, html } });
        inst.type = 'net-announce';
        return inst;
    }
}

class NetCloseReport extends EmailBase {
    // Static private symbol used to control constructor access
    static #_internal = Symbol('internal');

    // Private properties
    #title;
    #NPID;
    #attendees;

    // Static async constructor
    static async init({ netProfileDoc: { id: NPID, title, schedule }, liveNetDoc: { url, started, startedAt }, attendees }) {
        // Default timezone if not set
        const netTZ = (schedule && schedule.timezone) || 'UTC';

        // Attempt to fetch chat log, but continue with empty log if it fails
        let chatLog = null;
        try {
            chatLog = await fetchChatLog({ NPID, since: attendees[0]?.checkedInAt });
        } catch (chatErr) {
            logger.warn(`Failed to fetch chat log for NPID: ${NPID}. Error: ${chatErr.message}`);
            logger.info('Continuing report generation without chat log (chat service unavailable)');
            // chatLog remains null - report will be generated without it
        }

        // Pass the private symbol when calling the actual constructor
        // Report is always created, with or without chat log
        const inst = new NetCloseReport(NetCloseReport.#_internal, {
            title,
            NPID,
            netTZ,
            url,
            started,
            startedAt,
            attendees,
            chatLog
        });

        const { renderTemplate } = require('./templateService');
        const { html } = await renderTemplate('net-close', inst._templateData);
        inst.body.html = html;   // EmailBase.buildMessage reads body.html
        return inst;
    }

    // Private constructor
    constructor(key, { title, NPID, netTZ, url, started, startedAt, attendees, chatLog }) {
        // Check if the key matches the private static symbol
        if (key !== NetCloseReport.#_internal) {
            throw new Error('NetCloseReport constructor is private. Use NetCloseReport.init() instead.');
        }

        // Perform computations before calling super()
        const sortedAttendees = NetCloseReport.#sortAttendees(attendees);
        const formattedAttendees = NetCloseReport.#formatAttendees(sortedAttendees, netTZ);
        const attachments = NetCloseReport.#createAttachments({
            title,
            NPID,
            netTZ,
            url,
            started,
            startedAt,
            formattedAttendees,
            chatLog
        });

        // Call the parent class constructor
        super({
            body: {
                from: EMAIL_FROM,
                subject: `${title} - Net Close Report`,
                attachments: attachments
            }
        });

        // Stash template data so init() can render it and inject body.html
        this._templateData = {
            subject: `${title} - Net Close Report`,
            url: `${conf.base_url}${url}`,
            title,
            formattedAttendees,
            startedAtString: started ? NetCloseReport.#fmtDatetime(startedAt, netTZ) : '',
            timezoneAbbr: new Intl.DateTimeFormat('en-US', { timeZone: netTZ, timeZoneName: 'short' })
                .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || 'Local'
        };

        // Set instance properties
        this.type = 'net-close-report';
        this.#title = title;
        this.#NPID = NPID;
        this.#attendees = sortedAttendees;
        this.#reportGeneration();

        logger.debug(this._templateData);
    }

    // Private method to log report generation
    #reportGeneration() {
        logger.info(
            `Generating Report for ${this.#title} (NPID:${this.#NPID}): ${this.#attendees
                .map(attendee => attendee.callSign)
                .join(', ')}`
        );
    }

    // Format a Date/timestamp as locale string in the net's timezone
    // e.g., "Sat, Jun 21, 2026, 7:30 AM MDT"
    static #fmtDatetime(ts, tz) {
        return new Date(ts).toLocaleString('en-US', {
            timeZone: tz,
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short'
        });
    }

    // Format just the time portion in the net's timezone
    // e.g., "7:30 AM MDT"
    static #fmtTime(ts, tz) {
        return new Date(ts).toLocaleString('en-US', {
            timeZone: tz,
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short'
        });
    }

    // Static method to sort attendees
    static #sortAttendees(attendees) {
        // Sorting logic based on role and check-in time
        return attendees.sort((a, b) => {
            const rolePriority = { netcontrol: 1, netlogger: 2, netrelay: 3 };
            const aRole = rolePriority[a.role] || 4;
            const bRole = rolePriority[b.role] || 4;

            if (aRole !== bRole) {
                return aRole - bRole;
            }

            return new Date(a.checkedInAt) - new Date(b.checkedInAt);
        });
    }

    // Static method to format attendees
    static #formatAttendees(attendees, tz) {
        // Formatting attendee data for the report
        return attendees.map(a => ({
            callSign: a.callSign,
            role:
                a.role === 'netcontrol'
                    ? 'NCS'
                    : a.role === 'netrelay'
                      ? 'Relay'
                      : a.role === 'netlogger'
                        ? 'Logger'
                        : '',
            checkInIsoDate: new Date(a.checkedInAt).toISOString(),
            checkInTime: tz ? NetCloseReport.#fmtTime(a.checkedInAt, tz) : new Date(a.checkedInAt).toUTCString().split(' ').slice(4).join(' '),
            displayName: a.displayName || '',
            location: a.location || '',
            sigReport: a.rst || '',
            highlight: a.highlight || false
        }));
    }

    // Static method to create email attachments
    static #createAttachments({ title, NPID, netTZ, url, started, startedAt, formattedAttendees, chatLog }) {
        // Header and chat log:
        const chatHeader = `${title} (ID: ${NPID})\n\n`;
        const chatLogString = chatLog ? chatHeader + chatLog : chatHeader + '[ Empty Chat Log ]';

        const csvString = [
            [
                'Net',
                'Callsign',
                'Role',
                'Highlighted',
                'Check-In Date',
                'Name',
                'Location',
                'SigReport',
                'URL',
                'Net ID',
                'Net Start Date'
            ],
            ...formattedAttendees.map(a => [
                title,
                a.callSign,
                a.role,
                a.highlight ? 'True' : '',
                `"${a.checkInIsoDate}"`,
                `"${a.displayName}"`,
                `"${a.location}"`,
                a.sigReport,
                `${conf.base_url}${url}`,
                NPID,
                started ? new Date(startedAt).toISOString() : ''
            ])
        ]
            .map(e => e.join(','))
            .join('\n');

        const slug = slugify(title, {
            replacement: '_',
            lower: true,
            strict: true,
            locale: 'vi',
            trim: true
        });

        const formattedStartedAt = startedAt
            ? new Date(startedAt).toISOString().replace(/[:.]/g, '-')
            : 'in_pre-start_grace_period';

        // Returning attachments array
        return [
            {
                content: Buffer.from(csvString, 'utf8').toString('base64'),
                filename: `${slug}_${formattedStartedAt}_report.csv`,
                type: 'text/csv',
                disposition: 'attachment',
                content_id: 'report'
            },
            {
                content: Buffer.from(chatLogString, 'utf8').toString('base64'),
                filename: `${slug}_${formattedStartedAt}_chat.txt`,
                type: 'text/plain',
                disposition: 'attachment',
                content_id: 'chatlog'
            }
        ];
    }
}

module.exports = {
    EmailBase,
    NetAnnounceStart,
    NetCloseReport
};
