/* hamlive-oss — MIT License. See LICENSE. */

const qrzCache = require('#@server/models/qrzCache.js');

class PluginBase {
    #options;
    #label;
    #db;
    #data;

    constructor({ options, label, db }) {
        this.#options = options;
        this.#label = label;
        this.#db = db;

        this.#data = {
            model: {
                LiveNet: require('../models/liveNet').getLiveNet(this.#db),
                StationInteraction: require('../models/stationInteraction').getStationInteraction(this.#db),
                NetProfile: require('../models/netProfile').getNetProfile(this.#db),
                UserProfile: require('../models/userProfile').getUserProfile(this.#db),
                PendingAccountDelete: require('../models/taskQueues').getPendingAccountDelete(this.#db),
                PendingUnfollow: require('../models/taskQueues').getPendingUnfollow(this.#db),
                QrzCache: require('../models/qrzCache').getQrzCache(this.#db)
            },
            instance: {}
        };
    }

    get options() {
        return this.#options;
    }

    get label() {
        return this.#label;
    }

    get db() {
        return this.#db;
    }

    get data() {
        return this.#data;
    }

    getClassName() {
        return this.constructor.name;
    }

    async run() {
        throw new Error(`${this.getClassName()} must implement a run() method`);
    }

    async cleanUp() {
        return;
    }
}

module.exports = PluginBase;
