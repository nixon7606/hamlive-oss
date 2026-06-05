/* hamlive-oss — MIT License. See LICENSE. */

const RoleModifier = require('./roleModifier');

class HandOffCmd extends RoleModifier {
    constructor({ db, cs }) {
        super({
            targetRole: 'netcontrol',
            label: 'handoff',
            commandProperties: {
                cmd: 'handoff',
                alias: [],
                verboseUsage: '(handoff) handoff netcontrol to station, usage: handoff <callsign>',
                compactUsage: 'handoff <call>',
                advanced: false,
                hidden: false,
                level: 0,
                mustBeCheckedIn: true,
                minArgs: 1,
                maxArgs: 1,
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

module.exports = HandOffCmd;
