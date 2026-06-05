/* hamlive-oss — MIT License. See LICENSE. */

// WHY these imports: shared response and error-handling helpers used across the server
import type { Request, Response } from 'express';
import { StreamChat, Channel } from 'stream-chat';
import { handleRequest } from './responseUtils'; // WHY: Consistent error handling
import { conf } from '#@server/lib/configLib.js'; // WHY: Centralized config (never hardcode secrets)
import { logger } from '#@server/lib/logger.js'; // WHY: Consistent logging (never use console.log)
import { NPID, HamLiveRole } from '#@client/types/commonTypes.js';
import { isNpid } from '#@server/types/commonTypesupport.js'; // WHY: Runtime type validation
import { getNetProfile } from '#@server/models/netProfile.js'; // WHY: Model factory pattern
export type { HamLiveRole }; // Re-export for convenience

// Module augmentation for Stream Chat custom data types
declare module 'stream-chat' {
    interface CustomUserData {
        callSign?: string;
    }
    interface CustomChannelData {
        name?: string;
        npid?: string;
    }
}

const NetProfile = getNetProfile();

// Model types for dynamic imports (JS-only models in dist/)
interface LiveNetModel {
    findOne: (
        query: object
    ) => Promise<{ _id: unknown; lookupTable: Map<string, { stationInteraction: string }> } | null>;
}
interface StationInteractionModel {
    findOne: (query: object) => Promise<{ role: HamLiveRole } | null>;
}

// Role levels - must match sharedNetOps.js:roleLevels
// WHY duplicate: Can't import from JS-only sharedNetOps due to rootDir constraints
// Lower number = higher privilege (netcontrol=0, netlogger=1, netrelay=2, netuser=3)
const ROLE_LEVELS: Record<HamLiveRole, number> = {
    netcontrol: 0,
    netlogger: 1,
    netrelay: 2,
    netuser: 3
};

// Moderation requires level 0 (NCS only)
// Note: Netloggers (level 1) were previously included in roleMapping as moderators
// but are now restricted to members to match the backend check.
const MODERATION_MAX_LEVEL = 0;

/**
 * Check if a user can moderate chat (must be NCS for the net)
 * WHY inline requires: Models are JS-only in dist/, TypeScript rootDir prevents static imports
 * WHY level check: Matches pattern in sharedNetOps.js (e.g., line 114: myLevel > 1)
 */
const checkUserCanModerate = async (npid: NPID, userProfileId: string): Promise<boolean> => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { getLiveNet } = require('#@server/models/liveNet.js') as { getLiveNet: () => LiveNetModel };
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { getStationInteraction } = require('#@server/models/stationInteraction.js') as {
        getStationInteraction: () => StationInteractionModel;
    };

    const LiveNet = getLiveNet();
    const StationInteraction = getStationInteraction();

    // Find the live net for this net profile
    const liveNet = await LiveNet.findOne({ netProfile: npid });
    if (!liveNet) {
        throw new Error('Net is not currently running');
    }

    // Find user's station interaction in this net by userProfile
    const userInteraction = await StationInteraction.findOne({
        liveNet: liveNet._id,
        userProfile: userProfileId
    });

    if (!userInteraction) {
        return false;
    }

    // Check level: only NCS (level 0) can moderate
    const level = ROLE_LEVELS[userInteraction.role];
    return level <= MODERATION_MAX_LEVEL;
};

// WHY singleton: Avoid creating multiple client instances.
// Same pattern as NodeCache instances in serverUtils.js (e.g., gOptsCache, okToAdvertiseCache)
let serverClient: StreamChat | null = null;

/**
 * Get or create the Stream Chat server client
 * WHY: Singleton pattern matches how the codebase handles expensive resources
 */
export const getStreamClient = (): StreamChat => {
    if (!serverClient) {
        if (!conf.stream_api_key || !conf.stream_api_secret) {
            throw new Error('Stream Chat credentials not configured');
        }
        serverClient = StreamChat.getInstance(conf.stream_api_key, conf.stream_api_secret);
        setupEventListeners(serverClient);
        logger.info('Stream Chat server client initialized');
    }
    return serverClient;
};

