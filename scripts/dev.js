/* hamlive-oss — MIT License. See LICENSE.
 *
 * Friendly development launcher. Run with:  bun run dev
 *
 * For non-technical operators this is the only command needed. It:
 *   1. creates .env from .env.example if you haven't already,
 *   2. makes sure a MongoDB is available — if nothing is running locally it
 *      starts a bundled one automatically (no Docker required); if you already
 *      have MongoDB (Docker, native, or a remote/Atlas URI) it uses that,
 *   3. starts the TypeScript watchers and the app, and
 *   4. shuts the bundled MongoDB down again when you stop with Ctrl+C.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');

// 1) Ensure .env exists.
const envPath = path.join(root, '.env');
if (!fs.existsSync(envPath)) {
    fs.copyFileSync(path.join(root, '.env.example'), envPath);
    console.log('Created .env from .env.example (local defaults).');
}
require('dotenv').config({ path: envPath });

const uriStr = process.env.MONGODB_URI || 'mongodb://localhost:27017/hamlive';

function parseHostPort(uri) {
    try {
        const u = new URL(uri);
        if (u.protocol === 'mongodb+srv:') return { host: u.hostname, port: null, srv: true };
        return { host: u.hostname || 'localhost', port: Number(u.port) || 27017, srv: false };
    } catch {
        return { host: 'localhost', port: 27017, srv: false };
    }
}

function isReachable(host, port, timeout = 1000) {
    return new Promise(resolve => {
        const sock = new net.Socket();
        const done = ok => {
            sock.destroy();
            resolve(ok);
        };
        sock.setTimeout(timeout);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
        sock.connect(port, host);
    });
}

let mongoHandle = null;

async function ensureMongo() {
    const { host, port, srv } = parseHostPort(uriStr);
    const isLocal = !srv && (host === 'localhost' || host === '127.0.0.1' || host === '::1');

    // A remote / Atlas database — not ours to manage.
    if (srv || !isLocal) {
        console.log(`Using configured MongoDB at ${host}${port ? ':' + port : ''}.`);
        return;
    }

    if (await isReachable(host, port)) {
        console.log(`Found MongoDB already running on ${host}:${port} — using it.`);
        return;
    }

    console.log(`No MongoDB found on ${host}:${port}. Starting a local one (no Docker needed)...`);
    console.log('(first run downloads a mongod binary — this can take a minute)');
    let MongoMemoryReplSet;
    try {
        ({ MongoMemoryReplSet } = require('mongodb-memory-server'));
    } catch {
        console.error('\nCould not start a local MongoDB: dev dependency "mongodb-memory-server" is missing.');
        console.error('Run `bun install`, or start MongoDB yourself (see INSTALL.md), then try again.\n');
        process.exit(1);
    }
    mongoHandle = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ port }] });
    console.log(`✅ Local MongoDB (single-node replica set) running on port ${port}.`);
}

function startApp() {
    const isWin = process.platform === 'win32';
    // bun is a native executable (bun.exe on Windows), not a .cmd shim, so it
    // can be spawned directly without a shell. The explicit ".exe" lets the
    // PATH search resolve it on Windows (spawn doesn't apply PATHEXT).
    const bunCmd = isWin ? 'bun.exe' : 'bun';
    // On POSIX, run the watcher pipeline in its own process group so we can tear
    // the whole tree down on exit (tsc watchers + nodemon + the app).
    const child = spawn(bunCmd, ['run', 'dev:watch'], {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
        detached: !isWin
    });

    const killChildTree = signal => {
        try {
            if (!isWin && child.pid) process.kill(-child.pid, signal);
            else child.kill(signal);
        } catch {}
    };

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        killChildTree('SIGINT');
        if (mongoHandle) {
            console.log('\nStopping local MongoDB...');
            try { await mongoHandle.stop(); } catch {}
        }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    child.on('exit', async code => {
        if (mongoHandle) { try { await mongoHandle.stop(); } catch {} }
        process.exit(code ?? 0);
    });
}

(async () => {
    await ensureMongo();
    startApp();
})().catch(err => {
    console.error('dev launcher error:', err);
    process.exit(1);
});
