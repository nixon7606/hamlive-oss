/* hamlive-oss — MIT License. See LICENSE. */

const NetAdminCmd = require('../netAdminCmd');

class CountCmd extends NetAdminCmd {
    constructor({ db, cs }) {
        super({
            label: 'count',
            commandProperties: {
                cmd: 'c',
                alias: [],
                verboseUsage: '(count) display net stats',
                compactUsage: 'c',
                advanced: true,
                hidden: false,
                level: 1,
                mustBeCheckedIn: false,
                minArgs: 0,
                maxArgs: 0,
                deps: []
            },
            db,
            cs
        });
    }

    async run({ req, res, cmdLine }) {
        await super.run({ req, res, cmdLine });

        const { cIn, cOut, lurkers } = await this.getStationStates();

        return `count: ${cIn.length + cOut.length}, ${cIn.length}-in/${cOut.length}-out, lurking: ${lurkers.length}`;
    }
}

module.exports = CountCmd;
