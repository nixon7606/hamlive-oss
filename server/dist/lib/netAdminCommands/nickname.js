/* hamlive-oss — MIT License. See LICENSE. */

const { nameCase } = require('@foundernest/namecase');
const { wellFormedCall } = require('../serverUtils');
const NetAdminCmd = require('../netAdminCmd');
const { logger } = require('../logger');
const { conf } = require('../configLib');

class NicknameCmd extends NetAdminCmd {
    constructor({ db, cs }) {
        super({
            label: 'nickname',
            commandProperties: {
                cmd: 'nick',
                alias: ['nickname'],
                verboseUsage: 'nick <callsign> <newname>',
                compactUsage: 'nick <callsign> <newname>',
                advanced: true,
                hidden: true,
                level: 0,
                mustBeCheckedIn: true,
                minArgs: 2,
                maxArgs: 4,
                deps: []
            },
            db,
            cs
        });
    }

    async run({ req, res, cmdLine }) {
        await super.run({ req, res, cmdLine });

        const [rawCallSign, ...nicknameParts] = cmdLine;
        if (typeof rawCallSign !== 'string') {
            throw new Error('received non-string value as first arg');
        }

        const callSign = rawCallSign.toUpperCase();
        if (!wellFormedCall(callSign)) {
            throw new Error(`${this.label}: malformed callsign`);
        }

        const localNickname = nameCase(nicknameParts.join(' '));

        // Prevent nickname update if callsign is associated with a registered account
        const userProfile = await this.data.model.UserProfile.findOne({ callSign });
        if (userProfile) {
            throw new Error(
                `${callSign.toLowerCase()} must update their display name in their existing ${
                    conf.app_name || 'account'
                } account settings`
            );
        }

        logger.warn(`${this.req.user.callSign.toUpperCase()} renaming ${callSign} to ${localNickname}`);

        // Update the localNickname in the QRZ cache for unregistered callsigns
        const qrzCacheDoc = await this.data.model.QrzCache.findOneAndUpdate(
            { callSign },
            { $set: { localNickname } },
            { new: false, runValidators: true }
        );
        if (!qrzCacheDoc) {
            throw new Error(`${this.label}: ${callSign} not found in QRZ cache`);
        }

        // Update the StationInteraction document's displayName, for active/running net
        const stationInteractionId = this.data.instance.ln.lookupTable.get(callSign)?.stationInteraction;
        if (stationInteractionId) {
            await this.data.model.StationInteraction.findByIdAndUpdate(
                stationInteractionId,
                { $set: { displayName: localNickname } },
                { runValidators: true }
            );
        }

        return `${callSign}: ${qrzCacheDoc.localNickname ?? qrzCacheDoc.displayName} ➔ ${localNickname}`;
    }
}

module.exports = NicknameCmd;