/**
 * Set up server-side event listeners for audit logging
 * WHY: Track moderation actions and message edits for accountability
 */
const setupEventListeners = (client: StreamChat): void => {
    // Message deleted - track moderation actions
    client.on('message.deleted', event => {
        const deletedBy = event.user?.callSign || event.user?.id || 'unknown';
        const messageAuthor = event.message?.user?.callSign || event.message?.user?.id || 'unknown';
        const channelId = event.channel_id || 'unknown';
        logger.info(`Chat: Message deleted in ${channelId} by ${deletedBy} (author: ${messageAuthor})`);
    });

    // Message updated - track edits
    client.on('message.updated', event => {
        const editor = event.user?.callSign || event.user?.id || 'unknown';
        const channelId = event.channel_id || 'unknown';
        const messageId = event.message?.id || 'unknown';
        logger.info(`Chat: Message ${messageId} edited in ${channelId} by ${editor}`);
    });

    // User banned - track moderation
    client.on('user.banned', event => {
        const bannedUser = event.user?.callSign || event.user?.id || 'unknown';
        // Type assertion needed as ban event has additional fields not in base Event type
        const banEvent = event as typeof event & { created_by?: { callSign?: string; id?: string }; reason?: string };
        const bannedBy = banEvent.created_by?.callSign || banEvent.created_by?.id || 'unknown';
        const reason = banEvent.reason || 'no reason given';
        logger.info(`Chat: User ${bannedUser} banned by ${bannedBy} - reason: ${reason}`);
    });

    // User unbanned
    client.on('user.unbanned', event => {
        const unbannedUser = event.user?.callSign || event.user?.id || 'unknown';
        logger.info(`Chat: User ${unbannedUser} unbanned`);
    });

    logger.debug('Stream Chat event listeners configured');
};

/**
 * User role mapping for Stream Chat
 * Maps ham.live roles to Stream Chat channel roles
 * Note: GetStream uses 'channel_moderator' and 'channel_member' as built-in roles
 * 'admin' is a system-level role and cannot be used as a channel member role
 */
export type StreamChannelRole = 'channel_moderator' | 'channel_member';

const roleMapping: Record<HamLiveRole, StreamChannelRole> = {
    netcontrol: 'channel_moderator',
    netlogger: 'channel_member',
    netrelay: 'channel_member',
    netuser: 'channel_member'
};

/**
 * Generate channel ID from NPID
 * Format: net-{NPID}
 */
export const getChannelId = (npid: NPID): string => `net-${npid.toString()}`;

/**
 * Generate user ID for Stream Chat
 * Uses MongoDB _id to ensure uniqueness
 */
export const getStreamUserId = (mongoUserId: string): string => `hamlive-${mongoUserId}`;

/**
 * Interface for user data passed to Stream Chat
 */
interface StreamUserData {
    id: string;
    name: string;
    callSign: string;
    role?: HamLiveRole;
}

/**
 * Upsert a user in Stream Chat
 * Called server-side to ensure user exists before token generation
 */
export const upsertStreamUser = async (userData: StreamUserData): Promise<void> => {
    const client = getStreamClient();

    await client.upsertUser({
        id: userData.id,
        name: userData.name,
        callSign: userData.callSign,
        role: 'user' // Stream Chat role (not channel role)
    });
};

/**
 * Create a token for a user
 * Called server-side only - never expose API secret to client
 *
 * WHY 3 hours: Nets can run longer than 1 hour. The client uses a tokenProvider
 * function that automatically refreshes tokens when they expire, but a longer
 * expiration reduces refresh frequency and is more resilient to brief network issues.
 */
const TOKEN_EXPIRATION_SECONDS = 3 * 60 * 60; // 3 hours

