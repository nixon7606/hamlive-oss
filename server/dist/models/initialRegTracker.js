/* hamlive-oss — MIT License. See LICENSE. */

const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');
const uniqueValidator = require('mongoose-unique-validator');

const initialRegSchema = new Schema(
    {
        callSign: {
            type: String,
            unique: true,
            sparse: true,
            minlength: 3,
            maxlength: 7,
            validate: {
                validator: v => /^(\d?[a-zA-Z]{1,3}|[a-zA-Z]\d[a-zA-Z]?)\d[a-zA-Z]{1,4}$/.test(v),
                message: 'malformed callsign'
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
