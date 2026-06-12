/* hamlive-oss — MIT License. See LICENSE. */

const { getUserProfile } = require('../models/userProfile');
const sgMail = require('@sendgrid/mail');
const { conf } = require('../lib/configLib');
const { checkBulk } = require('./emailRateLimiter');
const crypto = require('crypto');
const { getEmailLog } = require('../models/emailLog');

// Email delivery is optional. When SENDGRID_API_KEY is absent, messages are
// logged to the server console instead of being sent (see INSTALL.md,
// "Local test drive"). The sender address is configurable via EMAIL_FROM and
// must be a verified sender in your SendGrid account when email is enabled.
const emailEnabled = Boolean(conf.sendgrid_api_key);
const EMAIL_FROM =
    process.env.EMAIL_FROM || conf.email_from || `${conf.app_name || 'Ham.Live'} <no-reply@example.com>`;
if (emailEnabled) {
    sgMail.setApiKey(conf.sendgrid_api_key);
}
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
            const emailData = this.getEmailData(allowed, subject);
            emailData.customArgs = { ...(emailData.customArgs || {}), hlType: this.type, hlBatch: batchId };
            const sgMessageId = await this.sendEmailWithRetry(emailData, allowed);
            this.recordEmailLogs(allowed, subject, batchId, sgMessageId);
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

    getEmailData(validRecipients, subject) {
        return this.#body
            ? { ...this.#body, to: validRecipients }
            : {
                  to: validRecipients,
                  from: EMAIL_FROM,
                  subject: subject,
                  html: this.#message
              };
    }

    async sendEmailWithRetry(emailData, validRecipients) {
        if (!emailEnabled) {
            const subject =
                emailData.subject || emailData.dynamic_template_data?.subject || '(templated email)';
            logger.info(`[email disabled] Would send "${subject}" to ${validRecipients.join(', ')}`);
            return null;
        }
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const [response] = await sgMail.sendMultiple(emailData);
                logger.info(`Mail successfully sent to SendGrid for ${validRecipients.length} recipients`);
                return response?.headers?.['x-message-id'] || null;
            } catch (err) {
                if (attempt < 2) {
                    logger.warn(`Failed to send to SendGrid on attempt ${attempt + 1}: ${err.message}. Retrying...`);
                } else {
                    logger.error(`Failed to send to SendGrid on final attempt: ${err.message}`);
                    throw err;
                }
            }
        }
    }
    recordEmailLogs(recipients, subject, batchId, sgMessageId) {
        if (!emailEnabled) return;
        const EmailLog = getEmailLog();
        Promise.all(recipients.map(r => EmailLog.create({
            recipient: r, type: this.type, subject, batchId, sgMessageId, status: 'queued'
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
                this.sendMailToAddrs(recipients);
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
    constructor({ netControl, netProfileDoc: { title }, liveNetDoc: { countdownTimer, url } }) {
        let humanTime;

        if (countdownTimer <= 1) {
            humanTime = 'now';
        } else {
            humanTime =
                'in ' +
                humanizeDuration(countdownTimer * 60 * 1000, {
                    largest: 2,
                    round: true,
                    delimiter: '--',
                    units: ['h', 'm']
                });
        }

        super({
            body: {
                from: EMAIL_FROM,
                subject: `${title}(★) is going live ${humanTime} !`,
                html:
                    `<div style="background-color:#f4f2ec; padding:24px 12px; font-family:Arial,Helvetica,sans-serif;">` +
                    `<table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border:1px solid #e2ddd0; border-radius:10px; overflow:hidden;">` +
                    `<tr><td align="center" bgcolor="#23262B" style="background-color:#23262B; padding:20px 0;"><img src="https://netcontrol.live/img/hamlive-logo-tagline-beta-horizontal-darkbg.png" alt="netcontrol.live" width="300" style="display:block; width:300px; max-width:82%; height:auto; border:0;"></td></tr>` +
                    `<tr><td style="padding:28px 32px 6px 32px; font-family:Georgia,'Times New Roman',serif; color:#23262B; font-size:20px; font-weight:bold;">A net is going live</td></tr>` +
                    `<tr><td style="padding:0 32px 18px 32px; color:#444444; font-size:14px; line-height:1.6;">${netControl} is starting <a href='${conf.base_url}${url}' style="color:#C24A38; font-weight:bold; text-decoration:none;">${title}</a>.</td></tr>` +
                    `<tr><td style="padding:0 32px 26px 32px;"><a href='${conf.base_url}${url}' style="display:inline-block; background-color:#C24A38; color:#ffffff; font-size:15px; font-weight:bold; text-decoration:none; padding:12px 26px; border-radius:6px;">Join the net</a></td></tr>` +
                    `<tr><td bgcolor="#23262B" style="background-color:#23262B; padding:16px 32px; color:#9a9a9a; font-size:11px; line-height:1.6;">To stop these alerts, unfollow (☆) ${title} at <a href='${conf.base_url}/views/favorites' style="color:#C4933F; text-decoration:none;">your favorites</a>.<br>Sent by <a href="https://netcontrol.live" style="color:#C4933F; text-decoration:none;">netcontrol.live</a> &middot; Amateur Radio Net Control</td></tr>` +
                    `</table></div>`
            }
        });
        this.type = 'net-announce';
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
    static async init({ netProfileDoc: { id: NPID, title }, liveNetDoc: { url, started, startedAt }, attendees }) {
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
        return new NetCloseReport(NetCloseReport.#_internal, {
            title,
            NPID,
            url,
            started,
            startedAt,
            attendees,
            chatLog
        });
    }

    // Private constructor
    constructor(key, { title, NPID, url, started, startedAt, attendees, chatLog }) {
        // Check if the key matches the private static symbol
        if (key !== NetCloseReport.#_internal) {
            throw new Error('NetCloseReport constructor is private. Use NetCloseReport.init() instead.');
        }

        // Perform computations before calling super()
        const sortedAttendees = NetCloseReport.#sortAttendees(attendees);
        const formattedAttendees = NetCloseReport.#formatAttendees(sortedAttendees);
        const attachments = NetCloseReport.#createAttachments({
            title,
            NPID,
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
                templateId: 'd-c2c75b3765954b5dbc043576c67493a7',
                dynamic_template_data: {
                    subject: `${title} - Net Close Report`,
                    url: `${conf.base_url}${url}`,
                    title: title,
                    formattedAttendees: formattedAttendees,
                    startedAtString: started ? new Date(startedAt).toUTCString() : ''
                },
                attachments: attachments
            }
        });

        // Set instance properties
        this.type = 'net-close-report';
        this.#title = title;
        this.#NPID = NPID;
        this.#attendees = sortedAttendees;
        this.#reportGeneration();

        logger.debug(this.body.dynamic_template_data);
    }

    // Private method to log report generation
    #reportGeneration() {
        logger.info(
            `Generating Report for ${this.#title} (NPID:${this.#NPID}): ${this.#attendees
                .map(attendee => attendee.callSign)
                .join(', ')}`
        );
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
    static #formatAttendees(attendees) {
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
            checkInTime: new Date(a.checkedInAt).toUTCString().split(' ').slice(4).join(' '),
            displayName: a.displayName || '',
            location: a.location || '',
            sigReport: a.rst || '',
            highlight: a.highlight || false
        }));
    }

    // Static method to create email attachments
    static #createAttachments({ title, NPID, url, started, startedAt, formattedAttendees, chatLog }) {
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
    NetCloseReport,
    emailEnabled
};
