/* hamlive-oss — MIT License. See LICENSE. */
const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');

const emailEventSchema = new Schema({
    sgEventId:   { type: String, required: true, unique: true },
    batchId:     { type: String, index: true },
    email:       { type: String, index: true },
    event:       { type: String, required: true },
    reason:      { type: String },
    sgMessageId: { type: String },
    timestamp:   { type: Date }
});

module.exports = {
    getEmailEvent: db => modelMaker({ db, m: 'EmailEvent', s: emailEventSchema }),
    emailEventSchema
};
