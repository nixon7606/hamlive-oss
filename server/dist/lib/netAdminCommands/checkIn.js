/* hamlive-oss — MIT License. See LICENSE. */

const CheckStateApplicator = require('./checkStateApplicator');

class CheckInCmd extends CheckStateApplicator {
    constructor({ db, cs }) {
        super({
            label: 'check-in',
            stateToApply: true,
            commandProperties: {
                cmd: 'i',
                alias: [],
                verboseUsage:
                    '(i) check-in station, usage: i [-h (to highlight)] <callsign> <callsign>... | -l (to check-in lurkers)',
                compactUsage: 'i <call>...',
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

        const dstStations = this.parsedArgs.l ? (await this.getStationStates()).lurkers : this.parsedArgs._;

        if (Array.isArray(dstStations) && dstStations.length === 0) {
            return await this.checkedStationsReport();
        }

        return await this.applyCheckState({ dstStations });
    }
}

module.exports = CheckInCmd;
