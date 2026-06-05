/* hamlive-oss — MIT License. See LICENSE. */

const { logger } = require('./logger');
let receivedStart = false;
const { conf } = require('./configLib');
const mongoose = require('mongoose');

process.on('message', mesg => {
    if (mesg == 'START_TASKS') {
        logger.debug('tasksLoader received start message');

        if (!receivedStart) {
            receivedStart = true;

            if (conf.background_tasks) {
                (async function () {
                    const db = await mongoose.createConnection(conf.dburi, {
                        maxPoolSize: conf.batch_mongoose_poolsize
                    });
                    logger.info('connected to db (batch processing pool)');

                    for (const label of Object.keys(conf.background_tasks)) {
                        if (conf.background_tasks[label].enabled) {
                            const tStart = process.hrtime();

                            const t = new (require(`./backgroundTasks/${label}`))({
                                label,
                                options: conf.background_tasks[label].options,
                                db
                            });

                            try {
                                logger.info(`Executing: ${t.getClassName()}.run()`);
                                await t.run();
                            } catch (err) {
                                logger.error(err.stack);
                            } finally {
                                try {
                                    logger.info(`Executing: ${t.getClassName()}.cleanUp()`);
                                    await t.cleanUp();
                                } catch (err) {
                                    logger.error(err.stack);
                                }
                            }

                            const tStop = process.hrtime(tStart);

                            logger.info(
                                `${label} elapsed time: ${((tStop[0] * 1e9 + tStop[1]) / 1e9).toFixed(2)} seconds`
                            );
                        } else {
                            logger.warn(`task: ${label}: [disabled]`);
                        }
                    }

                    db.close();
                    logger.info('closed db (batch processing pool)');
                    process.exit(0);
                })();
            } else {
                logger.warn('no background tasks configured');
            }
        }
    }
});
