/* hamlive-oss — MIT License. See LICENSE.
 *
 * In-house chat system replacing GetStream.io integration.
 * Messages are stored in MongoDB and pushed to clients via SSE.
 */

const { logger } = require('./logger');
const { conf } = require('./configLib');
const { getChatMessage } = require('../models/chatMessage');
const { getLiveNet } = require('../models/liveNet');
const { getNetProfile } = require('../models/netProfile');
const { getStationInteraction } = require('../models/stationInteraction');
const { getChatBan } = require('../models/chatBan');
const { chatBroadcaster } = require('./sseChat');
const crypto = require('crypto');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const sanitizeHtml = require('sanitize-html');

// Role levels — must match sharedNetOps.js:roleLevels
// Lower number = higher privilege
const ROLE_LEVELS = {
    netcontrol: 0,
    netlogger: 1,
    netrelay: 2,
    netuser: 3
};
const MODERATION_MAX_LEVEL = 0; // Only NCS can moderate

// Upload directory for chat images
// Configurable via CHAT_UPLOAD_DIR env var. Default: <project-root>/uploads/chat/
// In production, set CHAT_UPLOAD_DIR to a persistent path outside the build tree
// (e.g., /var/www/hamlive/uploads/chat/) and configure your reverse proxy to
// serve /uploads/* from that directory.
const UPLOAD_DIR = process.env.CHAT_UPLOAD_DIR
    || path.resolve(__dirname, '../../../uploads/chat');
// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function getModels(db) {
    return {
        ChatMessage: getChatMessage(db),
        ChatBan: getChatBan(db),
        LiveNet: getLiveNet(db),
        NetProfile: getNetProfile(db),
        StationInteraction: getStationInteraction(db)
    };
}

/** Build a standard message payload object from a document */
async function buildMessagePayload(msg, parentCache) {
    const reactions = {};
    if (msg.reactions && typeof msg.reactions === 'object') {
        // msg.reactions is a Mongoose Map on a hydrated doc (e.g. from
        // toggleReaction's non-lean findById) but a plain object on a .lean()
        // query (e.g. getMessages). Object.entries() returns [] for a Map, which
        // silently dropped reactions from the broadcast — likes never appeared
        // live. Use the Map's own iterator when it is a Map.
        const entries = msg.reactions instanceof Map
            ? msg.reactions.entries()
            : Object.entries(msg.reactions);
        for (const [type, users] of entries) {
            if (Array.isArray(users)) {
                reactions[type] = users.map(u => u.toString ? u.toString() : u);
            }
        }
    }
    const payload = {
        id: msg._id.toString(),
        netProfile: (msg.netProfile || '').toString(),
        callSign: msg.callSign || '',
        displayName: msg.displayName || '',
        text: msg.text || '',
        imageUrl: msg.imageUrl || null,
        edited: msg.edited || false,
        createdAt: msg.createdAt ? msg.createdAt.toISOString() : new Date().toISOString(),
        userId: msg.userProfile ? msg.userProfile.toString() : null,
        reactions,
        replyCount: msg.replyCount || 0
    };
    if (msg.parentMessage) {
        const parentId = (msg.parentMessage._id || msg.parentMessage).toString();
        payload.parentMessage = parentId;
        // Use parentCache if provided, otherwise fetch individually
        try {
            let parent;
            if (parentCache && parentCache.has(parentId)) {
                parent = parentCache.get(parentId);
            } else {
                const { getChatMessage } = require('../models/chatMessage');
                const ChatMessage = getChatMessage();
                parent = await ChatMessage.findById(parentId).select('callSign displayName text').lean();
            }
            if (parent) {
                payload.parentCallSign = parent.callSign || '';
                payload.parentDisplayName = parent.displayName || '';
                payload.parentText = (parent.text || '').slice(0, 100);
            }
        } catch (e) {
            logger.warn(`Failed to load parent message details: ${e.message}`);
        }
    }
    return payload;
}

/**
 * Check if chat is enabled for this instance.
 */
function isChatEnabled() {
    return true;
}

function getChatRoomId(npid) {
    return `net-${npid.toString()}`;
}

