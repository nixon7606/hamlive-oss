/* hamlive-oss — MIT License. See LICENSE. */

const RoleModifier = require('./roleModifier');

class LoggerCmd extends RoleModifier {
    constructor({ db, cs }) {
        super({
            targetRole: 'netlogger',
            label: 'logger',
            commandProperties: {
                cmd: 'l',
                alias: [],
                verboseUsage: '(l) promote station to logger, usage: l <callsign> [<callsign>...]',
                compactUsage: 'l <call>',
                advanced: false,
                hidden: false,
                level: 0,
                mustBeCheckedIn: true,
                minArgs: 0,
                maxArgs: 5,
                deps: []
            },
            db,
            cs
        });
    }

    async run({ req, res, cmdLine }) {
        return await super.run({ req, res, cmdLine });
    }
}

module.exports = LoggerCmd;
