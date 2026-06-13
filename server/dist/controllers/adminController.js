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
 * GET /api/admin/email?recipient=<email> — delivery log + events for one recipient
 */
const listEmailActivity = async (req, res) => {
    handleRequest(res, async () => {
        const recipient = String(req.query.recipient || '').trim();
        if (!recipient) return { message: { logs: [], events: [] } };
        const EmailLog = getEmailLog();
        const EmailEvent = getEmailEvent();
        const escaped = recipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = new RegExp('^' + escaped + '$', 'i');
        const logs = await EmailLog.find({ recipient: rx }).sort({ createdAt: -1 }).limit(100).lean();
        const batchIds = logs.map(l => l.batchId).filter(Boolean);
        const events = await EmailEvent.find({ batchId: { $in: batchIds } }).sort({ timestamp: 1 }).lean();
        return { message: { logs, events } };
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

module.exports = { listUsers, updateUser, deleteUser, listNets, getStats, deleteNet, updateNetSchedule, listEmailActivity, resendSignInLink };
