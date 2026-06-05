/* hamlive-oss — MIT License. See LICENSE.
 *
 * Print a comma-separated list of all user email addresses.
 * Uses the configured database (MONGODB_URI). Run from the repo root:
 *   node server/dist/bin/getAllEmail.js
 */
const mongoose = require('mongoose');
const { conf } = require('../lib/configLib');
const { logger } = require('../lib/logger');

mongoose
    .connect(conf.dburi, {
        maxPoolSize: 1
    })
    .then(() => {
        logger.info('Connected to db');

        const UserProfile = require('../models/userProfile').getUserProfile(null);

        UserProfile.find({}).then(res => {
            res.map(user => {
                process.stdout.write(`${user.email}, `);
            });

            console.log('\r\n');
            process.exit();
        });
    })
    .catch(error => {
        logger.error(error);
    });
