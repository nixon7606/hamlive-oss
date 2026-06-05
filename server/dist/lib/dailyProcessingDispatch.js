/* hamlive-oss — MIT License. See LICENSE. */

const { conf } = require('./configLib');
const { logger } = require('./logger');
const DayTracker = require('../models/dayTracker').getDayTracker(null);
const { fork } = require('child_process');

let inCriticalSection = false;

const days = { Mon: false, Tue: false, Wed: false, Thu: false, Fri: false, Sat: false, Sun: false };

let lastRun;

async function dailyDispatch(req, res, next) {
    const today = new Date().toLocaleString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });

    if (!inCriticalSection && lastRun !== today) {
        inCriticalSection = true; // Set the flag to true to enter the critical section

        let trackerDoc;

        try {
            trackerDoc = await DayTracker.findOne();
            if (trackerDoc) {
                logger.info('found dailyProcessing tracker in db');
            } else {
                logger.debug('creating dailyProcessing tracker with defaults');
                trackerDoc = await DayTracker.create(days);
            }

            const now = new Date();
            const updatedAt = new Date(trackerDoc.updatedAt);
            const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

            if (!trackerDoc[today] || conf.run_background_tasks_on_startup || updatedAt < twentyFourHoursAgo) {
                logger.debug('Run Daily Maintenance');

                Object.keys(days).forEach(day => (trackerDoc[day] = false));
                trackerDoc[today] = true;

                if (await trackerDoc.save()) {
                    lastRun = today;
                    logger.info('Starting Daily Maintenance');

                    const child = fork(__dirname + '/tasksLoader');

                    child.on('message', mesg => {
                        logger.debug('ProcessingDispatch (parent) received message from tasksLoader (child):');
                        logger.debug(mesg);
                    });

                    child.on('close', () =>
                        logger.debug('dailyProcessingDispatch: tasksLoader (child) exited cleanly')
                    );
                    child.on('error', () =>
                        logger.error('dailyProcessingDispatch: tasksLoader (child) exited with errors')
                    );

                    child.send('START_TASKS');
                } else {
                    logger.info('could not save maintenance run state to db');
                }
            } else {
                logger.info(`maintenance already ran today (${today})`);
                lastRun = today;
                return next();
            }
        } catch (err) {
            logger.error(err.message);
        } finally {
            inCriticalSection = false; // Reset the flag to false to exit the critical section
        }
    }

    return next();
}

module.exports = dailyDispatch;