export const createUserToken = (userId: string, expirationSeconds: number = TOKEN_EXPIRATION_SECONDS): string => {
    const client = getStreamClient();
    return client.createToken(userId, Math.floor(Date.now() / 1000) + expirationSeconds);
};

/**
 * Create a channel for a net
 * Called when a net is opened
 */
export const createNetChannel = async ({
    npid,
    netTitle,
    createdById
}: {
    npid: NPID;
    netTitle: string;
    createdById: string;
}): Promise<Channel> => {
    const client = getStreamClient();
    const channelId = getChannelId(npid);

    const channel = client.channel('messaging', channelId, {
        created_by_id: createdById,
        // Custom data stored in channel extraData
        npid: npid.toString()
    });

    // Create the channel first
    await channel.create();

    // Update channel with the name separately (Stream API requires this)
    await channel.updatePartial({ set: { name: netTitle } });
    logger.info(`Stream Chat channel created: ${channelId} for net "${netTitle}"`);

    return channel;
};

/**
 * Delete a channel when a net is closed
 * Called during net close process
 */
export const deleteNetChannel = async (npid: NPID): Promise<void> => {
    const client = getStreamClient();
    const channelId = getChannelId(npid);

    try {
        const channel = client.channel('messaging', channelId);
        await channel.delete();
        logger.info(`Stream Chat channel deleted: ${channelId}`);
    } catch (err: unknown) {
        // Channel may not exist if net never had chat enabled
        const error = err as { code?: number; message?: string };
        if (error.code !== 16) {
            // 16 = channel not found
            throw err;
        }
        logger.warn(`Stream Chat channel ${channelId} not found during deletion`);
    }
};

/**
 * Add a member to a channel with appropriate role
 * WHY upsertStreamUser first: User must exist in Stream before being added to a channel
 */
