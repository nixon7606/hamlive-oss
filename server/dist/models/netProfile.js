/* hamlive-oss — MIT License. See LICENSE. */
const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');
const uniqueValidator = require('mongoose-unique-validator');

const netProfileSchema = new Schema(
    {
        title: {
            type: String,
            required: [true, 'Net Title Required'],
            unique: true,
            minlength: 4,
            maxlength: 25,
            validate: {
                validator: function (v) {
                    return /^\w+(?:[&.'\- ]*\w+)*$/.test(v);
                },
                message: 'net title format did not pass validation'
            }
        },
        frequency: {
            type: String,
            maxlength: 20,
            validate: {
                validator: function (v) {
                    if (v === '') {
                        return true;
                    }
                    return /^\d+[.]\d+(?:([.]\d+))?$/.test(v);
                },
                message: 'frequency format did not pass validation'
            }
        },
        mode: {
            type: String,
            enum: {
                values: [
                    'LSB',
                    'USB',
                    'AM',
                    'CW',
                    'FM',
                    'RTTY',
                    'FSQ',
                    'PSK-31',
                    'FreeDV',
                    'Reflector',
                    'Olivia',
                    'Hell',
                    'JS8Call',
                    'CUSTOM'
                ],
                message: '{VALUE} not in valid mode list'
            },
            required: [true, 'Mode Required']
        },
        modeDetails: {
            type: String,
            required: false,
            maxlength: 15,
            validate: {
                validator: function (v) {
                    if (v === '') {
                        return true;
                    }
                    return /^\w+(?:[&. ]*\w+)*$/.test(v);
                },
                message: 'mode details contains invalid characters'
            }
        },
        notes: {
            type: String,
            required: false,
            maxlength: 320,
            default: ''
        },
        owners: [
            {
                type: Schema.Types.ObjectId,
                ref: 'UserProfile',
                required: [true, 'user upid for owners required']
            }
        ],
        followers: [
            {
                type: Schema.Types.ObjectId,
                ref: 'UserProfile'
            }
        ],
        liveNet: {
            type: Schema.Types.ObjectId,
            ref: 'LiveNet'
        },
        autoIn: { type: Boolean, default: false },
        permanent: { type: Boolean, default: false },
        restrictedSigReports: { type: Boolean, default: false },
        invisible: { type: Boolean, default: false }
    },
    { timestamps: true }
);

netProfileSchema.plugin(uniqueValidator, {
    message: 'A net already exists with this name'
});

module.exports = {
    getNetProfile: db => modelMaker({ db, m: 'NetProfile', s: netProfileSchema }),
    netProfileSchema
};
