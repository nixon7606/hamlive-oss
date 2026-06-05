#!/usr/bin/env node

const yargs = require('yargs');
const hideBin = require('yargs/helpers').hideBin;
const mongoose = require('mongoose');
const readline = require('readline');

const argv = yargs(hideBin(process.argv))
    .command('$0 <callSign>', 'remove account', yargs => {
        yargs.positional('callSign', {
            describe: 'callSign to remove',
            type: 'string'
        });
    })
    .option('p', {
        alias: 'production',
        describe: 'remove from production db',
        type: 'boolean',
        default: false
    })
    .help().argv;

process.env['NODE_ENV'] = argv.production ? 'production' : 'development';
const {
    conf: { dburi: dbUri, batch_mongoose_poolsize }
} = require('#@server/lib/configLib.js');
const { wellFormedCall } = require('#@server/lib/serverUtils.js');
const { getUserProfile } = require('#@server/models/userProfile.js');
const { flagAccountForDeletion } = require('#@server/lib/sharedNetOps.js');

if (!wellFormedCall(argv.callSign)) {
    console.error(`Malformed callSign: ${argv.callSign}`);
    process.exit(1);
}

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

        const UserProfile = getUserProfile(mongoose.connection);
        const userProfileDoc = await UserProfile.findOne({ callSign: argv.callSign.toUpperCase() });

        if (!userProfileDoc) {
            console.error(`No user profile found for: ${argv.callSign}`);

            await mongoose.connection.close();
            console.log('\nDatabase connection closed');
            process.exit(0);
        } else {
            console.log('Record Retrieved:');
            console.table({
                callSign: userProfileDoc.callSign,
                displayName: userProfileDoc.displayName,
                lastLogin: userProfileDoc.lastLogin,
                newAccount: userProfileDoc.newAccount,
                lastAuthVia: userProfileDoc.lastAuthVia,
                policyConsent: userProfileDoc.policyConsent,
                flaggedForDeletion: userProfileDoc.flaggedForDeletion,
                email: userProfileDoc.email,
                locked: userProfileDoc.locked,
                myNetsCount: userProfileDoc.myNets.length,
                followCount: userProfileDoc.following.length
            });

            rl.question('Are you sure you want to flag this account for deletion? (yes/no) ', async answer => {
                if (answer.toLowerCase() === 'yes') {
                    await flagAccountForDeletion({ userProfileDoc, db: mongoose.connection });
                    console.log(`Account flagged for deletion: ${argv.callSign}`);
                } else {
                    console.log('Operation cancelled.');
                }

                await mongoose.connection.close();
                console.log('\nDatabase connection closed');
                process.exit(0);
            });
        }
    } catch (error) {
        console.error(error);
    }
})();