export const addChannelMember = async ({
    npid,
    userId,
    role,
    userData
}: {
    npid: NPID;
    userId: string;
    role: HamLiveRole;
    userData?: { name: string; callSign: string };
}): Promise<void> => {
    const client = getStreamClient();
    const channelId = getChannelId(npid);
    const channelRole = roleMapping[role];

    // Ensure user exists in Stream before adding to channel
    if (userData) {
        await upsertStreamUser({
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

    logger.debug(`Added ${userId} to channel ${channelId} as ${channelRole}`);
};

/**
 * Update a member's role in a channel
 * Called when user role changes (e.g., promoted to logger)
 *
 * WHY updateMemberPartial: Atomic operation that updates role without removing/re-adding
 * the member. The previous remove/add pattern had a race condition window where the user
 * could miss messages and would see disconnect/reconnect events on their client.
 */
export const updateMemberRole = async ({
    npid,
    userId,
    role
}: {
    npid: NPID;
    userId: string;
    role: HamLiveRole;
}): Promise<void> => {
    const client = getStreamClient();
    const channelId = getChannelId(npid);
    const channelRole = roleMapping[role];

    const channel = client.channel('messaging', channelId);

    await channel.updateMemberPartial({ set: { channel_role: channelRole } }, { userId });

    logger.debug(`Updated ${userId} role in channel ${channelId} to ${channelRole}`);
};

/**
 * Remove a member from a channel
 */
export const removeChannelMember = async ({ npid, userId }: { npid: NPID; userId: string }): Promise<void> => {
    const client = getStreamClient();
    const channelId = getChannelId(npid);

    const channel = client.channel('messaging', channelId);
    await channel.removeMembers([userId]);

    logger.debug(`Removed ${userId} from channel ${channelId}`);
};

/**
 * Fetch chat history for a channel
 * Used for net close reports (replaces fetchRoomHistory)
 */
// Reaction type to emoji mapping for reports
const REACTION_EMOJI: Record<string, string> = {
    like: '👍',
    love: '❤️',
    haha: '😂',
    wow: '😮'
};

/**
 * Format reaction counts as compact emoji string
 * e.g., { like: 3, love: 1 } => "👍3 ❤️1"
 */
const formatReactions = (reactionCounts: Record<string, number> | undefined): string => {
    if (!reactionCounts) return '';

    const parts = Object.entries(reactionCounts)
        .filter(([, count]) => count > 0)
        .map(([type, count]) => {
            const emoji = REACTION_EMOJI[type] || type;
            return `${emoji}${count}`;
        });

    return parts.length > 0 ? ' ' + parts.join(' ') : '';
};

export async function* fetchChatHistory({
    npid,
    since
}: {
    npid: NPID;
    since: string | null;
}): AsyncGenerator<Array<{ username: string; body: string; createdAt: string; reactions: string; edited: boolean }>> {
    if (!isNpid(npid)) {
        throw new Error('Received malformed NPID in fetchChatHistory()');
    }

    const client = getStreamClient();
    const channelId = getChannelId(npid);
    const channel = client.channel('messaging', channelId);

    let lastMessageId: string | undefined;
    const limit = 100;

    while (true) {
        // Build query options
        const queryOptions: { limit: number; id_lt?: string; created_at_after?: string } = { limit };

        if (lastMessageId) {
            queryOptions.id_lt = lastMessageId;
        } else if (since) {
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
            reactions: formatReactions(msg.reaction_counts as Record<string, number> | undefined),
            edited: Boolean(msg.message_text_updated_at && msg.message_text_updated_at !== msg.created_at)
        }));

        lastMessageId = messages[messages.length - 1]?.id;

        if (messages.length < limit) {
            break;
        }
    }
}

/**
 * Express route handler: Generate chat token for a user
 * Replaces endorseRegister from roomlio.ts
 *
 * NOTE: User profile data (photo, displayName, callSign) is NOT returned here.
 * The client already has this data from liveNetStore. This endpoint only
 * returns the token and IDs needed to connect.
 */
export const getChatToken = async (req: Request, res: Response) => {
    await handleRequest(
        res,
        async () => {
            // Chat is optional. When Stream is not configured, return a clean
            // "disabled" response instead of erroring so the client can skip chat.
            if (!conf.stream_api_key || !conf.stream_api_secret) {
                return { message: { enabled: false } };
            }

            const { id: npidParam } = req.params;

            if (!isNpid(npidParam)) {
                throw new Error(`Invalid NPID: ${npidParam}`);
            }

            if (!req.user || !req.user._id) {
                throw new Error('Missing user object on request in getChatToken()');
            }

            const netProfile = await NetProfile.findById(npidParam);

            if (!netProfile) {
                throw new Error(`Net profile not found: ${npidParam}`);
            }

            // Generate Stream user ID from MongoDB user ID
            const streamUserId = getStreamUserId(req.user._id.toString());

            // Get user display name safely
            const displayName = req.user.displayName || req.user.callSign || 'User';
            const firstName = displayName.split(' ')[0];

            // Upsert user in Stream Chat to ensure they exist
            const userCallSign = req.user.callSign || 'UNKNOWN';
            // Format: "FirstName(CALLSIGN)" or just "CALLSIGN" if no display name
            const displayFormat = firstName !== userCallSign ? `${firstName}(${userCallSign})` : userCallSign;
            await upsertStreamUser({
                id: streamUserId,
                name: displayFormat,
                callSign: userCallSign
            });

            // Add user to channel as member (idempotent - safe to call multiple times)
            // WHY here: This is the guaranteed point before client connects to channel.
            // The presence-based addChannelMember may not have run yet (race condition)
            // or user may be returning to a net they visited before.
            const channelId = getChannelId(npidParam);
            const client = getStreamClient();
            const channel = client.channel('messaging', channelId);
            try {
                await channel.addMembers([{ user_id: streamUserId }]);
                logger.debug(`Ensured ${userCallSign} is member of channel ${channelId}`);
            } catch (memberErr: unknown) {
                // Log but don't fail - user might already be a member
                const err = memberErr as { message?: string };
                logger.warn(`addMembers in getChatToken: ${err.message}`);
            }

            // Generate token (signed with API secret, never exposed)
            const token = createUserToken(streamUserId);

            // Ensure API key is available (should be validated at startup, but defensive check here)
            if (!conf.stream_api_key) {
                throw new Error('Stream API key not configured');
            }

            // Return only what's needed to connect
            // Client will use liveNetStore for user profile data (photo, name, etc.)
            return {
                message: {
                    token,
                    userId: streamUserId,
                    channelId: getChannelId(npidParam),
                    channelType: 'messaging',
                    apiKey: conf.stream_api_key // Public key only
                }
            };
        },
        `getChatToken(): Generate chat token for ${req.user?.callSign} in room ${req.params['id']}`
    );
};

/**
 * Moderation: Delete a message (internal helper)
 * Available to admins (netcontrol) and moderators (loggers)
 */
export const deleteMessageHelper = async ({
    npid,
    messageId,
    moderatorCallsign
}: {
    npid: NPID;
    messageId: string;
    moderatorCallsign: string;
}): Promise<void> => {
    const client = getStreamClient();

    await client.deleteMessage(messageId, true); // hard delete

    logger.info(
        `Chat: Message ${messageId} deleted by ${moderatorCallsign} in channel ${getChannelId(npid).toString()}`
    );
};

/**
 * Express route handler: Delete a chat message
 * DELETE /api/endorse/chat/:id/message/:messageId
 */
export const deleteMessage = async (req: Request, res: Response) => {
    await handleRequest(
        res,
        async () => {
            const { id: npidParam, messageId } = req.params;

            if (!isNpid(npidParam)) {
                throw new Error(`Invalid NPID: ${npidParam}`);
            }

            if (!messageId) {
                throw new Error('Missing messageId parameter');
            }

            if (!req.user || !req.user._id) {
                throw new Error('Missing user object on request');
            }

            // Check if user can moderate (NCS only)
            const canModerate = await checkUserCanModerate(npidParam, req.user._id.toString());
            if (!canModerate) {
                throw new Error('Insufficient permissions: only NCS can delete messages');
            }

            await deleteMessageHelper({
                npid: npidParam,
                messageId,
                moderatorCallsign: req.user.callSign ?? 'unknown'
            });

            return { message: { success: true, messageId } };
        },
        `deleteMessage(): Delete message ${req.params['messageId']} by ${req.user?.callSign}`
    );
};

// ============================================================================
// Moderation helpers for net admin commands (ban, unban)
// ============================================================================

/**
 * Ban a user from a channel
 */
export const banUserHelper = async ({
    npid,
    userIdToBan,
    bannedByUserId,
    targetCallsign,
    moderatorCallsign,
    reason
}: {
    npid: NPID;
    userIdToBan: string;
    bannedByUserId: string;
    targetCallsign: string;
    moderatorCallsign: string;
    reason?: string;
}): Promise<void> => {
    const client = getStreamClient();
    const channelId = getChannelId(npid);
    const channel = client.channel('messaging', channelId);

    const banOptions: { banned_by_id: string; reason?: string } = {
        banned_by_id: bannedByUserId
    };

    if (reason) {
        banOptions.reason = reason;
    }

    await channel.banUser(userIdToBan, banOptions);

    logger.info(
        `Chat: ${targetCallsign} banned by ${moderatorCallsign} from ${channelId}. Reason: ${reason || 'none'}`
    );
};

/**
 * Unban a user from a channel
 */
export const unbanUserHelper = async ({
    npid,
    userIdToUnban,
    targetCallsign,
    moderatorCallsign
}: {
    npid: NPID;
    userIdToUnban: string;
    targetCallsign: string;
    moderatorCallsign: string;
}): Promise<void> => {
    const client = getStreamClient();
    const channelId = getChannelId(npid);
    const channel = client.channel('messaging', channelId);

    await channel.unbanUser(userIdToUnban);

    logger.info(`Chat: ${targetCallsign} unbanned by ${moderatorCallsign} from ${channelId}`);
};
