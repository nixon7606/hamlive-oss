"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unbanUserHelper = exports.banUserHelper = exports.deleteMessage = exports.deleteMessageHelper = exports.getChatToken = exports.removeChannelMember = exports.updateMemberRole = exports.addChannelMember = exports.deleteNetChannel = exports.createNetChannel = exports.createUserToken = exports.upsertStreamUser = exports.getStreamUserId = exports.getChannelId = exports.getStreamClient = void 0;
exports.fetchChatHistory = fetchChatHistory;
const stream_chat_1 = require("stream-chat");
const responseUtils_1 = require("./responseUtils");
const configLib_js_1 = require("#@server/lib/configLib.js");
const logger_js_1 = require("#@server/lib/logger.js");
const commonTypesupport_js_1 = require("#@server/types/commonTypesupport.js");
const netProfile_js_1 = require("#@server/models/netProfile.js");
const NetProfile = (0, netProfile_js_1.getNetProfile)();
const ROLE_LEVELS = {
    netcontrol: 0,
    netlogger: 1,
    netrelay: 2,
    netuser: 3
};
const MODERATION_MAX_LEVEL = 0;
const checkUserCanModerate = async (npid, userProfileId) => {
    const { getLiveNet } = require('#@server/models/liveNet.js');
    const { getStationInteraction } = require('#@server/models/stationInteraction.js');
    const LiveNet = getLiveNet();
    const StationInteraction = getStationInteraction();
    const liveNet = await LiveNet.findOne({ netProfile: npid });
    if (!liveNet) {
        throw new Error('Net is not currently running');
    }
    const userInteraction = await StationInteraction.findOne({
        liveNet: liveNet._id,
        userProfile: userProfileId
    });
    if (!userInteraction) {
        return false;
    }
    const level = ROLE_LEVELS[userInteraction.role];
    return level <= MODERATION_MAX_LEVEL;
};
let serverClient = null;
const getStreamClient = () => {
    if (!serverClient) {
        if (!configLib_js_1.conf.stream_api_key || !configLib_js_1.conf.stream_api_secret) {
            throw new Error('Stream Chat credentials not configured');
        }
        serverClient = stream_chat_1.StreamChat.getInstance(configLib_js_1.conf.stream_api_key, configLib_js_1.conf.stream_api_secret);
        setupEventListeners(serverClient);
        logger_js_1.logger.info('Stream Chat server client initialized');
    }
    return serverClient;
};
exports.getStreamClient = getStreamClient;
const setupEventListeners = (client) => {
    client.on('message.deleted', event => {
        const deletedBy = event.user?.callSign || event.user?.id || 'unknown';
        const messageAuthor = event.message?.user?.callSign || event.message?.user?.id || 'unknown';
        const channelId = event.channel_id || 'unknown';
        logger_js_1.logger.info(`Chat: Message deleted in ${channelId} by ${deletedBy} (author: ${messageAuthor})`);
    });
    client.on('message.updated', event => {
        const editor = event.user?.callSign || event.user?.id || 'unknown';
        const channelId = event.channel_id || 'unknown';
        const messageId = event.message?.id || 'unknown';
        logger_js_1.logger.info(`Chat: Message ${messageId} edited in ${channelId} by ${editor}`);
    });
    client.on('user.banned', event => {
        const bannedUser = event.user?.callSign || event.user?.id || 'unknown';
        const banEvent = event;
        const bannedBy = banEvent.created_by?.callSign || banEvent.created_by?.id || 'unknown';
        const reason = banEvent.reason || 'no reason given';
        logger_js_1.logger.info(`Chat: User ${bannedUser} banned by ${bannedBy} - reason: ${reason}`);
    });
    client.on('user.unbanned', event => {
        const unbannedUser = event.user?.callSign || event.user?.id || 'unknown';
        logger_js_1.logger.info(`Chat: User ${unbannedUser} unbanned`);
    });
    logger_js_1.logger.debug('Stream Chat event listeners configured');
};
const roleMapping = {
    netcontrol: 'channel_moderator',
    netlogger: 'channel_member',
    netrelay: 'channel_member',
    netuser: 'channel_member'
};
const getChannelId = (npid) => `net-${npid.toString()}`;
exports.getChannelId = getChannelId;
const getStreamUserId = (mongoUserId) => `hamlive-${mongoUserId}`;
exports.getStreamUserId = getStreamUserId;
const upsertStreamUser = async (userData) => {
    const client = (0, exports.getStreamClient)();
    await client.upsertUser({
        id: userData.id,
        name: userData.name,
        callSign: userData.callSign,
        role: 'user'
    });
};
exports.upsertStreamUser = upsertStreamUser;
const TOKEN_EXPIRATION_SECONDS = 3 * 60 * 60;
const createUserToken = (userId, expirationSeconds = TOKEN_EXPIRATION_SECONDS) => {
    const client = (0, exports.getStreamClient)();
    return client.createToken(userId, Math.floor(Date.now() / 1000) + expirationSeconds);
};
exports.createUserToken = createUserToken;
const createNetChannel = async ({ npid, netTitle, createdById }) => {
    const client = (0, exports.getStreamClient)();
    const channelId = (0, exports.getChannelId)(npid);
    const channel = client.channel('messaging', channelId, {
        created_by_id: createdById,
        npid: npid.toString()
    });
    await channel.create();
    await channel.updatePartial({ set: { name: netTitle } });
    logger_js_1.logger.info(`Stream Chat channel created: ${channelId} for net "${netTitle}"`);
    return channel;
};
exports.createNetChannel = createNetChannel;
const deleteNetChannel = async (npid) => {
    const client = (0, exports.getStreamClient)();
    const channelId = (0, exports.getChannelId)(npid);
    try {
        const channel = client.channel('messaging', channelId);
        await channel.delete();
        logger_js_1.logger.info(`Stream Chat channel deleted: ${channelId}`);
    }
    catch (err) {
        const error = err;
        if (error.code !== 16) {
            throw err;
        }
        logger_js_1.logger.warn(`Stream Chat channel ${channelId} not found during deletion`);
    }
};
exports.deleteNetChannel = deleteNetChannel;
const addChannelMember = async ({ npid, userId, role, userData }) => {
    const client = (0, exports.getStreamClient)();
    const channelId = (0, exports.getChannelId)(npid);
    const channelRole = roleMapping[role];
    if (userData) {
        await (0, exports.upsertStreamUser)({
            id: userId,
            name: userData.name,
            callSign: userData.callSign
        });
    }
    const channel = client.channel('messaging', channelId);
    await channel.addMembers([
        {
            user_id: userId,
            channel_role: channelRole
        }
    ]);
    logger_js_1.logger.debug(`Added ${userId} to channel ${channelId} as ${channelRole}`);
};
exports.addChannelMember = addChannelMember;
const updateMemberRole = async ({ npid, userId, role }) => {
    const client = (0, exports.getStreamClient)();
    const channelId = (0, exports.getChannelId)(npid);
    const channelRole = roleMapping[role];
    const channel = client.channel('messaging', channelId);
    await channel.updateMemberPartial({ set: { channel_role: channelRole } }, { userId });
    logger_js_1.logger.debug(`Updated ${userId} role in channel ${channelId} to ${channelRole}`);
};
exports.updateMemberRole = updateMemberRole;
const removeChannelMember = async ({ npid, userId }) => {
    const client = (0, exports.getStreamClient)();
    const channelId = (0, exports.getChannelId)(npid);
    const channel = client.channel('messaging', channelId);
    await channel.removeMembers([userId]);
    logger_js_1.logger.debug(`Removed ${userId} from channel ${channelId}`);
};
exports.removeChannelMember = removeChannelMember;
const REACTION_EMOJI = {
    like: '👍',
    love: '❤️',
    haha: '😂',
    wow: '😮'
};
const formatReactions = (reactionCounts) => {
    if (!reactionCounts)
        return '';
    const parts = Object.entries(reactionCounts)
        .filter(([, count]) => count > 0)
        .map(([type, count]) => {
        const emoji = REACTION_EMOJI[type] || type;
        return `${emoji}${count}`;
    });
    return parts.length > 0 ? ' ' + parts.join(' ') : '';
};
async function* fetchChatHistory({ npid, since }) {
    if (!(0, commonTypesupport_js_1.isNpid)(npid)) {
        throw new Error('Received malformed NPID in fetchChatHistory()');
    }
    const client = (0, exports.getStreamClient)();
    const channelId = (0, exports.getChannelId)(npid);
    const channel = client.channel('messaging', channelId);
    let lastMessageId;
    const limit = 100;
    while (true) {
        const queryOptions = { limit };
        if (lastMessageId) {
            queryOptions.id_lt = lastMessageId;
        }
        else if (since) {
            queryOptions.created_at_after = since;
        }
        const response = await channel.query({
            messages: queryOptions
        });
        const messages = response.messages || [];
        if (messages.length === 0) {
            break;
        }
        yield messages.map(msg => ({
            username: msg.user?.callSign || msg.user?.name || 'Unknown',
            body: msg.text || '',
            createdAt: msg.created_at || '',
            reactions: formatReactions(msg.reaction_counts),
            edited: Boolean(msg.message_text_updated_at && msg.message_text_updated_at !== msg.created_at)
        }));
        lastMessageId = messages[messages.length - 1]?.id;
        if (messages.length < limit) {
            break;
        }
    }
}
const getChatToken = async (req, res) => {
    await (0, responseUtils_1.handleRequest)(res, async () => {
        if (!configLib_js_1.conf.stream_api_key || !configLib_js_1.conf.stream_api_secret) {
            return { message: { enabled: false } };
        }
        const { id: npidParam } = req.params;
        if (!(0, commonTypesupport_js_1.isNpid)(npidParam)) {
            throw new Error(`Invalid NPID: ${npidParam}`);
        }
        if (!req.user || !req.user._id) {
            throw new Error('Missing user object on request in getChatToken()');
        }
        const netProfile = await NetProfile.findById(npidParam);
        if (!netProfile) {
            throw new Error(`Net profile not found: ${npidParam}`);
        }
        const streamUserId = (0, exports.getStreamUserId)(req.user._id.toString());
        const displayName = req.user.displayName || req.user.callSign || 'User';
        const firstName = displayName.split(' ')[0];
        const userCallSign = req.user.callSign || 'UNKNOWN';
        const displayFormat = firstName !== userCallSign ? `${firstName}(${userCallSign})` : userCallSign;
        await (0, exports.upsertStreamUser)({
            id: streamUserId,
            name: displayFormat,
            callSign: userCallSign
        });
        const channelId = (0, exports.getChannelId)(npidParam);
        const client = (0, exports.getStreamClient)();
        const channel = client.channel('messaging', channelId);
        try {
            await channel.addMembers([{ user_id: streamUserId }]);
            logger_js_1.logger.debug(`Ensured ${userCallSign} is member of channel ${channelId}`);
        }
        catch (memberErr) {
            const err = memberErr;
            logger_js_1.logger.warn(`addMembers in getChatToken: ${err.message}`);
        }
        const token = (0, exports.createUserToken)(streamUserId);
        if (!configLib_js_1.conf.stream_api_key) {
            throw new Error('Stream API key not configured');
        }
        return {
            message: {
                token,
                userId: streamUserId,
                channelId: (0, exports.getChannelId)(npidParam),
                channelType: 'messaging',
                apiKey: configLib_js_1.conf.stream_api_key
            }
        };
    }, `getChatToken(): Generate chat token for ${req.user?.callSign} in room ${req.params['id']}`);
};
exports.getChatToken = getChatToken;
const deleteMessageHelper = async ({ npid, messageId, moderatorCallsign }) => {
    const client = (0, exports.getStreamClient)();
    await client.deleteMessage(messageId, true);
    logger_js_1.logger.info(`Chat: Message ${messageId} deleted by ${moderatorCallsign} in channel ${(0, exports.getChannelId)(npid).toString()}`);
};
exports.deleteMessageHelper = deleteMessageHelper;
const deleteMessage = async (req, res) => {
    await (0, responseUtils_1.handleRequest)(res, async () => {
        const { id: npidParam, messageId } = req.params;
        if (!(0, commonTypesupport_js_1.isNpid)(npidParam)) {
            throw new Error(`Invalid NPID: ${npidParam}`);
        }
        if (!messageId) {
            throw new Error('Missing messageId parameter');
        }
        if (!req.user || !req.user._id) {
            throw new Error('Missing user object on request');
        }
        const canModerate = await checkUserCanModerate(npidParam, req.user._id.toString());
        if (!canModerate) {
            throw new Error('Insufficient permissions: only NCS can delete messages');
        }
        await (0, exports.deleteMessageHelper)({
            npid: npidParam,
            messageId,
            moderatorCallsign: req.user.callSign ?? 'unknown'
        });
        return { message: { success: true, messageId } };
    }, `deleteMessage(): Delete message ${req.params['messageId']} by ${req.user?.callSign}`);
};
exports.deleteMessage = deleteMessage;
const banUserHelper = async ({ npid, userIdToBan, bannedByUserId, targetCallsign, moderatorCallsign, reason }) => {
    const client = (0, exports.getStreamClient)();
    const channelId = (0, exports.getChannelId)(npid);
    const channel = client.channel('messaging', channelId);
    const banOptions = {
        banned_by_id: bannedByUserId
    };
    if (reason) {
        banOptions.reason = reason;
    }
    await channel.banUser(userIdToBan, banOptions);
    logger_js_1.logger.info(`Chat: ${targetCallsign} banned by ${moderatorCallsign} from ${channelId}. Reason: ${reason || 'none'}`);
};
exports.banUserHelper = banUserHelper;
const unbanUserHelper = async ({ npid, userIdToUnban, targetCallsign, moderatorCallsign }) => {
    const client = (0, exports.getStreamClient)();
    const channelId = (0, exports.getChannelId)(npid);
    const channel = client.channel('messaging', channelId);
    await channel.unbanUser(userIdToUnban);
    logger_js_1.logger.info(`Chat: ${targetCallsign} unbanned by ${moderatorCallsign} from ${channelId}`);
};
exports.unbanUserHelper = unbanUserHelper;
