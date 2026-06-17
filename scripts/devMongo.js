/* hamlive-oss — MIT License. See LICENSE.
 *
 * Run a local MongoDB for development WITHOUT Docker.
 *
 * Starts a single-node replica set (required for Ham.Live's real-time change
 * streams) on localhost:27017, matching the default MONGODB_URI in .env.example.
 * A `mongod` binary is downloaded automatically on first run.
 *
 * Usage (keep this running in its own terminal):
 *   bun run mongo:dev
 * Then, in a second terminal:
 *   bun run dev
 *
 * Data lives for as long as this process runs; stop it with Ctrl+C.
 * For a persistent / production database, use Docker or a managed MongoDB and
 * set MONGODB_URI accordingly — you do NOT need this script in production.
 */
let MongoMemoryReplSet;
try {
    ({ MongoMemoryReplSet } = require('mongodb-memory-server'));
} catch {
    console.error('mongodb-memory-server is not installed. Run `bun install` first.');
    process.exit(1);
}

const PORT = Number(process.env.PORT_MONGO || 27017);

(async () => {
    console.log(`Starting local MongoDB (single-node replica set) on port ${PORT}...`);
    console.log('(first run downloads a mongod binary — this can take a minute)');

    const rs = await MongoMemoryReplSet.create({
        replSet: { count: 1 },
        instanceOpts: [{ port: PORT }]
    });

    console.log('\n✅ MongoDB is running.');
    console.log(`   URI: mongodb://localhost:${PORT}/hamlive?directConnection=true`);
    console.log('   This matches the default MONGODB_URI in .env.');
    console.log('\nLeave this terminal open. In another terminal run:  bun run dev');
    console.log('Press Ctrl+C here to stop MongoDB.\n');

    const shutdown = async () => {
        console.log('\nStopping MongoDB...');
        await rs.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
})().catch(err => {
    console.error('Failed to start local MongoDB:', err);
    process.exit(1);
});
