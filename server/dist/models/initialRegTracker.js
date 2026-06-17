/* hamlive-oss — MIT License. See LICENSE. */

const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');
// mongoose-unique-validator v6 is ESM-only; under CJS require() the plugin is on .default.
const uniqueValidator = require('mongoose-unique-validator').default || require('mongoose-unique-validator');

const initialRegSchema = new Schema(
    {
        callSign: {
            type: String,
            unique: true,
            sparse: true,
            minlength: 3,
            maxlength: 14,
            validate: {
                validator: v => /^(?:[a-zA-Z0-9]{1,4}\/)?(\d?[a-zA-Z]{1,3}|[a-zA-Z]\d[a-zA-Z]?)\d[a-zA-Z]{1,4}(?:\/[a-zA-Z0-9]{1,4})?$/.test(v),
                message: 'Enter a valid callsign, for example N0AD or a portable form like N0AD/M'
            }
        },
        startOfGracePeriod: {
            type: Date,
            required: true
        }
    },
    { timestamps: false }
);

initialRegSchema.plugin(uniqueValidator, {
    message: 'This callsign already exists in tracker'
});

module.exports = {
    getInitialReg: db => modelMaker({ db, m: 'InitialReg', s: initialRegSchema }),
    initialRegSchema
};
