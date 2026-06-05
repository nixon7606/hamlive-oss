/* hamlive-oss — MIT License. See LICENSE. */

// Each NetAdmin command may have potential unhandled promise rejections. This issue was addressed in this file.
// however, it's recommended to review and refactor all commands to ensure promises are properly awaited and rejections are handled.const NetAdminCmd = require('../netAdminCmd');
const { logger } = require('../logger');
const { hand } = require('../sharedNetOps');
const { wellFormedCall } = require('../serverUtils');
const NetAdminCmd = require('../netAdminCmd');

class HandCmd extends NetAdminCmd {
    constructor({ db, cs }) {
        super({
            label: 'hand',
            commandProperties: {
                cmd: 'hand',
                alias: [],
                verboseUsage:
                    '(hand) change hand state for all attendees, usage: hand { -u | -d } <callsign> [-a (all)]',
                compactUsage: 'hand { -u | -d } <callsign> [-a (all)]',
                advanced: true,
                hidden: false,
                level: 1,
                mustBeCheckedIn: false,
                minArgs: 1,
                maxArgs: 2,
                deps: []
            },
            db,
            cs
        });
    }

    async run({ req, res, cmdLine }) {
        await super.run({ req, res, cmdLine });

        let state;
        if (this.parsedArgs.u ^ this.parsedArgs.d) {
            state = this.parsedArgs.u ? true : false;
        } else if (!this.parsedArgs.u && !this.parsedArgs.d) {
            throw new Error('specify a desired (up or down) hand state');
        } else {
            throw new Error('invalid command option combination');
        }

        const handOpOne = async dstStation => {
            try {
                const handState = await hand({
                    liveNet: this.data.instance.ln,
                    srcStation: this.req.user.callSign.toUpperCase(),
                    dstStation,
                    state,
                    db: this.db
                });

                return dstStation.toLowerCase();
            } catch (err) {
                console.error(err);
                throw err;
            }
        };

        if (this.parsedArgs.a === true) {
            const stations = await Promise.all([...this.data.instance.ln.lookupTable.keys()].map(handOpOne));
            return `hand: ${state ? 'up' : 'down'} for stations: ${stations.join(', ')}`;
        } else {
            const dstStation = this.parsedArgs._[0];
            if (!dstStation) throw new Error('missing callsign');
            if (!wellFormedCall(dstStation)) throw new Error(`malformed callsign: ${dstStation}`);
            const result = await handOpOne(dstStation);
            return `hand: ${state ? 'up' : 'down'} for station: ${result}`;
        }
    }
}

module.exports = HandCmd;
