/* hamlive-oss — MIT License. See LICENSE. */

const CheckStateApplicator = require('./checkStateApplicator');

class CheckOutCmd extends CheckStateApplicator {
    constructor({ db, cs }) {
        super({
            label: 'check-out',
            stateToApply: false,
            commandProperties: {
                cmd: 'o',
                alias: [],
                verboseUsage:
                    '(o) checkout station, usage: o <callsign> <callsign>... (tip: right-click callsign is faster)',
                compactUsage: 'o <call> (or right-click call)',
                advanced: false,
                hidden: false,
                level: 1,
                mustBeCheckedIn: true,
                minArgs: 0,
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

        if (Array.isArray(dstStations) && dstStations.length === 0) {
            return await this.checkedStationsReport();
        }

        return await this.applyCheckState({ dstStations });
    }
}

module.exports = CheckOutCmd;
