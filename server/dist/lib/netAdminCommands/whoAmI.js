/* hamlive-oss — MIT License. See LICENSE. */

const NetAdminCmd = require('../netAdminCmd');
const { logger } = require('../logger');
const { netOwnerCheck, getStationDetail } = require('../sharedNetOps');
const { wellFormedCall } = require('../serverUtils');

class WhoAmICmd extends NetAdminCmd {
    constructor({ db, cs }) {
        super({
            label: 'whoami',
            commandProperties: {
                cmd: 'w',
                alias: [],
                verboseUsage: '(whoami) display role and level, usage: w [<callsign>]',
                compactUsage: 'w [<call>]',
                advanced: false,
                hidden: false,
                mustBeCheckedIn: false,
                level: 3,
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
            let { confirmed } = await netOwnerCheck({ req, db: this.db });
            return `${req.user.callSign.toLowerCase()}: ${this.myRole}/${this.myLevel} [owner:${confirmed.toString()}]`;
        } else {
            let confirmed = false;
            const station = cmdLine[0].toUpperCase();
            if (!wellFormedCall(station)) throw new Error(`${this.label}: malformed callsign`);

            const upid = (
                await this.data.model.UserProfile.findOne({
                    callSign: station
                })
            )?.id;

            if (upid) ({ confirmed } = await netOwnerCheck({ upid, npid: this.data.instance.np.id, db: this.db }));

            let theirRd = await getStationDetail({
                lnid: this.data.instance.ln._id,
                station: station
            });
            return `${station.toLowerCase()}: ${theirRd.role}/${theirRd.level} [owner:${confirmed.toString()}]`;
        }
    }
}

module.exports = WhoAmICmd;
