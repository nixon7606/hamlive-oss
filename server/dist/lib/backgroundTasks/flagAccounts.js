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

        const accountsToDelete = [].concat(oldAccounts, lackingConsent);

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
