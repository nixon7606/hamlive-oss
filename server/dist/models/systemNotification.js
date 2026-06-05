/* hamlive-oss — MIT License. See LICENSE. */

const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');

const systemNotificationSchema = new Schema(
    {
        notificationId: {
            type: String,
            required: [true, 'notificationId is required'],
            unique: true,
            index: true,
            maxlength: 100
        },
        title: {
            type: String,
            required: [true, 'title is required'],
            maxlength: 100
        },
        message: {
            type: String,
            required: [true, 'message is required'],
            maxlength: 5000
        },
        severity: {
            type: String,
            enum: {
                values: ['info', 'warning', 'critical'],
                message: '{VALUE} is not a valid severity level'
            },
            default: 'info'
        },
        active: {
            type: Boolean,
            default: true,
            index: true
        },
        expiresAt: {
            type: Date,
            default: null
        }
    },
    { timestamps: true }
);

module.exports = {
    getSystemNotification: db => modelMaker({ db, m: 'SystemNotification', s: systemNotificationSchema }),
    systemNotificationSchema
};
