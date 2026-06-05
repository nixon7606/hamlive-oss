#!/usr/bin/env node

const yargs = require('yargs');
const hideBin = require('yargs/helpers').hideBin;
const mongoose = require('mongoose');
const readline = require('readline');

const argv = yargs(hideBin(process.argv))
    .option('p', {
        alias: 'production',
        describe: 'connect to production db',
        type: 'boolean',
        default: false
    })
    .option('q', {
        alias: 'quiet',
        describe: 'inhibit email report',
        type: 'boolean',
        default: false
    })
    .help().argv;

process.env['NODE_ENV'] = argv.production ? 'production' : 'development';

const {
    conf: { dburi: dbUri, batch_mongoose_poolsize }
} = require('#@server/lib/configLib.js');
const { closeNet } = require('#@server/lib/sharedNetOps.js');
const { getLiveNet } = require('#@server/models/liveNet.js');
const { getNetProfile } = require('#@server/models/netProfile.js');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// DRY helper for closing DB and exiting
async function exitWithCleanup(code = 0, msg = null) {
    try {
        await mongoose.connection.close();
    } catch (e) {
        // ignore errors on close
    }
    if (msg) {
        if (code === 0) {
            console.log(msg);
        } else {
            console.error(msg);
        }
    }
    process.exit(code);
}

async function main() {
    try {
        // Connect to MongoDB
        mongoose.set('strictQuery', true);
        const db = await mongoose.connect(dbUri, {
            maxPoolSize: batch_mongoose_poolsize
        });

        console.log(`Mongo DB: ${db.connection.host}`);
        console.log(`DB Name: ${db.connection.name}`);
        console.log(
            `Connection State: ${
                ['disconnected', 'connected', 'connecting', 'disconnecting', 'uninitialized', 'unconnected', 'unknown'][
                    db.connection.readyState
                ]
            }\n`
        );

        const LiveNet = getLiveNet(mongoose.connection);
        const NetProfile = getNetProfile(mongoose.connection);

        // Fetch all live nets
        const liveNetDocs = await LiveNet.find({});
        if (!Array.isArray(liveNetDocs)) {
            throw new Error('Received non-array from LiveNet query');
        }
        if (liveNetDocs.length === 0) {
            await exitWithCleanup(0, `No liveNets found in ${process.env['NODE_ENV']} db`);
        }

        console.log('Records Retrieved:');

        // Gather running nets info
        const runningNets = await Promise.all(
            liveNetDocs.map(async liveNetDoc => {
                const { url, netProfile, lookupTable } = liveNetDoc;
                const netProfileDoc = await NetProfile.findById(netProfile._id);
                return {
                    netProfileDoc,
                    title: netProfileDoc.title,
                    url,
                    count: lookupTable.size
                };
            })
        );

        // Display nets table (omit netProfileDoc from display)
        console.table(runningNets.map(({ netProfileDoc, ...display }) => display));

        // Prompt user for which net to close
        rl.question('Which net would you like to close (index)? : ', async answer => {
            if (!answer.trim()) {
                await exitWithCleanup(1, 'No index provided.');
            }

            const index = Number(answer);

            if (Number.isNaN(index) || index < 0 || index >= runningNets.length) {
                await exitWithCleanup(1, 'Invalid index.');
            }

            const { netProfileDoc } = runningNets[index];
            console.log(`\nClosing ${netProfileDoc.id} ...\n`);

            await closeNet({
                netProfileDoc,
                liveNetDoc: liveNetDocs[index],
                quiet: argv.quiet,
                db: mongoose.connection
            });

            await exitWithCleanup(0, '\nDatabase connection closed');
        });
    } catch (error) {
        await exitWithCleanup(1, error);
    }
}

main();
