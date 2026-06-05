#!/usr/bin/env node

const yargs = require('yargs');
const hideBin = require('yargs/helpers').hideBin;
const mongoose = require('mongoose');
const readline = require('readline');

const argv = yargs(hideBin(process.argv))
    .command('$0', 'register existing callsigns')
    .option('p', {
        alias: 'production',
        describe: 'apply to production db',
        type: 'boolean',
        default: false
    })
    .help().argv;

process.env['NODE_ENV'] = argv.production ? 'production' : 'development';
const {
    conf: { dburi: dbUri, batch_mongoose_poolsize }
} = require('#@server/lib/configLib.js');

const UserProfile = require('#@server/models/userProfile.js').getUserProfile(null);
const InitialReg = require('#@server/models/initialRegTracker.js').getInitialReg(null);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

(async () => {
    try {
        mongoose.set('strictQuery', true);
        const db = await mongoose.connect(dbUri, {
            maxPoolSize: batch_mongoose_poolsize
        });

        console.log(`Mongo DB: ${db.connection.host}`);
        console.log(`DB Name: ${db.connection.name}`);
        console.log(
            `Connection State: ${['disconnected', 'connected', 'connecting', 'disconnecting', 'uninitialized', 'unconnected', 'unknown'][db.connection.readyState]}\n`
        );

        const userProfileDocs = await UserProfile.find({ initialReg: { $exists: false } });

        if (!userProfileDocs?.length) {
            console.error('No unregistered user accounts found');

            await mongoose.connection.close();
            console.log('\nDatabase connection closed');
            process.exit(0);
        }

        for (let index = 0; index < userProfileDocs.length; index++) {
            const userProfileDoc = userProfileDocs[index];
            const { callSign, createdAt: startOfGracePeriod } = userProfileDoc;

            if (!callSign || !startOfGracePeriod) {
                continue;
            }

            console.log(`Processing ${callSign} (${index + 1}/${userProfileDocs.length})`);

            console.log(`\tCreate registration record for ${callSign}`);

            try {
                const { _id: regId } = await InitialReg.create({
                    callSign,
                    startOfGracePeriod
                });

                console.log(`\tRegistration record created for ${callSign} (${regId})`);
                console.log(`\tUpdate user profile with registration record`);
                userProfileDoc.initialReg = regId;
                await userProfileDoc.save();
                console.log(`\tUser profile updated with registration record for ${callSign} (${regId})`);
            } catch (error) {
                console.error(`Error creating registration record for ${callSign}`);
                console.error(error);
            }
        }

        await mongoose.connection.close();
        console.log('\nDatabase connection closed');
        process.exit(0);
    } catch (error) {
        console.error(error);
    }
})();
