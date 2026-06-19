/* hamlive-oss — MIT License. See LICENSE. */

const { logger } = require('../logger');
const PluginBase = require('../pluginBase');
const { flagAccountForDeletion } = require('../../lib/sharedNetOps');

class FlagAccountsTask extends PluginBase {
    constructor({ label, options, db }) {
        super({ label, options, db });
    }

    async run() {
        const oldAccounts = await this.data.model.UserProfile.find({
            lastLogin: {
                $lt: new Date(Date.now() - this.options.ttl_days * 24 * 60 * 60 * 1000)
            }
        });

        const lackingConsent = await this.data.model.UserProfile.find({
            policyConsent: false
        });

        // De-dupe by _id: an account that is both stale AND lacking consent would
        // otherwise be flagged twice (duplicate work / duplicate PendingAccountDelete).
        const accountsToDelete = Array.from(
            new Map([...oldAccounts, ...lackingConsent].map(doc => [doc._id.toString(), doc])).values()
        );

        if (accountsToDelete.length) {
            await Promise.all(
                accountsToDelete.map(userProfileDoc => {
                    if (Date.now() - userProfileDoc.createdAt > this.options.account_create_min * 60 * 1000) {
                        return flagAccountForDeletion({ userProfileDoc, db: this.db });
                    } else {
                        logger.warn(`Not flagging ${userProfileDoc.id} as its in creation grace period`);
                    }
                })
            );
        }
    }

    async cleanUp() {
        await super.cleanUp();
    }
}

module.exports = FlagAccountsTask;
