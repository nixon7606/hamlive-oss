/* hamlive-oss — MIT License. See LICENSE. */

const RoleModifier = require('./roleModifier');

class RelayCmd extends RoleModifier {
    constructor({ db, cs }) {
        super({
            targetRole: 'netrelay',
            label: 'relay',
            commandProperties: {
                cmd: 'r',
                alias: [],
                verboseUsage: '(r) promote station to relay, usage: r <callsign> [<callsign>...]',
                compactUsage: 'r <call>',
                advanced: false,
                hidden: false,
                level: 1,
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

module.exports = RelayCmd;
