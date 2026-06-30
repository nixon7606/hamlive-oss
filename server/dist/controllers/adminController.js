/* hamlive-oss — MIT License. See LICENSE. */

/**
 * Super Admin Controller — user management and system overview.
 * All endpoints require superUser role.
 */

const validator = require('validator');
const { getUserProfile } = require('../models/userProfile');
const { getAdminAudit } = require('../models/adminAudit');
const { getNetProfile } = require('../models/netProfile');
const { getLiveNet } = require('../models/liveNet');
const { getEmailLog } = require('../models/emailLog');
const { getEmailEvent } = require('../models/emailEvent');
const { handleRequest } = require('../lib/responseUtils');
const { logger } = require('../lib/logger');
const mongoose = require('mongoose');
const { sendMagicSignInLink, generateMagicSignInLink } = require('../routes/authRoutes');
const { isRealSenderActive } = require('../lib/emailTransports');
const { getSuppressions, removeSuppression } = require('../lib/sendgridSuppression');

function toCsv(rows) {
    const cols = ['createdAt', 'recipient', 'type', 'subject', 'status', 'sgMessageId'];
    const esc = v => {
        const s = v === undefined || v === null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map(r => cols.map(c => esc(c === 'createdAt' && r[c] ? new Date(r[c]).toISOString() : r[c])).join(','));
    return [cols.join(','), ...lines].join('\n');
}

function auditCsv(rows) {
    const cols = ['createdAt', 'actorLabel', 'action', 'targetType', 'targetId', 'targetLabel', 'details'];
    const esc = v => {
        const s = v === undefined || v === null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map(r => cols.map(c => esc(c === 'createdAt' && r[c] ? new Date(r[c]).toISOString() : r[c])).join(','));
    return [cols.join(','), ...lines].join('\n');
}

function recordAudit(req, entry) {
    try {
        const AdminAudit = getAdminAudit();
        AdminAudit.create({
            actorId: req.user && req.user._id,
            actorLabel: (req.user && (req.user.email || req.user.callSign)) || 'unknown',
            ...entry
        }).catch(err => logger.error(`recordAudit failed: ${err.message}`));
    } catch (err) { logger.error(`recordAudit failed: ${err.message}`); }
}

/**
 * GET /api/admin/users — List users with optional search + pagination
 */
const listUsers = async (req, res) => {
    handleRequest(res, async () => {
        const UserProfile = getUserProfile();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const search = String(req.query.search || '').trim();
        let filter = {};
        if (search) {
            const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter = { $or: [{ email: rx }, { callSign: rx }, { displayName: rx }] };
        }
        const sel = 'email callSign displayName location lastIp locked lockedUntil superUser newAccount policyConsent flaggedForDeletion createdAt lastLogin lastAuthVia';
        const [users, total] = await Promise.all([
            UserProfile.find(filter).select(sel).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            UserProfile.countDocuments(filter)
        ]);
        return { message: { users, total, page, limit } };
    }, 'admin: listUsers');
};

/**
 * PATCH /api/admin/users/:id — Update a user
 */
const updateUser = async (req, res) => {
    handleRequest(res, async () => {
        const { id } = req.params;
        const allowed = ['displayName', 'callSign', 'location', 'locked', 'lockedUntil', 'superUser'];
        const updates = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                updates[key] = req.body[key];
            }
        }
        if (updates.callSign) {
            updates.callSign = updates.callSign.toUpperCase();
        }
        if (updates.locked === false) {
            updates.lockedUntil = null; // unbanning clears any expiry
        } else if (updates.lockedUntil) {
            updates.lockedUntil = new Date(updates.lockedUntil);
        } else if (updates.locked === true) {
            updates.lockedUntil = null; // permanent ban: clear any stale expiry
        }
        const UserProfile = getUserProfile();
        // Fetch target first
        const target = await UserProfile.findById(id).lean();
        if (!target) throw new Error('User not found');
        // Guardrail: self-lockout
        if (String(id) === String(req.user && req.user._id)) {
            if (updates.superUser === false || updates.locked === true) {
                throw new Error('You cannot remove your own admin or lock your own account.');
            }
        }
        // Guardrail: last-admin demotion
        if (updates.superUser === false && target.superUser) {
            const count = await UserProfile.countDocuments({ superUser: true });
            if (count <= 1) throw new Error('Cannot remove the last remaining admin.');
        }
        const user = await UserProfile.findByIdAndUpdate(id, updates, { new: true })
            .select('email callSign displayName location lastIp locked lockedUntil superUser')
            .lean();
        if (!user) throw new Error('User not found');
        logger.info(`admin: updated user ${user.email || user.callSign}`);
        // Audit changes
        if (updates.superUser !== undefined && updates.superUser !== target.superUser) {
            recordAudit(req, { action: updates.superUser ? 'grant-admin' : 'revoke-admin', targetType: 'user', targetId: String(id), targetLabel: user.email || user.callSign });
        }
        if (updates.locked !== undefined && updates.locked !== target.locked) {
            recordAudit(req, { action: updates.locked ? 'lock-user' : 'unlock-user', targetType: 'user', targetId: String(id), targetLabel: user.email || user.callSign });
        }
        return { message: user };
    }, `admin: updateUser ${req.params.id}`);
};

