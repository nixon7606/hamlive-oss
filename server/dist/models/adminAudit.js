/* hamlive-oss — MIT License. See LICENSE. */
const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');
const adminAuditSchema = new Schema({
    actorId:     { type: Schema.Types.ObjectId, ref: 'UserProfile' },
    actorLabel:  { type: String },          // actor email/callsign at action time
    action:      { type: String, required: true },   // e.g. grant-admin, revoke-admin, lock-user, delete-user, delete-net, resend-login, unsuppress
    targetType:  { type: String },          // 'user' | 'net' | 'email'
    targetId:    { type: String },
    targetLabel: { type: String },
    details:     { type: String }
}, { timestamps: true });
adminAuditSchema.index({ createdAt: -1 });
module.exports = { getAdminAudit: db => modelMaker({ db, m: 'AdminAudit', s: adminAuditSchema }), adminAuditSchema };
