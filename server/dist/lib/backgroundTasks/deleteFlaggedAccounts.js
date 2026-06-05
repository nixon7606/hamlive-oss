/* hamlive-oss — MIT License. See LICENSE. */

const { logger } = require('../logger');
const PluginBase = require('../pluginBase');
const { createBulkUnfollowJob, delNet } = require('../../lib/sharedNetOps');

class DeleteFlaggedAccountsTask extends PluginBase {
    constructor({ label, options, db }) {
        super({ label, options, db });
    }

    async run() {
        const deleteTaskList = await this.data.model.PendingAccountDelete.find();

        if (deleteTaskList.length) {
            for (const task of deleteTaskList) {
                let userProfileDoc;

                if ((userProfileDoc = await this.data.model.UserProfile.findById(task.upid))) {
                    if (userProfileDoc.flaggedForDeletion) {
                        logger.warn(`deleting account ${userProfileDoc.id}...`);

                        if (userProfileDoc.following?.length) {
                            if (!userProfileDoc.following.every(e => userProfileDoc.myNets.includes(e))) {
                                await createBulkUnfollowJob({
                                    unlink: 'netOnly',
                                    upids: [userProfileDoc._id],
                                    npids: userProfileDoc.following,
                                    db: this.db
                                });
                            } else {
                                logger.info(
                                    `user ${userProfileDoc.id} only follows own nets, no need to create unfollow job`
                                );
                            }
                        }

                        if (userProfileDoc.myNets.length) {
                            logger.debug(`${userProfileDoc.callSign} owns nets`);

                            for (const npid of userProfileDoc.myNets) {
                                await delNet({ upid: userProfileDoc._id, npid: npid, db: this.db });
                            }
                        }

                        if (await userProfileDoc.deleteOne({ _id: userProfileDoc._id }))
                            task.deleteOne({ _id: task._id });
                    } else {
                        logger.info(
                            `account ${userProfileDoc.id} no longer flagged for deletion, removing delete task`
                        );

                        task.deleteOne({ _id: task._id });
                    }
                } else {
                    logger.error(`user delete task ${task.id} associated with nonexistent user, removing task`);
                    task.deleteOne({ _id: task._id });
                }
            }
        } else {
            logger.info(`account delete task queue empty`);
        }
    }

    async cleanUp() {
        await super.cleanUp();
    }
}

module.exports = DeleteFlaggedAccountsTask;
