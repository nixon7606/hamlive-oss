/* hamlive-oss — MIT License. See LICENSE. */

const NetAdminCmd = require('../netAdminCmd');
const { logger } = require('../logger');

class CheckInHCmd extends NetAdminCmd {
    constructor({ db, cs }) {
        super({
            label: 'highlighted-check-in',
            commandProperties: {
                cmd: 'hi',
                alias: [],
                verboseUsage: '(hi) checkin with highlighting, usage: hi <callsign> <callsign>...',
                compactUsage: 'hi <callsign>',
                advanced: true,
                hidden: false,
                level: 1,
                mustBeCheckedIn: true,
                minArgs: 0,
                maxArgs: 20,
                deps: ['i']
            },
            db,
            cs
        });
    }

    async run({ req, res, cmdLine }) {
        await super.run({ req, res, cmdLine });

        return await this.shell('i -h ' + cmdLine.join(' '));
    }
}

module.exports = CheckInHCmd;
