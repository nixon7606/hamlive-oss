/* hamlive-oss — MIT License. See LICENSE. */

/**
 * ChatBan model — tracks chat bans per net.
 * When a user is banned from a net's chat, they cannot send messages
 * until unbanned. Bans persist across net sessions (sticky).
 */
const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');

const chatBanSchema = new Schema(
    {
        // The net profile this ban applies to
        netProfile: {
            type: Schema.Types.ObjectId,
            ref: 'NetProfile',
            required: true,
            index: true
        },
        // The banned user's profile
        userProfile: {
            type: Schema.Types.ObjectId,
            ref: 'UserProfile',
            required: true
        },
        // Denormalized callsign for display
        callSign: {
            type: String,
            required: true,
            maxlength: 10
        },
        // Reason for the ban
        reason: {
            type: String,
            required: true,
            maxlength: 200,
            default: 'No reason given'
        },
        // Who issued the ban
        bannedBy: {
            callSign: { type: String, required: true },
            userProfile: { type: Schema.Types.ObjectId, ref: 'UserProfile' }
        },
        // Soft-delete: unbannedAt set when unbanned
        unbannedAt: {
            type: Date,
            default: null
        },
        // Who unbanned (if unbanned)
        unbannedBy: {
            callSign: { type: String },
            userProfile: { type: Schema.Types.ObjectId, ref: 'UserProfile' }
        },
        // Optional expiry — when set and in the past, the ban is inert (auto-lifts).
        // null = permanent.
        expiresAt: {
            type: Date,
            default: null
        },
    },
    {
        timestamps: true // adds createdAt, updatedAt
    }
);

// Compound index: one active ban per user per net
chatBanSchema.index({ netProfile: 1, userProfile: 1, unbannedAt: 1 });

module.exports = {
    getChatBan: db => modelMaker({ db, m: 'ChatBan', s: chatBanSchema }),
    chatBanSchema
};