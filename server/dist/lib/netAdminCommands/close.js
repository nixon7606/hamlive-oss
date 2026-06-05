/* hamlive-oss — MIT License. See LICENSE. */

const { closeNet } = require('../sharedNetOps');
const NetAdminCmd = require('../netAdminCmd');
const { NetNotFoundError } = require('../../types/commonTypesupport');

class CloseCmd extends NetAdminCmd {
    constructor({ db, cs }) {
        super({
            label: 'close-net',
            commandProperties: {
                cmd: 'close',
                alias: [],
                verboseUsage: '(close) close net, usage: close',
                compactUsage: 'close',
                advanced: false,
                hidden: false,
                level: 0,
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
        try {
            await super.run({ req, res, cmdLine });
        } catch (err) {
            if (err instanceof NetNotFoundError) {
                throw new Error(`Net already closed`);
            } else {
                throw err;
            }
        }

        closeNet({
            netProfileDoc: this.data.instance.np,
            liveNetDoc: this.data.instance.ln,
            db: this.db
        });

        return `closing ...`;
    }
}

module.exports = CloseCmd;