/**
 * DELETE /api/admin/users/:id — Delete a user
 */
const deleteUser = async (req, res) => {
    handleRequest(res, async () => {
        const { id } = req.params;
        const UserProfile = getUserProfile();
        // Guardrail: cannot delete self
        if (String(id) === String(req.user && req.user._id)) {
            throw new Error('Use account settings to delete your own account.');
        }
        // Fetch target first
        const target = await UserProfile.findById(id).lean();
        if (!target) throw new Error('User not found');
        // Guardrail: last-admin deletion
        if (target.superUser) {
            const count = await UserProfile.countDocuments({ superUser: true });
            if (count <= 1) throw new Error('Cannot delete the last remaining admin.');
        }
        const user = await UserProfile.findByIdAndDelete(id).lean();
        if (!user) throw new Error('User not found');
        logger.info(`admin: deleted user ${user.email || user.callSign}`);
        recordAudit(req, { action: 'delete-user', targetType: 'user', targetId: String(id), targetLabel: user.email || user.callSign });
        return { message: { deleted: true, email: user.email, callSign: user.callSign } };
    }, `admin: deleteUser ${req.params.id}`);
};

/**
 * GET /api/admin/nets — List all net profiles with owner info
 */
const listNets = async (req, res) => {
    handleRequest(res, async () => {
        const db = mongoose.connection;
        const NetProfile = getNetProfile(db);
        const nets = await NetProfile.find({})
            .populate('owners', 'callSign email')
            .populate('liveNet', 'status startedAt')
            .sort({ createdAt: -1 })
            .lean();
        // Add a human-readable owner string
        const result = nets.map(n => ({
            _id: n._id,
            title: n.title,
            frequency: n.frequency || '',
            mode: n.mode || '',
            permanent: !!n.permanent,
            owners: (n.owners || []).map(o => ({ _id: o._id, callSign: o.callSign, email: o.email })),
            hasLiveNet: !!n.liveNet,
            liveNetStatus: n.liveNet?.status || null,
            liveNetStartedAt: n.liveNet?.startedAt || null,
            schedule: n.schedule || {},
            createdAt: n.createdAt
        }));
        return { message: result };
    }, 'admin: listNets');
};

/**
 * GET /api/admin/stats — System-wide counts
 */
const getStats = async (req, res) => {
    handleRequest(res, async () => {
        const db = mongoose.connection;
        const UserProfile = getUserProfile(db);
        const NetProfile = getNetProfile(db);
        const LiveNet = getLiveNet(db);
        const EmailEvent = getEmailEvent();

        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
        const [totalUsers, totalNets, liveNets, scheduledNets, recentBounces] = await Promise.all([
            UserProfile.countDocuments({}),
            NetProfile.countDocuments({}),
            LiveNet.countDocuments({}),
            NetProfile.countDocuments({ 'schedule.enabled': true }),
            EmailEvent.countDocuments({ event: { $in: ['bounce', 'dropped', 'blocked'] }, timestamp: { $gte: sevenDaysAgo } })
        ]);

        return { message: { totalUsers, totalNets, liveNetsCount: liveNets, scheduledNetsCount: scheduledNets, recentBounces } };
    }, 'admin: getStats');
};

/**
 * DELETE /api/admin/nets/:id — Delete a net profile (admin override)
 */
