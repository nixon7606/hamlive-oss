/* hamlive-oss — MIT License. See LICENSE. */

const CheckStateApplicator = require('./checkStateApplicator');

class UnCheckInCmd extends CheckStateApplicator {
    constructor({ db, cs }) {
        super({
            label: 'undo-check-in',
            stateToApply: null,
            commandProperties: {
                cmd: 'ui',
                alias: [],
                verboseUsage: '(ui) undo-checkin, usage: ui <callsign> [<callsign>...]',
                compactUsage: 'ui <call>',
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

        return await this.applyCheckState({ dstStations });
    }
}

module.exports = UnCheckInCmd;