async function createChatChannel({ npid, netTitle, createdById }) {
    logger.info(`Chat room ready for net "${netTitle}" (${getChatRoomId(npid)})`);
    return { roomId: getChatRoomId(npid) };
}

async function deleteChatChannel(npid) {
    chatBroadcaster.close(npid);
    logger.debug(`Chat SSE stream closed for net ${npid}`);
}

/**
 * Validate that an imageUrl points to a safe local path or HTTPS URL.
 */
function validateImageUrl(url) {
    if (!url) return null;
    // Allow relative paths (our uploads)
    if (url.startsWith('/uploads/chat/')) return url;
    // Allow HTTPS images (external, e.g., embeds)
    if (url.startsWith('https://')) return url;
    // Everything else is rejected (no javascript:, data:, http:, etc.)
    return null;
}

/**
 * Send a chat message (text and/or image).
 * Optionally reply to a parent message via parentMessageId.
 */
async function sendMessage({ npid, user, text, imageUrl = null, parentMessageId = null }) {
    const { ChatMessage } = getModels();
    if (!user || !user._id) throw new Error('sendMessage(): missing user');
    if (!text && !imageUrl) throw new Error('sendMessage(): message must have text or image');

    // Sanitize text input server-side to prevent stored XSS
    const cleanText = sanitizeHtml((text || '').trim(), {
        allowedTags: [],
        allowedAttributes: {}
    });
    if (cleanText.length > 500) throw new Error('sendMessage(): message too long (max 500 chars)');

    // Validate imageUrl
    const cleanImageUrl = validateImageUrl(imageUrl);

    const liveNet = await getModels().LiveNet.findOne({ netProfile: npid });
    if (!liveNet) throw new Error('sendMessage(): net is not currently running');
    if (liveNet.closing) throw new Error('sendMessage(): net is closing');

    // Check if user is banned from chat
    const banCheck = await checkIsBanned({ npid, userProfileId: user._id.toString() });
    if (banCheck) {
        throw new Error(`You are banned from chat. Reason: ${banCheck.reason}`);
    }

    const message = new ChatMessage({
        netProfile: npid,
        liveNet: liveNet._id,
        userProfile: user._id,
        callSign: user.callSign || 'UNKNOWN',
        displayName: user.displayName || user.callSign || '',
        text: cleanText,
        imageUrl: cleanImageUrl
    });

    // If replying to a parent message, set the reference
    if (parentMessageId) {
        // Verify parent exists and belongs to this net
        const parentMsg = await ChatMessage.findById(parentMessageId);
        if (!parentMsg || parentMsg.deleted) throw new Error('sendMessage(): parent message not found');
        if (parentMsg.netProfile.toString() !== npid.toString()) throw new Error('sendMessage(): parent not in this net');
        message.parentMessage = parentMsg._id;
    }

    const saved = await message.save();

    // If this is a reply, increment the parent's replyCount
    if (parentMessageId) {
        await ChatMessage.updateOne(
            { _id: parentMessageId },
            { $inc: { replyCount: 1 } }
        );
    }

    const payload = await buildMessagePayload(saved);
    try {
        chatBroadcaster.broadcast(npid, payload);
    } catch (e) {
        logger.warn(`Chat: broadcast failed for net ${npid}: ${e.message}`);
    }
    logger.debug(`Chat: Message from ${saved.callSign} in net ${npid}`);
    return payload;
}

/**
 * Edit a message text (only the author can edit).
 */
async function editMessage({ npid, messageId, user, newText }) {
    const { ChatMessage } = getModels();
    if (!user || !user._id) throw new Error('editMessage(): missing user');
    // Sanitize edited text
    const cleanText = sanitizeHtml((newText || '').trim(), {
        allowedTags: [],
        allowedAttributes: {}
    });
    if (!cleanText || cleanText.length > 500) throw new Error('editMessage(): invalid text');

    const msg = await ChatMessage.findById(messageId);
    if (!msg) throw new Error('editMessage(): message not found');
    if (msg.deleted) throw new Error('editMessage(): message is deleted');
    if (msg.userProfile.toString() !== user._id.toString()) throw new Error('editMessage(): not your message');

    msg.text = cleanText;
    msg.edited = true;
    msg.editedAt = new Date();
    await msg.save();

    const payload = await buildMessagePayload(msg);
    // Broadcast edit as a full message update
    try {
        chatBroadcaster.broadcast(npid, { ...payload, _event: 'update' });
    } catch (e) {
        logger.warn(`Chat: broadcastEdit failed for net ${npid}: ${e.message}`);
    }
    logger.info(`Chat: Message ${messageId} edited by ${user.callSign}`);
    return payload;
}

