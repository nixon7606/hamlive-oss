/* hamlive-oss — MIT License. See LICENSE. */
const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');

const emailTemplateSchema = new Schema({
    key:       { type: String, required: true, unique: true, enum: ['magic-link', 'net-announce', 'net-close'] },
    subject:   { type: String, required: true },
    html:      { type: String, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'UserProfile' }
}, { timestamps: true });

module.exports = {
    emailTemplateSchema,
    getEmailTemplate: db => modelMaker({ db, m: 'EmailTemplate', s: emailTemplateSchema })
};