const deleteNet = async (req, res) => {
    handleRequest(res, async () => {
        const { id } = req.params;
        const db = mongoose.connection;
        const NetProfile = getNetProfile(db);
        const np = await NetProfile.findByIdAndDelete(id).lean();
        if (!np) throw new Error('Net profile not found');
        logger.info(`admin: deleted net "${np.title}" (${id})`);
        recordAudit(req, { action: 'delete-net', targetType: 'net', targetId: String(id), targetLabel: np.title });
        return { message: { deleted: true, title: np.title } };
    }, `admin: deleteNet ${req.params.id}`);
};

/**
 * PATCH /api/admin/nets/:id — Update a net's schedule (admin override: disable/enable)
 */
const updateNetSchedule = async (req, res) => {
    handleRequest(res, async () => {
        const { id } = req.params;
        const db = mongoose.connection;
        const NetProfile = getNetProfile(db);
        const np = await NetProfile.findById(id);
        if (!np) throw new Error('Net profile not found');

        // Admin can toggle permanent flag
        if (req.body.permanent !== undefined) {
            np.permanent = !!req.body.permanent;
        }

        // Admin can toggle schedule on/off or set full schedule
        if (req.body.schedule !== undefined) {
            np.schedule = {
                ...np.schedule?.toObject?.(),
                ...req.body.schedule
            };
        }
        if (req.body.scheduleEnabled !== undefined) {
            np.schedule = np.schedule || {};
            np.schedule.enabled = req.body.scheduleEnabled;
        }
        await np.save();
        logger.info(`admin: updated net "${np.title}" (permanent: ${np.permanent})`);
        return { message: { updated: true, title: np.title, permanent: np.permanent, schedule: np.schedule } };
    }, `admin: updateNetSchedule ${req.params.id}`);
};

/**
 * GET /api/admin/email?recipient=<email|callsign> — delivery log + events for one recipient.
 * If the input has no '@', it is treated as a callsign and resolved to the user's email first.
 */
const listEmailActivity = async (req, res) => {
    handleRequest(res, async () => {
        const input = String(req.query.recipient || '').trim();
        if (!input) return { message: { logs: [], events: [], suppressions: [], resolved: null } };

        let email = input;
        let resolved = null;
        if (!input.includes('@')) {
            // Treat as a callsign → resolve to the user's email.
            const UserProfile = getUserProfile();
            const csEscaped = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const user = await UserProfile.findOne({ callSign: new RegExp('^' + csEscaped + '$', 'i') })
                .select('callSign email').lean();
            if (!user) {
                return { message: { logs: [], events: [], suppressions: [], resolved: null, notFound: 'callsign' } };
            }
            email = user.email;
            resolved = { callSign: user.callSign, email: user.email };
        }

        const EmailLog = getEmailLog();
        const EmailEvent = getEmailEvent();
        const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = new RegExp('^' + escaped + '$', 'i');
        const logs = await EmailLog.find({ recipient: rx }).sort({ createdAt: -1 }).limit(100).lean();
        const batchIds = logs.map(l => l.batchId).filter(Boolean);
        const events = await EmailEvent.find({ batchId: { $in: batchIds } }).sort({ timestamp: 1 }).lean();
        const suppressions = await getSuppressions(email);
        return { message: { logs, events, suppressions, resolved } };
    }, 'admin: listEmailActivity');
};

/**
 * POST /api/admin/email/resend-login { email } — send a fresh magic sign-in link
 */
const resendSignInLink = async (req, res) => {
    const rawEmail = req.body && req.body.email;
    const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
    if (!email || !validator.isEmail(email)) return res.status(400).json({ error: 'a valid email is required' });
    handleRequest(res, async () => {
        const result = await sendMagicSignInLink(email);
        logger.info(`admin resend sign-in link to ${email}`);
        recordAudit(req, { action: 'resend-login', targetType: 'email', targetLabel: email });
        // Only surface the live link when no email was actually sent (dev / no real
        // sender). When a real sender is active, returning the link in-band would put a
        // live bearer credential in the response (proxies/APM/history). For
        // copy-without-send in production, use the generate-login endpoint.
        const realSender = await isRealSenderActive();
        return { message: { sent: true, devMagicLink: realSender ? null : (result.devMagicLink || null) } };
    }, 'admin: resendSignInLink');
};

