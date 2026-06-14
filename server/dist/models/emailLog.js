/* hamlive-oss — MIT License. See LICENSE. */
const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');

const emailLogSchema = new Schema({
    // `recipient` is covered by the compound index below (its leading key), so no
    // single-field index here.
    recipient:     { type: String, required: true },
    type:          { type: String, required: true },
    subject:       { type: String },
    relatedUserId: { type: Schema.Types.ObjectId, ref: 'UserProfile' },
    relatedNetId:  { type: Schema.Types.ObjectId, ref: 'NetProfile' },
    batchId:       { type: String, required: true, index: true },
    sgMessageId:   { type: String },
    // `status` holds the latest SendGrid event name verbatim (delivered, bounce,
    // dropped, deferred, …) — intentionally not an enum so new SendGrid event
    // types never fail webhook validation.
    status:        { type: String, default: 'queued' },
    lastEventAt:   { type: Date }
}, { timestamps: true });
emailLogSchema.index({ recipient: 1, createdAt: -1 });

module.exports = {
    getEmailLog: db => modelMaker({ db, m: 'EmailLog', s: emailLogSchema }),
    emailLogSchema
};
