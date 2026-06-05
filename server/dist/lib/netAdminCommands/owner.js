/* hamlive-oss — MIT License. See LICENSE. */

const NetAdminCmd = require('../netAdminCmd');
const { addNetOwner } = require('../sharedNetOps');
const { logger } = require('../logger');

class OwnerCmd extends NetAdminCmd {
    constructor({ db, cs }) {
        super({
            label: '+co-owner',
            commandProperties: {
                cmd: 'owner',
                alias: [],
                verboseUsage: '(owner) add net co-owner, usage: owner [<email addr>]',
                compactUsage: 'owner [<email addr>]',
                advanced: true,
                hidden: false,
                level: 0,
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
            const result = await Promise.all(
                this.data.instance.np.owners.map(async upid => {
                    return this.data.model.UserProfile.findById(upid);
                })
            );

            return 'Current Owners: ' + result.map(obj => obj.callSign.toLowerCase()).join(', ');
        } else {
            return await addNetOwner({
                newOwnerEmail: this.parsedArgs._[0],
                netProfiles: this.data.instance.np,
                flexOpts: this.res.locals.flexOpts,
                db: this.db
            });
        }
    }
}

module.exports = OwnerCmd;