/**
 * Toggle a reaction on a message.
 * Adds the user's reaction if not present, removes it if present.
 */
async function toggleReaction({ npid, messageId, user, reactionType }) {
    const { ChatMessage } = getModels();
    if (!user || !user._id) throw new Error('toggleReaction(): missing user');
    if (!['like', 'love', 'haha', 'wow'].includes(reactionType)) {
        throw new Error('toggleReaction(): invalid reaction type');
    }

    const msg = await ChatMessage.findById(messageId);
    if (!msg) throw new Error('toggleReaction(): message not found');
    if (msg.deleted) throw new Error('toggleReaction(): message is deleted');

    const userId = user._id.toString();
    const reactions = msg.reactions || new Map();
    const currentUsers = reactions.get(reactionType) || [];

    const idx = currentUsers.findIndex(u => u.toString() === userId);
    let action;
    if (idx >= 0) {
        // Remove reaction
        currentUsers.splice(idx, 1);
        action = 'removed';
        if (currentUsers.length === 0) {
            reactions.delete(reactionType);
        } else {
            reactions.set(reactionType, currentUsers);
        }
    } else {
        // Add reaction
        currentUsers.push(user._id);
        reactions.set(reactionType, currentUsers);
        action = 'added';
    }
    msg.reactions = reactions;
    msg.markModified('reactions');
    await msg.save();

    const payload = await buildMessagePayload(msg);
    try {
        chatBroadcaster.broadcastReaction(npid, {
        messageId,
        reactionType,
        action,
        userId,
        reactions: payload.reactions
    });
    } catch (e) {
        logger.warn(`Chat: broadcastReaction failed: ${e.message}`);
    }
    logger.debug(`Chat: ${action} reaction ${reactionType} on ${messageId}`);
    return { messageId, reactionType, action };
}

/**
 * Fetch messages for a net (with reactions).
 */
async function getMessages({ npid, since = null, before = null, limit = 100 }) {
    const { ChatMessage } = getModels();
    const query = { netProfile: npid, deleted: false };

    if (since) {
        query.createdAt = { $gt: new Date(since) };
    } else if (before) {
        const beforeMsg = await ChatMessage.findById(before);
        if (beforeMsg) query.createdAt = { $lt: beforeMsg.createdAt };
    }

    const messages = await ChatMessage.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    const results = messages.reverse();

    // Batch-fetch parent message details to avoid N+1 queries
    const parentIds = results
        .filter(m => m.parentMessage)
        .map(m => m.parentMessage._id || m.parentMessage);
    let parentCache = null;
    if (parentIds.length > 0) {
        const parents = await ChatMessage.find({ _id: { $in: parentIds } })
            .select('callSign displayName text')
            .lean();
        parentCache = new Map(parents.map(p => [p._id.toString(), p]));
    }

    return Promise.all(results.map(msg => buildMessagePayload(msg, parentCache)));
}

/**
 * Get chat session info.
 */
async function getChatSession({ npid, user }) {
    if (!user || !user._id) throw new Error('getChatSession(): missing user');
    const netProfile = await getModels().NetProfile.findById(npid);
    if (!netProfile) throw new Error(`Net profile not found: ${npid}`);
    return {
        enabled: true,
        roomId: getChatRoomId(npid),
        userId: user._id.toString(),
        callSign: user.callSign || 'UNKNOWN',
        displayName: user.displayName || user.callSign || ''
    };
}

/**
 * Check if a user can moderate (must be NCS).
 */
async function checkUserCanModerate(npid, userProfileId) {
    const { LiveNet, StationInteraction } = getModels();
    const liveNet = await LiveNet.findOne({ netProfile: npid });
    if (!liveNet) throw new Error('Net is not currently running');
    const userInteraction = await StationInteraction.findOne({
        liveNet: liveNet._id,
        userProfile: userProfileId
    });
    if (!userInteraction) return false;
    return ROLE_LEVELS[userInteraction.role] <= MODERATION_MAX_LEVEL;
}

