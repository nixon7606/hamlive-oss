/* hamlive-oss — MIT License. See LICENSE. */
const { Schema } = require('mongoose');
const { modelMaker } = require('../lib/modelMaker');

const dayTrackerSchema = new Schema(
    {
        Mon: { type: Boolean, default: false },
        Tue: { type: Boolean, default: false },
        Wed: { type: Boolean, default: false },
        Thu: { type: Boolean, default: false },
        Fri: { type: Boolean, default: false },
        Sat: { type: Boolean, default: false },
        Sun: { type: Boolean, default: false }
    },
    { timestamps: true }
);

module.exports = {
    getDayTracker: db => modelMaker({ db, m: 'DayTracker', s: dayTrackerSchema })
};
