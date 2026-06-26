/* hamlive-oss — MIT License. See LICENSE. */

const { modelMaker } = require('../lib/modelMaker');
const { Schema, SchemaTypes } = require('mongoose');
const uniqueValidator = require('mongoose-unique-validator');
require('mongoose-type-email');

const { flexOptionsLocalSchema } = require('./flexOptions');

const userProfileSchema = new Schema(
    {
        displayName: {
            type: String,
            required: [true, 'display name required'],
            unique: false,
            minlength: 2,
            maxlength: 40,
            validate: {
                validator: function (v) {
                    return /^[A-Za-z0-9À-ÿ\-'.()\/ ]+$/.test(v);
                },
                message: 'invalid characters in display name'
            }
        },
        googleId: String,
        lastLogin: { type: Date, default: Date.now },
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
        photo: {
            type: String,
            validate: {
                validator: function (v) {
                    if (!v) return true; // Allow empty/null values
                    // Accept full URLs (https://...) and protocol-relative URLs (//...)
                    if (v.startsWith('//')) return true;
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
            unique: false,
            // Raised 24 -> 60: QRZ auto-fill builds "City (Country)" strings that
            // legitimately exceed 24 (e.g. "Sapphire Central (Australia)"), which
            // previously failed validation and blocked the whole profile save.
            maxlength: [60, 'Location must be 60 characters or fewer.'],
            validate: {
                validator: function (v) {
                    if (v === '' || v == null) { return true; }
                    return v.length >= 5 && /^[0-9A-Za-zÀ-ÿ-', ()]+$/.test(v);
                },
                message: 'location must be 5 to 60 characters'
            }
        },
        newAccount: { type: Boolean, default: true },
        lastAuthVia: {
            type: String,
            enum: {
                values: ['google', 'email'],
                message: '{VALUE} not in auth via list'
            },
            required: [true, 'lastAuthVia required in userprofile']
        },
        policyConsent: { type: Boolean, default: false },
        flaggedForDeletion: { type: Boolean, default: false },
        email: {
            type: SchemaTypes.Email,
            required: true,
            unique: true,
            sparse: true
        },
        locked: { type: Boolean, default: false },
        lockedUntil: { type: Date, default: null },
        lastIp: { type: String, default: '' },
        superUser: { type: Boolean, default: false, index: true },
        verified: { type: Boolean, default: false },
        flexOptions: {
            type: flexOptionsLocalSchema
        },
        initialReg: {
            type: Schema.Types.ObjectId,
            ref: 'InitialReg'
        },
        myNets: [
            {
                type: Schema.Types.ObjectId,
                ref: 'NetProfile'
            }
        ],
        following: [
            {
                type: Schema.Types.ObjectId,
                ref: 'NetProfile'
            }
        ],
        dismissedNotifications: [
            {
                notificationId: {
                    type: String,
                    required: true
                },
                dismissedAt: {
                    type: Date,
                    default: Date.now
                }
            }
        ]
    },
    { timestamps: true }
);

// SUPPORT_EMAIL (optional) lets the duplicate-callsign message point users who
// need to change the email on an existing account at a real support address.
// Unset -> the message omits that clause. See .env.example.
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || '').trim();
userProfileSchema.plugin(uniqueValidator, {
    message: SUPPORT_EMAIL
        ? `That callsign already has an account. If it is yours, sign out and sign back in with the email you first registered it with, or email ${SUPPORT_EMAIL} to change the email on your account.`
        : 'That callsign already has an account. If it is yours, sign out and sign back in with the email you first registered it with.'
});

module.exports = {
    getUserProfile: db => modelMaker({ db, m: 'UserProfile', s: userProfileSchema }),
    userProfileSchema
};