/**
 * Soft-delete a message (NCS only).
 */
async function deleteMessage({ npid, messageId, moderatorCallsign, userProfileId }) {
    const { ChatMessage } = getModels();
    const canModerate = await checkUserCanModerate(npid, userProfileId);
    if (!canModerate) throw new Error('Insufficient permissions: only NCS can delete messages');
    const msg = await ChatMessage.findById(messageId);
    if (!msg) throw new Error('Message not found');
    if (msg.netProfile.toString() !== npid.toString()) throw new Error('Message not in this net');
    msg.deleted = true;
    await msg.save();
    logger.info(`Chat: Message ${messageId} deleted by ${moderatorCallsign} in net ${npid}`);
    try {
        chatBroadcaster.broadcastDelete(npid, messageId);
    } catch (e) {
        logger.warn(`Chat: broadcastDelete failed: ${e.message}`);
    }
    return { success: true, messageId };
}

/**
 * Check if a user is currently banned from chat in a net.
 * Returns null if not banned, or the ban record if banned.
 */
async function checkIsBanned({ npid, userProfileId }) {
    const { ChatBan } = getModels();
    const activeBan = await ChatBan.findOne({
        netProfile: npid,
        userProfile: userProfileId,
        unbannedAt: null
    }).lean();
    return activeBan || null;
}

/**
 * Ban a user from chat.
 * Returns the ban record.
 */
async function banUser({ npid, userProfileId, callSign, reason, bannedBy }) {
    const { ChatBan } = getModels();
    
    // Check for existing active ban
    const existing = await ChatBan.findOne({
        netProfile: npid,
        userProfile: userProfileId,
        unbannedAt: null
    });
    if (existing) {
        throw new Error(`banUser(): ${callSign} is already banned`);
    }

    const ban = new ChatBan({
        netProfile: npid,
        userProfile: userProfileId,
        callSign: callSign.toUpperCase(),
        reason: reason || 'No reason given',
        bannedBy: {
            callSign: bannedBy.callSign,
            userProfile: bannedBy.userProfile
        }
    });

    const saved = await ban.save();
    logger.info(`Chat: ${callSign} banned from net ${npid} by ${bannedBy.callSign}. Reason: ${reason}`);

    // Broadcast ban event via SSE so clients can react
    chatBroadcaster.broadcastCustom(npid, {
        type: 'ban',
        callSign: callSign.toUpperCase(),
        reason: reason || 'No reason given',
        bannedBy: bannedBy.callSign
    }, 'chat-ban');

    return saved;
}

/**
 * Unban a user from chat.
 */
async function unbanUser({ npid, userProfileId, callSign, unbannedBy }) {
    const { ChatBan } = getModels();
    
    const ban = await ChatBan.findOne({
        netProfile: npid,
        userProfile: userProfileId,
        unbannedAt: null
    });
    if (!ban) {
        throw new Error(`unbanUser(): ${callSign} is not currently banned`);
    }

    ban.unbannedAt = new Date();
    ban.unbannedBy = {
        callSign: unbannedBy.callSign,
        userProfile: unbannedBy.userProfile
    };
    await ban.save();

    logger.info(`Chat: ${callSign} unbanned from net ${npid} by ${unbannedBy.callSign}`);

    // Broadcast unban event
    chatBroadcaster.broadcastCustom(npid, {
        type: 'unban',
        callSign: callSign.toUpperCase(),
        unbannedBy: unbannedBy.callSign
    }, 'chat-ban');

    return ban;
}

/**
 * Get the list of currently banned users for a net.
 */
async function getBannedUsers(npid) {
    const { ChatBan } = getModels();
    const bans = await ChatBan.find({
        netProfile: npid,
        unbannedAt: null
    }).sort({ createdAt: -1 }).lean();
    
    return bans.map(b => ({
        id: b._id.toString(),
        callSign: b.callSign,
        reason: b.reason,
        bannedBy: b.bannedBy.callSign,
        bannedAt: b.createdAt.toISOString()
    }));
}

/**
 * Broadcast a typing indicator via SSE.
 * Clients should debounce: send once when user starts typing, once when they stop.
 */
