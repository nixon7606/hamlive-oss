/* hamlive-oss — MIT License. See LICENSE. */

const CheckStateApplicator = require('./checkStateApplicator');
const { logger } = require('../logger');

class CheckInOutCmd extends CheckStateApplicator {
    constructor({ db, cs }) {
        super({
            label: 'check-in-out',
            commandProperties: {
                cmd: 'io',
                alias: [],
                verboseUsage: '(io) checkin and immediately checkout, usage: io <callsign> [<callsign>...]',
                compactUsage: 'io <call>',
                advanced: false,
                hidden: false,
                level: 1,
                mustBeCheckedIn: true,
                minArgs: 1,
                maxArgs: 20,
                deps: []
            },
            db,
            cs
        });
    }

    async run({ req, res, cmdLine }) {
        await super.run({ req, res, cmdLine });

        const dstStations = this.parsedArgs._;

        // check-in
        await this.applyCheckState({ dstStations, stateToApply: true });
        // check-out
        return await this.applyCheckState({ dstStations, stateToApply: false });
    }
}

module.exports = CheckInOutCmd;
