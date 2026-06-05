/* hamlive-oss — MIT License. See LICENSE. */

const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');

const flexOptionsGlobalSchema = new Schema(
    {
        scope: { type: String, default: 'global' },
        option: {
            gracePeriodDays: { type: Number, default: 0 },
            ads: { type: Number, default: 0, min: 0, max: 100 },
            chat: { type: Boolean, default: true },
            analytics: { type: Boolean, default: true },
            email: { type: Boolean, default: true },
            maxNetsPerUser: { type: Number, default: 7 },
            maxOwnersPerNet: { type: Number, default: 5 },
            baseTtlMs: { type: Number, default: 15000 },
            awayInMs: { type: Number, default: 25000 },
            httpClientTimeout: { type: Number, default: 20000 },
            requestRateFactor: { type: Number, default: 5 },
            qrzDataReqTimeoutMs: { type: Number, default: 1000 },
            qrzSessionReqTimeoutMs: { type: Number, default: 3000 },
            qrzReqQuota: { type: Number, default: 1000000 },
            maxFollowersPerNet: { type: Number, default: 500 },
            maxFollowingPerUser: { type: Number, default: 100 },
            sigReportTypeByMode: {
                LSB: { type: String, default: 'RS' },
                USB: { type: String, default: 'RS' },
                AM: { type: String, default: 'RS' },
                FreeDV: { type: String, default: 'RS' },
                CW: { type: String, default: 'RST' },
                Reflector: { type: String, default: null },
                FM: { type: String, default: null }
            }
        }
    },
    { timestamps: true }
);

const flexOptionsLocalSchema = new Schema(
    {
        option: {
            chat: { type: Boolean },
            email: { type: Boolean },
            ads: { type: Number, min: 0, max: 100 }
        }
    },
    { timestamps: true }
);

module.exports = {
    getFlexOption: db => modelMaker({ db, m: 'FlexOption', s: flexOptionsGlobalSchema }),
    flexOptionsLocalSchema
};