function broadcastTyping({ npid, callSign, isTyping }) {
    chatBroadcaster.broadcastCustom(npid, {
        type: 'typing',
        callSign: callSign.toUpperCase(),
        isTyping
    }, 'chat-typing');
}

/**
 * Fetch replies (thread) for a parent message.
 */
async function getThreadMessages({ parentMessageId, limit = 50 }) {
    const { ChatMessage } = getModels();
    const messages = await ChatMessage.find({
        parentMessage: parentMessageId,
        deleted: false
    })
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean();

    // Batch-fetch parent details for any nested replies
    const parentIds = messages
        .filter(m => m.parentMessage)
        .map(m => m.parentMessage._id || m.parentMessage);
    let parentCache = null;
    if (parentIds.length > 0) {
        const parents = await ChatMessage.find({ _id: { $in: parentIds } })
            .select('callSign displayName text')
            .lean();
        parentCache = new Map(parents.map(p => [p._id.toString(), p]));
    }

    return Promise.all(messages.map(msg => buildMessagePayload(msg, parentCache)));
}

/**
 * Accept and store an uploaded image file.
 */
async function uploadImage(file) {
    if (!file) throw new Error('uploadImage(): no file provided');
    // Whitelist allowed image extensions
    const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
    const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!ALLOWED_MIMES.includes(file.mimetype)) {
        throw new Error(`uploadImage(): invalid file type "${file.mimetype}" — only JPEG, PNG, GIF, WebP allowed`);
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
        throw new Error(`uploadImage(): invalid extension "${ext}" — only .jpg, .jpeg, .png, .gif, .webp allowed`);
    }
    // Check magic bytes to validate actual file content (not just extension/MIME)
    const magicBytes = new Map([
        ['89504E47', 'image/png'],          // PNG
        ['FFD8FF', 'image/jpeg'],            // JPEG
        ['47494638', 'image/gif'],           // GIF87a or GIF89a
        ['52494646', 'image/webp']           // RIFF + WEBP (WebP container)
    ]);
    const hex = file.buffer.slice(0, 8).toString('hex').toUpperCase();
    const webpMagic = file.buffer.slice(8, 12).toString('ascii').toUpperCase();
    const validMagic = [...magicBytes.entries()].some(([magic, expectedMime]) => {
        if (magic === '52494646') {
            // RIFF is also used by AVI/WAV — verify the WEBP sub-format at offset 8-11
            return hex.startsWith(magic) && webpMagic === 'WEBP' && file.mimetype === expectedMime;
        }
        return hex.startsWith(magic) && file.mimetype === expectedMime;
    });
    if (!validMagic) {
        throw new Error(`uploadImage(): file content does not match expected image format`);
    }

    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filepath, file.buffer);
    return `/uploads/chat/${filename}`;
}

/**
 * Fetch chat history for net close reports.
 */
async function* fetchChatHistory({ npid, since = null }) {
    const { ChatMessage } = getModels();
    let lastId = null;
    const batchSize = 100;

    while (true) {
        const query = { netProfile: npid, deleted: false };
        if (lastId) query._id = { $lt: lastId };
        else if (since) query.createdAt = { $gte: new Date(since) };

        const messages = await ChatMessage.find(query).sort({ _id: -1 }).limit(batchSize).lean();
        if (messages.length === 0) break;

        const batch = messages.reverse().map(msg => ({
            username: msg.callSign,
            body: msg.text,
            createdAt: msg.createdAt.toISOString(),
            reactions: msg.reactions ? JSON.stringify(Object.fromEntries(msg.reactions)) : '',
            edited: msg.edited
        }));

        yield batch;
        lastId = messages[messages.length - 1]._id;
        if (messages.length < batchSize) break;
    }
}

module.exports = {
    isChatEnabled,
    getChatRoomId,
    createChatChannel,
    deleteChatChannel,
    sendMessage,
    editMessage,
    toggleReaction,
    uploadImage,
    getMessages,
    getChatSession,
    checkUserCanModerate,
    deleteMessage,
    fetchChatHistory,
    checkIsBanned,
    banUser,
    unbanUser,
    getBannedUsers,
    broadcastTyping,
    getThreadMessages,
    chatBroadcaster
};