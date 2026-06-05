/* hamlive-oss — MIT License. See LICENSE. */

const NetAdminCmd = require('../netAdminCmd');
const { logger } = require('../logger');
const { checkState } = require('../sharedNetOps');

class CheckStateApplicator extends NetAdminCmd {
    // Define a private field to store the target state
    #stateToApply;

    constructor({ db, cs, commandProperties, label, stateToApply }) {
        super({
            label,
            commandProperties: { ...commandProperties, deps: [...commandProperties.deps, 'c'] }, // depends on the c command for stats/counts
            db,
            cs
        });

        this.#stateToApply = stateToApply;
    }
    async run({ req, res, cmdLine }) {
        await super.run({ req, res, cmdLine });

        // -m deprecated
        if (this.parsedArgs.m) {
            throw new Error(`-m no longer needed (run 'help ${this.cmd}' for more info)`);
        }
    }

    async checkedStationsReport() {
        // Define a map that associates check states with station lists
        const stationListByCheckedState = new Map([
            [true, 'cIn'],
            [false, 'cOut'],
            [null, 'lurkers'] // not likely to be used but just here for completeness
        ]);

        // Throw an error if the current state is not in the map
        if (!stationListByCheckedState.has(this.#stateToApply)) {
            throw new Error(
                `CheckStateApplicator: Key of type ${typeof this.#stateToApply} with value ${this.#stateToApply} does not exist in the stationListByCheckedState map`
            );
        }

        // Get the station list associated with the current state
        const list = stationListByCheckedState.get(this.#stateToApply);

        // Get all checked states object, contains an array of checked stations for each state
        const allCheckedStateLists = await this.getStationStates();

        // Join the checked states into a string, or use an empty string if there are no checked states
        const checkedStationsString = allCheckedStateLists[list]?.join(', ') || '';

        // Return a report of the checked(in|out) stations
        return `${list}: ${checkedStationsString}`;
    }

    async applyCheckState({ stateToApply, dstStations }) {
        // Update the state to apply if a new one is provided
        this.#stateToApply = typeof stateToApply !== 'undefined' ? stateToApply : this.#stateToApply;

        const checkStateResult = await checkState({
            liveNet: this.data.instance.ln,
            srcStation: this.req.user.callSign.toUpperCase(),
            dstStations,
            highlight: this.parsedArgs.h,
            hand: this.parsedArgs.u,
            state: this.#stateToApply,
            flexOpts: this.res.locals.flexOpts,
            db: this.db
        });

        const stateLabels = {
            true: 'IN',
            false: 'OUT',
            null: 'CLEARED'
        };

        const resultString = checkStateResult
            .map(o => {
                const stateLabel = stateLabels[o.checkedState];
                const dupe = o.dupe ? '(dup)' : '';
                return `${o.callSign.toLowerCase()}: ${stateLabel}${dupe}`;
            })
            .join(', ');

        const shellResult = await this.shell('c');

        return `${resultString} (${shellResult})`;
    }
}

module.exports = CheckStateApplicator;
