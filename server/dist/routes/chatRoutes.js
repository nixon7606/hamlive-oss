/* hamlive-oss — MIT License. See LICENSE.
 *
 * Chat API routes — replaces GetStream.io chat endpoints.
 * All endpoints use cookie-based auth (no API tokens needed).
 */

const router = require('express').Router();
const { handleRequest } = require('../lib/responseUtils');
const { authCheck, REQ_CALLSIGN } = require('../lib/serverUtils');
const { isNpid } = require('../types/commonTypesupport');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const {
    getChatSession,
    sendMessage,
    editMessage,
    toggleReaction,
    uploadImage,
    getMessages,
    deleteMessage,
    checkIsBanned,
    getBannedUsers,
    broadcastTyping,
    getThreadMessages,
    banFromMessage,
    chatBroadcaster,
    pinMessage,
    unpinMessage,
} = require('../lib/localChat');
const { logger } = require('../lib/logger');

// Multer for image uploads (max 5MB)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});

// Rate limiters
const sendLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minute
    max: 15,               // 15 messages per minute
    message: { error: 'Too many messages — please slow down' },
    keyGenerator: req => req.user?.callSign || ipKeyGenerator(req)
});
const typingLimiter = rateLimit({
    windowMs: 1000,        // 1 second
    max: 2,                // 2 typing events per second (more lenient)
    message: { error: 'Typing indicator rate limited' },
    keyGenerator: req => req.user?.callSign || ipKeyGenerator(req)
});
const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Too many requests — please slow down' },
    keyGenerator: req => req.user?.callSign || ipKeyGenerator(req)
});

// ============================================================================
// GET /api/chat/:id/session
// ============================================================================
router.get('/:id/session', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        if (!req.user || !req.user._id) throw new Error('Missing user object');
        const session = await getChatSession({ npid, user: req.user });

        // Include ban status in session response
        let banned = null;
        try {
            banned = await checkIsBanned({ npid, userProfileId: req.user._id.toString() });
        } catch (_) { /* non-critical */ }

        return {
            message: {
                ...session,
                banned: banned ? { reason: banned.reason, bannedAt: banned.createdAt } : false
            }
        };
    }, `getChatSession(): ${req.user?.callSign} in net ${req.params.id}`);
});

// ============================================================================
// POST /api/chat/:id/send — Send a chat message (with optional reply)
// ============================================================================
router.post('/:id/send', sendLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        const { text, imageUrl, parentMessageId } = req.body;
        if (!text && !imageUrl) throw new Error('Message must have text or image');
        const message = await sendMessage({
            npid,
            user: req.user,
            text: text || '',
            imageUrl: imageUrl || null,
            parentMessageId: parentMessageId || null
        });
        return { message };
    }, `sendMessage(): ${req.user?.callSign} in net ${req.params.id}`);
});

// ============================================================================
// POST /api/chat/:id/upload — Upload an image (with optional reply)
// ============================================================================
router.post('/:id/upload', sendLimiter, authCheck(REQ_CALLSIGN), upload.single('image'), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        if (!req.file) throw new Error('No image file provided');
        const imageUrl = await uploadImage(req.file);
        const parentMessageId = req.body.parentMessageId || null;
        const message = await sendMessage({ npid, user: req.user, text: '', imageUrl, parentMessageId });
        return { message };
    }, `uploadImage(): ${req.user?.callSign} in net ${req.params.id}`);
});

// ============================================================================
// PUT /api/chat/:id/message/:messageId — Edit a message (author only)
// ============================================================================
router.put('/:id/message/:messageId', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        const { messageId } = req.params;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        if (!messageId) throw new Error('Missing messageId');
        const { text } = req.body;
        if (!text) throw new Error('Missing text in body');
        const message = await editMessage({ npid, messageId, user: req.user, newText: text });
        return { message };
    }, `editMessage(): ${req.user?.callSign} edited ${req.params.messageId}`);
});

// ============================================================================
// POST /api/chat/:id/message/:messageId/react — Toggle a reaction
// ============================================================================
router.post('/:id/message/:messageId/react', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        const { messageId } = req.params;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        const { reactionType } = req.body;
        if (!reactionType) throw new Error('Missing reactionType');
        const result = await toggleReaction({ npid, messageId, user: req.user, reactionType });
        return { message: result };
    }, `toggleReaction(): ${req.user?.callSign} on ${req.params.messageId}`);
});

// ============================================================================
// GET /api/chat/:id/messages — Fetch paginated messages
// ============================================================================
router.get('/:id/messages', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        const since = req.query.since || null;
        const before = req.query.before || null;
        const limit = Math.min(parseInt(req.query.limit) || 100, 200);
        const messages = await getMessages({ npid, since, before, limit });
        return { message: { messages } };
    }, `getMessages(): Net ${req.params.id}`);
});

