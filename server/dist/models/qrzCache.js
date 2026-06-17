/* hamlive-oss — MIT License. See LICENSE. */

const { modelMaker } = require('../lib/modelMaker');
const { Schema, SchemaTypes } = require('mongoose');
// mongoose-unique-validator v6 is ESM-only; under CJS require() the plugin is on .default.
const uniqueValidator = require('mongoose-unique-validator').default || require('mongoose-unique-validator');

const qrzCacheSchema = new Schema(
    {
        displayName: String,
        localNickname: {
            type: String,
            unique: false,
            minlength: 2,
            maxlength: 20,
            validate: {
                validator: function (v) {
                    return /^[A-zÀ-ú-' ]+$/.test(v);
                },
                message: 'invalid characters in nickname'
            }
        },
        callSign: {
            type: String,
            unique: true,
            sparse: true
        },

        photo: {
            type: String,
            validate: {
                validator: function (v) {
                    if (!v) return true; // Allow empty/null values
                    try {
                        new URL(v);
                        return true;
                    } catch (e) {
                        return false;
                    }
                },
                message: props => `${props.value} is not a valid URL!`
            }
        },

        location: {
            type: String,
            unique: false
        },
        email: String,
        geo: {
            type: { type: String },
            coordinates: [Number]
        }
    },
    { timestamps: true }
);

qrzCacheSchema.plugin(uniqueValidator, {
    message: 'QRZ Cache: A user already exists with this callsign'
});

module.exports = {
    getQrzCache: db => modelMaker({ db, m: 'QrzCache', s: qrzCacheSchema }),
    qrzCacheSchema
};
