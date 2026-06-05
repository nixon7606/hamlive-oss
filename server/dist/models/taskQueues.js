/* hamlive-oss — MIT License. See LICENSE. */
const { Schema } = require('mongoose');
const { modelMaker } = require('../lib/modelMaker');

const pendingUnfollowSchema = new Schema(
    {
        unlink: {
            type: String,
            enum: {
                values: ['userOnly', 'netOnly', 'both'],
                message: '{VALUE} is not supported'
            },
            required: [true, 'unlink option required by unFollowItem Schema']
        },
        upid: {
            type: Schema.Types.ObjectId,
            required: [true, 'upid required by unFollowItem Schema'],
            ref: 'UserProfile'
        },
        npid: {
            type: Schema.Types.ObjectId,
            required: [true, 'npid required by unFollowItem Schema'],
            ref: 'NetProfile'
        }
    },
    { timestamps: true }
);

const pendingAccountDeleteSchema = new Schema(
    {
        upid: {
            type: Schema.Types.ObjectId,
            ref: 'UserProfile'
        }
    },
    { timestamps: true }
);

module.exports = {
    getPendingUnfollow: db => modelMaker({ db, m: 'PendingUnfollow', s: pendingUnfollowSchema }),
    getPendingAccountDelete: db => modelMaker({ db, m: 'PendingAccountDelete', s: pendingAccountDeleteSchema }),
    pendingUnfollowSchema,
    pendingAccountDeleteSchema
};