/**
 * POST /api/admin/email/generate-login { email } — mint a fresh single-use magic
 * sign-in link WITHOUT sending any email. For when SendGrid can't reach the
 * recipient: the admin copies the link and hand-delivers it. The link is never
 * persisted; it is only returned in the response.
 */
const generateSignInLink = async (req, res) => {
    const rawEmail = req.body && req.body.email;
    const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
    if (!email || !validator.isEmail(email)) return res.status(400).json({ error: 'a valid email is required' });
    handleRequest(res, async () => {
        const result = await generateMagicSignInLink(email);
        logger.info(`admin generated sign-in link (no email) for ${email}`);
        recordAudit(req, { action: 'generate-login', targetType: 'email', targetLabel: email });
        return { message: { generated: true, devMagicLink: result.devMagicLink || null } };
    }, 'admin: generateSignInLink');
};

/**
 * POST /api/admin/email/unsuppress { email, list } — remove a suppression, then resend
 */
const unsuppressEmail = async (req, res) => {
    const rawEmail = req.body && req.body.email;
    const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
    const list = req.body && req.body.list;
    if (!email || !validator.isEmail(email) || !list) return res.status(400).json({ error: 'email and list are required' });
    handleRequest(res, async () => {
        await removeSuppression(email, list);
        const result = await sendMagicSignInLink(email);
        logger.info(`admin removed ${list} suppression for ${email} and resent link`);
        recordAudit(req, { action: 'unsuppress', targetType: 'email', targetLabel: email, details: list });
        // See resendSignInLink: don't return the live link when a real sender is active.
        const realSender = await isRealSenderActive();
        return { message: { removed: true, devMagicLink: realSender ? null : (result.devMagicLink || null) } };
    }, 'admin: unsuppressEmail');
};

/**
 * GET /api/admin/email/recent?from=<ISO>&to=<ISO>&format=json|csv
 * Sends recorded in the window, newest first (capped), with a status summary.
 */
const recentEmails = async (req, res) => {
    const CAP = 1000;
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 24 * 3600 * 1000);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        return res.status(400).json({ error: 'invalid from/to date' });
    }
    try {
        const EmailLog = getEmailLog();
        const found = await EmailLog.find({ createdAt: { $gte: from, $lte: to } })
            .sort({ createdAt: -1 }).limit(CAP + 1).lean();
        const capped = found.length > CAP;
        const rows = found.slice(0, CAP);

        if (req.query.format === 'csv') {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="email-sends.csv"');
            return res.send(toCsv(rows));
        }
        handleRequest(res, async () => {
            const summary = {};
            for (const r of rows) summary[r.status] = (summary[r.status] || 0) + 1;
            return { message: { rows, summary, capped, count: rows.length } };
        }, 'admin: recentEmails');
    } catch (err) {
        logger.error(`recentEmails DB error: ${err.message}`);
        return res.status(500).json({ error: 'failed to load recent emails' });
    }
};

/**
 * GET /api/admin/audit — Paginated audit log, newest first
 * Optional query params:
 *   actor   — case-insensitive substring match on actorLabel
 *   action  — exact match on action
 *   format  — 'csv' to download a CSV of the filtered set (up to 5000 rows)
 */
const listAudit = async (req, res) => {
    const AdminAudit = getAdminAudit();

    // Build filter from optional query params
    const filter = {};
    if (req.query.actor) {
        const escaped = req.query.actor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.actorLabel = new RegExp(escaped, 'i');
    }
    if (req.query.action) {
        filter.action = req.query.action;
    }

    // CSV export branch — bypass handleRequest, stream directly
    if (req.query.format === 'csv') {
        try {
            const entries = await AdminAudit.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="admin-audit.csv"');
            return res.send(auditCsv(entries));
        } catch (err) {
            logger.error(`listAudit CSV error: ${err.message}`);
            return res.status(500).json({ error: 'failed to export audit log' });
        }
    }

    handleRequest(res, async () => {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const [entries, total] = await Promise.all([
            AdminAudit.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            AdminAudit.countDocuments(filter)
        ]);
        return { message: { entries, total, page, limit } };
    }, 'admin: listAudit');
};

module.exports = { listUsers, updateUser, deleteUser, listNets, getStats, deleteNet, updateNetSchedule, listEmailActivity, resendSignInLink, generateSignInLink, unsuppressEmail, recentEmails, listAudit };

