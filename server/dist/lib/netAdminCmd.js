/* hamlive-oss — MIT License. See LICENSE. */

const PluginBase = require('./pluginBase');
const mongoose = require('mongoose');
const argParser = require('./argp');
const { getStationDetail } = require('./sharedNetOps');
const { NetNotFoundError } = require('../types/commonTypesupport');

class NetAdminCmd extends PluginBase {
    #cs;

    constructor({ label, commandProperties, db = mongoose.connection, cs }) {
        super({ label, db });

        this.#cs = cs;

        //required cmd props:
        [
            'cmd',
            'alias',
            'verboseUsage',
            'compactUsage',
            'advanced',
            'mustBeCheckedIn',
            'level',
            'hidden',
            'minArgs',
            'maxArgs',
            'deps'
        ].forEach(p => {
            if (Object.prototype.hasOwnProperty.call(commandProperties, p)) {
                if (typeof commandProperties[p] !== 'undefined' || commandProperties[p] !== null) {
                    Object.defineProperty(this, p, {
                        get: function () {
                            return commandProperties[p];
                        }
                    });
                } else {
                    throw new Error(`${this.getClassName()}: cmd property ${p} has no value`);
                }
            } else {
                throw new Error(`${this.getClassName()}: missing required cmd property: ${p}`);
            }
        });
    }

    get cs() {
        return this.#cs;
    }

    async getCheckedStateOne(station) {
        return (
            await this.data.model.StationInteraction.findById(
                this.data.instance.ln.lookupTable.get(station.toUpperCase())?.stationInteraction
            )
        )?.checkedState;
    }

    async getStationStates() {
        const allIAs = await Promise.all(
            [...this.data.instance.ln.lookupTable.values()].map(v => {
                return this.data.model.StationInteraction.findById(v.stationInteraction);
            })
        );

        const { awayInMs } = this.res.locals.flexOpts;

        const present = allIAs.filter(ia => Date.now() - ia.lastSeen < (awayInMs || 2500));

        return {
            cIn: allIAs.filter(ia => ia.checkedState === true).map(ia => ia.callSign.toLowerCase()),
            cOut: allIAs.filter(ia => ia.checkedState === false).map(ia => ia.callSign.toLowerCase()),
            present,
            lurkers: present.filter(ia => ia.checkedState === null).map(ia => ia.callSign.toLowerCase())
        };
    }

    async run({ req, res, cmdLine }) {
        Object.defineProperties(this, {
            req: {
                get: function () {
                    return req;
                },
                configurable: true
            },
            res: {
                get: function () {
                    return res;
                },
                configurable: true
            },
            npid: {
                get: function () {
                    return req.params.id;
                },
                configurable: true
            },
            parsedArgs: {
                get: function () {
                    return argParser(cmdLine, {
                        boolean: ['m', 'u', 'a', 'd', 'h', 'l'],
                        '--': true,
                        stopEarly: true
                    });
                },
                configurable: true
            }
        });

        if (cmdLine.length > this.maxArgs) {
            throw new Error(`${this.cmd}: exceeded max args of ${this.maxArgs}`);
        } else if (cmdLine.length < this.minArgs) {
            throw new Error(`${this.cmd}: requires at least ${this.minArgs} arg`);
        }

        if ((this.data.instance.np = await this.data.model.NetProfile.findById(this.npid))) {
            if ((this.data.instance.ln = await this.data.model.LiveNet.findById(this.data.instance.np.liveNet))) {
                const rd = await getStationDetail({
                    db: this.db,
                    lnid: this.data.instance.ln._id,
                    station: req.user.callSign
                });

                Object.defineProperties(this, {
                    myLevel: {
                        get: function () {
                            return rd.level;
                        },
                        configurable: true
                    },
                    myRole: {
                        get: function () {
                            return rd.role;
                        },
                        configurable: true
                    }
                });

                if (this.myLevel <= this.level) {
                    if (this.mustBeCheckedIn && (await this.getCheckedStateOne(req.user.callSign)) !== true) {
                        throw new Error(`${this.cmd}: you must be checked-in to exec command`);
                    }
                } else {
                    throw new Error(`${this.cmd}: insufficient privileges (current role: ${this.myRole})`);
                }
            } else {
                throw new NetNotFoundError(`${this.cmd}: livenet not found (npid: ${this.npid})`);
            }
        } else {
            throw new Error(`${this.cmd}: netprofile ${this.npid} not found`);
        }

        return;
    }

    shell(input) {
        return this.cs.run(this.req, this.res, input);
    }
}

module.exports = NetAdminCmd;
