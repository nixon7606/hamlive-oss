/* hamlive-oss — MIT License. See LICENSE. */

const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');

const chatMessageSchema = new Schema(
    {
        // The net profile this message belongs to
        netProfile: {
            type: Schema.Types.ObjectId,
            ref: 'NetProfile',
            required: true,
            index: true
        },
        // The live net session
        liveNet: {
            type: Schema.Types.ObjectId,
            ref: 'LiveNet',
            required: true,
            index: true
        },
        // The sender's user profile
        userProfile: {
            type: Schema.Types.ObjectId,
            ref: 'UserProfile',
            required: true
        },
        // Denormalized sender info for display even if user later changes them
        callSign: {
            type: String,
            required: true,
            maxlength: 10
        },
        displayName: {
            type: String,
            maxlength: 30,
            default: ''
        },
        // Message body
        text: {
            type: String,
            maxlength: 500,
            default: ''
        },
        // Soft-delete flag
        deleted: {
            type: Boolean,
            default: false,
            index: true
        },
        // Track edits
        edited: {
            type: Boolean,
            default: false
        },
        editedAt: {
            type: Date,
            default: null
        },
        // Image attachment (URL to uploaded file)
        imageUrl: {
            type: String,
            default: null
        },
        // Reactions: Map<emoji_type, Set<userId>>
        // Stored as Map<string, [ObjectId]>
        reactions: {
            type: Map,
            of: [{
                type: Schema.Types.ObjectId,
                ref: 'UserProfile'
            }],
            default: new Map()
        },
        // Threaded reply: parent message this is replying to
        parentMessage: {
            type: Schema.Types.ObjectId,
            ref: 'ChatMessage',
            default: null,
            index: true
        },
        // Track reply count for parent messages (denormalized counter)
        replyCount: {
            type: Number,
            default: 0
        }
    },
    {
        timestamps: true // adds createdAt, updatedAt
    }
);

// Compound index for efficient net-scoped queries
chatMessageSchema.index({ netProfile: 1, createdAt: -1 });
chatMessageSchema.index({ liveNet: 1, createdAt: -1 });

module.exports = {
    getChatMessage: db => modelMaker({ db, m: 'ChatMessage', s: chatMessageSchema }),
    chatMessageSchema
};