// ============================================================================
// GET /api/chat/:id/messages/:messageId/replies — Get thread replies
// ============================================================================
router.get('/:id/messages/:messageId/replies', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const { messageId } = req.params;
        if (!messageId) throw new Error('Missing messageId');
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const replies = await getThreadMessages({ parentMessageId: messageId, limit });
        return { message: { messages: replies } };
    }, `getThreadMessages(): Thread for ${req.params.messageId}`);
});

// ============================================================================
// DELETE /api/chat/:id/message/:messageId — delete a message (NCS any message; author own message within 15 min)
// ============================================================================
router.delete('/:id/message/:messageId', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        const { messageId } = req.params;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        if (!messageId) throw new Error('Missing messageId');
        if (!req.user || !req.user._id) throw new Error('Missing user object');
        const result = await deleteMessage({
            npid,
            messageId,
            moderatorCallsign: req.user.callSign || 'unknown',
            userProfileId: req.user._id.toString()
        });
        return { message: result };
    }, `deleteMessage(): ${req.user?.callSign} deleted ${req.params.messageId}`);
});

// ============================================================================
// POST /api/chat/:id/message/:messageId/ban — Ban the message author (NCS only)
// ============================================================================
router.post('/:id/message/:messageId/ban', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        const { messageId } = req.params;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        if (!messageId) throw new Error('Missing messageId');
        if (!req.user || !req.user._id) throw new Error('Missing user object');
        const { reason, expiresAt } = req.body || {};
        const result = await banFromMessage({
            npid,
            messageId,
            reason: typeof reason === 'string' ? reason.slice(0, 200) : 'No reason given',
            expiresAt: expiresAt || null,
            moderator: {
                callSign: req.user.callSign || 'unknown',
                userProfile: req.user._id,
                userProfileId: req.user._id.toString()
            }
        });
        return { message: { banned: result.callSign } };
    }, `banFromMessage(): ${req.user?.callSign} banned author of ${req.params.messageId}`);
});

// ============================================================================
// POST /api/chat/:id/message/:messageId/pin — Pin a message (NCS only)
// ============================================================================
router.post('/:id/message/:messageId/pin', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        const { messageId } = req.params;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        if (!messageId) throw new Error('Missing messageId');
        if (!req.user || !req.user._id) throw new Error('Missing user object');
        const result = await pinMessage({
            npid,
            messageId,
            moderator: { callSign: req.user.callSign || 'unknown', userProfile: req.user._id, userProfileId: req.user._id.toString() }
        });
        return { message: { pinned: result.id } };
    }, `pinMessage(): ${req.user?.callSign} pinned ${req.params.messageId}`);
});

// ============================================================================
// POST /api/chat/:id/message/:messageId/unpin — Unpin a message (NCS only)
// ============================================================================
router.post('/:id/message/:messageId/unpin', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        const { messageId } = req.params;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        if (!messageId) throw new Error('Missing messageId');
        if (!req.user || !req.user._id) throw new Error('Missing user object');
        const result = await unpinMessage({
            npid,
            messageId,
            moderator: { callSign: req.user.callSign || 'unknown', userProfile: req.user._id, userProfileId: req.user._id.toString() }
        });
        return { message: { unpinned: result.messageId } };
    }, `unpinMessage(): ${req.user?.callSign} unpinned ${req.params.messageId}`);
});

// ============================================================================
// GET /api/chat/:id/banned — Get list of banned users (NCS only)
// ============================================================================
router.get('/:id/banned', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        if (!req.user || !req.user._id) throw new Error('Missing user object');
        const { checkUserCanModerate } = require('../lib/localChat');
        const canModerate = await checkUserCanModerate(npid, req.user._id.toString());
        if (!canModerate) throw new Error('Only NCS can view ban list');
        const bans = await getBannedUsers(npid);
        return { message: { bans } };
    }, `getBannedUsers(): ${req.user?.callSign} in net ${req.params.id}`);
});

// ============================================================================
// POST /api/chat/:id/typing — Broadcast typing indicator
// ============================================================================
router.post('/:id/typing', typingLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        const { isTyping } = req.body;
        if (typeof isTyping !== 'boolean') throw new Error('isTyping must be a boolean');
        broadcastTyping({ npid, callSign: req.user.callSign || 'UNKNOWN', isTyping });
        return { message: { ok: true } };
    }, `broadcastTyping(): ${req.user?.callSign} typing=${req.body.isTyping} in net ${req.params.id}`);
});

// ============================================================================
// GET /api/chat/:id/stream — SSE endpoint
// ============================================================================
router.get('/:id/stream', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    const npid = req.params.id;
    if (!isNpid(npid)) return res.status(400).json({ error: 'Invalid NPID' });
    chatBroadcaster.middleware(npid)(req, res);
});

module.exports = router;