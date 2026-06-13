/* hamlive-oss — MIT License. See LICENSE. */

/**
 * Super Admin Controller — user management and system overview.
 * All endpoints require superUser role.
 */

const { getUserProfile } = require('../models/userProfile');
const { getNetProfile } = require('../models/netProfile');
const { getLiveNet } = require('../models/liveNet');
const { getEmailLog } = require('../models/emailLog');
const { getEmailEvent } = require('../models/emailEvent');
const { handleRequest } = require('../lib/responseUtils');
const { logger } = require('../lib/logger');
const mongoose = require('mongoose');
const { sendMagicSignInLink } = require('../routes/authRoutes');
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

/**
 * GET /api/admin/users — List all users
 */
const listUsers = async (req, res) => {
    handleRequest(res, async () => {
        const UserProfile = getUserProfile();
        const users = await UserProfile.find({})
            .select('email callSign displayName location lastIp locked superUser newAccount policyConsent flaggedForDeletion createdAt lastLogin')
            .sort({ createdAt: -1 })
            .lean();
        return { message: users };
    }, 'admin: listUsers');
};

/**
 * PATCH /api/admin/users/:id — Update a user
 */
const updateUser = async (req, res) => {
    handleRequest(res, async () => {
        const { id } = req.params;
        const allowed = ['displayName', 'callSign', 'location', 'locked', 'superUser'];
        const updates = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                updates[key] = req.body[key];
            }
        }
        if (updates.callSign) {
            updates.callSign = updates.callSign.toUpperCase();
        }
        const UserProfile = getUserProfile();
        const user = await UserProfile.findByIdAndUpdate(id, updates, { new: true })
            .select('email callSign displayName location lastIp locked superUser')
            .lean();
        if (!user) throw new Error('User not found');
        logger.info(`admin: updated user ${user.email || user.callSign}`);
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
        const user = await UserProfile.findByIdAndDelete(id).lean();
        if (!user) throw new Error('User not found');
        logger.info(`admin: deleted user ${user.email || user.callSign}`);
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

        const [totalUsers, totalNets, liveNets, scheduledNets] = await Promise.all([
            UserProfile.countDocuments({}),
            NetProfile.countDocuments({}),
            LiveNet.countDocuments({}),
            NetProfile.countDocuments({ 'schedule.enabled': true })
        ]);

        return { message: { totalUsers, totalNets, liveNetsCount: liveNets, scheduledNetsCount: scheduledNets } };
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
        logger.info(`admin: updated schedule for net "${np.title}"`);
        return { message: { updated: true, title: np.title, schedule: np.schedule } };
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
    const email = (req.body && req.body.email || '').trim();
    if (!email) return res.status(400).json({ error: 'email is required' });
    handleRequest(res, async () => {
        await sendMagicSignInLink(email);
        logger.info(`admin resend sign-in link to ${email}`);
        return { message: { sent: true } };
    }, 'admin: resendSignInLink');
};

/**
 * POST /api/admin/email/unsuppress { email, list } — remove a suppression, then resend
 */
const unsuppressEmail = async (req, res) => {
    const email = (req.body && req.body.email || '').trim();
    const list = req.body && req.body.list;
    if (!email || !list) return res.status(400).json({ error: 'email and list are required' });
    handleRequest(res, async () => {
        await removeSuppression(email, list);
        await sendMagicSignInLink(email);
        logger.info(`admin removed ${list} suppression for ${email} and resent link`);
        return { message: { removed: true } };
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
};

module.exports = { listUsers, updateUser, deleteUser, listNets, getStats, deleteNet, updateNetSchedule, listEmailActivity, resendSignInLink, unsuppressEmail, recentEmails };

