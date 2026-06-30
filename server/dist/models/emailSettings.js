/* hamlive-oss — MIT License. See LICENSE. */
const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');

const smtpSchema = new Schema({
    host:         { type: String },
    port:         { type: Number, default: 587 },
    secure:       { type: Boolean, default: false },
    user:         { type: String },
    passwordEnc:  { type: String },   // secretBox token; never returned by APIs
    fromOverride: { type: String }
}, { _id: false });

const emailSettingsSchema = new Schema({
    // singleton marker so we always upsert the same row
    singleton:  { type: String, default: 'email', unique: true },
    provider:   { type: String, enum: ['sendgrid', 'smtp', 'console'], default: 'sendgrid' },
    smtp:       { type: smtpSchema, default: () => ({}) },
    updatedBy:  { type: Schema.Types.ObjectId, ref: 'UserProfile' }
}, { timestamps: true });

const getEmailSettings = db => modelMaker({ db, m: 'EmailSettings', s: emailSettingsSchema });

async function loadEmailSettings() {
    return getEmailSettings().findOne({ singleton: 'email' });
}

// patch is a partial { provider?, smtp?: {...} }. Deep-sets smtp fields so a
// password-less save preserves the stored passwordEnc.
async function saveEmailSettings(patch, actorId) {
    const Model = getEmailSettings();
    const set = { updatedBy: actorId || undefined };
    if (patch.provider !== undefined) set.provider = patch.provider;
    if (patch.smtp) for (const [k, v] of Object.entries(patch.smtp)) set[`smtp.${k}`] = v;
    return Model.findOneAndUpdate(
        { singleton: 'email' },
        { $set: set, $setOnInsert: { singleton: 'email' } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
}

module.exports = { emailSettingsSchema, getEmailSettings, loadEmailSettings, saveEmailSettings };
