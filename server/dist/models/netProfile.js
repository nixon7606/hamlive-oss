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
                message: 'Net title must be 4 to 25 characters and may use letters, numbers, spaces, and & . - symbols'
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
                message: 'Enter frequency as a decimal in MHz, like 14.230 or 146.520'
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
        invisible: { type: Boolean, default: false },
        schedule: {
            type: {
                enabled: { type: Boolean, default: false },
                dayOfWeek: { type: Number, min: 0, max: 6 },
                hour: { type: Number, min: 0, max: 23 },
                minute: { type: Number, min: 0, max: 59 },
                timezone: { type: String, default: 'UTC' },
                notifyBeforeMinutes: { type: Number, default: 30, min: 5, max: 1440 },
                notifyBeforeEnabled: { type: Boolean, default: true },
                lastAutoStartedAt: { type: Date, default: null }
            },
            default: {}
        }
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
