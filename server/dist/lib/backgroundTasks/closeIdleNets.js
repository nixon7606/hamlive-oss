/* hamlive-oss — MIT License. See LICENSE. */

const { logger } = require('../logger');
const PluginBase = require('../pluginBase');
const { closeNet } = require('../../lib/sharedNetOps');
const { hoursToMilliseconds } = require('../../lib/serverUtils');

class CloseIdleNetsTask extends PluginBase {
    constructor({ label, options, db }) {
        super({ label, options, db });
    }

    async run() {
        const defaultAbandonedAfterHours = 2;
        const abandonedAfterMs = this.options.abandoned_after_hours
            ? hoursToMilliseconds(this.options.abandoned_after_hours)
            : hoursToMilliseconds(defaultAbandonedAfterHours);

        const longRunningNets = await this.data.model.LiveNet.find({
            createdAt: {
                $lt: new Date(Date.now() - abandonedAfterMs)
            }
        });

        if (!longRunningNets.length) {
            logger.info('No long running nets found...');
            return;
        }

        for (const liveNet of longRunningNets) {
            // By default we close all long running nets,
            // but we skip both permanent nets and nets with active admins (first attendee)

            const np = await this.data.model.NetProfile.findById(liveNet.netProfile);

            if (!np) {
                logger.error(`NetProfile not found: ${liveNet.netProfile} for LiveNet: ${liveNet._id}...`);
                continue;
            }

            if (np.permanent) {
                logger.info(`Permanent net: ${np.title}, skipping auto-close...`);
                continue;
            }

            //array of all ncs interaction docs
            const ncsIaS = (
                await Promise.all(
                    Array.from(liveNet.lookupTable.values())
                        .map(tableEntry => tableEntry.stationInteraction)
                        .map(IaId => this.data.model.StationInteraction.findById(IaId))
                )
            ).filter(ia => ia.role === 'netcontrol');

            //see if one ncs is still active
            const activeNcs = ncsIaS.find(ia => ia.lastSeen && Date.now() - ia.lastSeen < abandonedAfterMs);

            if (activeNcs) {
                logger.warn(
                    `Long running net: ${np.title} has active admin: ${activeNcs.callSign}, skipping auto-close...`
                );
                continue;
            } else {
                logger.debug(`ncsIaS: ${JSON.stringify(ncsIaS)}`);
                logger.warn(`Long running net: ${np.title} has no active admin, closing...`);
            }

            //default to closing the net
            logger.warn(`Closing Idle: ${np.title}...`);
            await closeNet({ netProfileDoc: np, liveNetDoc: liveNet, db: this.db });
        }
    }

    async cleanUp() {
        await super.cleanUp();
    }
}

module.exports = CloseIdleNetsTask;
