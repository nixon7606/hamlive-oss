/* hamlive-oss — MIT License. See LICENSE. */

const { logger } = require('../logger');
const PluginBase = require('../pluginBase');
const { unFollow } = require('../../lib/sharedNetOps');

class ProcessUnfollowJobsTask extends PluginBase {
    constructor({ label, options, db }) {
        super({ label, options, db });
    }

    async run() {
        const unFollowTaskList = await this.data.model.PendingUnfollow.find();

        if (unFollowTaskList.length) {
            for (const task of unFollowTaskList) {
                let { upid, npid, unlink } = task;
                logger.info(await unFollow({ upid, npid, unlink, db: this.db }));
                await task.deleteOne({ _id: task._id });
            }
        }
    }

    async cleanUp() {
        await super.cleanUp();
    }
}

module.exports = ProcessUnfollowJobsTask;
