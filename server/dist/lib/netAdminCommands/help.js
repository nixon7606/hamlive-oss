/* hamlive-oss — MIT License. See LICENSE. */

const NetAdminCmd = require('../netAdminCmd');
const { logger } = require('../logger');

class HelpCmd extends NetAdminCmd {
    constructor({ db, cs }) {
        super({
            label: 'help',
            commandProperties: {
                cmd: 'help',
                alias: ['?'],
                verboseUsage: '(help) display command help messages, usage: help [ <command> ]',
                compactUsage: '? [ <command> ]',
                advanced: false,
                hidden: false,
                level: 3,
                mustBeCheckedIn: false,
                minArgs: 0,
                maxArgs: 1,
                deps: []
            },
            db,
            cs
        });
    }

    async run({ req, res, cmdLine }) {
        await super.run({ req, res, cmdLine });

        if (cmdLine.length === 0) {
            let output = 'commands:[';

            const { commandDetail, aliases } = this.cs.getMine(this.myLevel);

            output += commandDetail
                .map(cmd => {
                    return cmd.command;
                })
                .join(', ');

            output += ']  aliases:[';

            let i = 1;
            aliases.forEach(a => {
                if (i < aliases.length) {
                    output += `${a.alias}:${a.command}, `;
                } else {
                    output += `${a.alias}:${a.command}`;
                }
                i++;
            });

            output += ']';

            return output;
        } else {
            return this.cs.usage(cmdLine[0]);
        }
    }
}

module.exports = HelpCmd;
