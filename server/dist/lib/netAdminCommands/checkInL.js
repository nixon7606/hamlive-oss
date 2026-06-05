/* hamlive-oss — MIT License. See LICENSE. */

const NetAdminCmd = require('../netAdminCmd');
const { logger } = require('../logger');

class CheckInLCmd extends NetAdminCmd {
    constructor({ db, cs }) {
        super({
            label: 'lurkers-check-in',
            commandProperties: {
                cmd: 'li',
                alias: [],
                verboseUsage: '(li) checkin all lurkers, usage: li',
                compactUsage: 'li',
                advanced: true,
                hidden: false,
                level: 1,
                mustBeCheckedIn: true,
                minArgs: 0,
                maxArgs: 0,
                deps: ['i']
            },
            db,
            cs
        });
    }

    async run({ req, res, cmdLine }) {
        await super.run({ req, res, cmdLine });

        return await this.shell('i -l');
    }
}

module.exports = CheckInLCmd;
