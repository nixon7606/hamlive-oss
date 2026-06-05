#!/usr/bin/env node

/*
 * dbBackup.js — backup, restore, migrate, verify hamlive MongoDB databases.
 *
 * Subcommands:
 *   backup   Dump a database to a local gzipped archive (optionally upload to S3).
 *   restore  Restore a gzipped archive into a database.
 *   migrate  Move data from one MongoDB URI to another (dump→restore or piped).
 *   verify   Compare doc counts and indexes between two URIs.
 *   list     List local + S3 archives.
 *   prune    Delete local archives older than N days.
 *
 * Reads from prod is safe (mongodump runs with readPreference=secondary by
 * default). Writes that target a production URI require an explicit
 * --confirm-production flag matching the target dbname.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const yargs = require('yargs');
const hideBin = require('yargs/helpers').hideBin;
const YAML = require('yaml');
const mongoose = require('mongoose');

const PROFILES_PATH = path.join(os.homedir(), '.hamlive-backup.yaml');
const DEFAULT_BACKUP_DIR = process.env.HAMLIVE_BACKUP_DIR || path.resolve(process.cwd(), 'backups');

// ---------- helpers ---------------------------------------------------------

function loadProfiles() {
    if (!fs.existsSync(PROFILES_PATH)) return {};
    try {
        return YAML.parse(fs.readFileSync(PROFILES_PATH, 'utf8')) || {};
    } catch (err) {
        console.error(`Failed to parse ${PROFILES_PATH}: ${err.message}`);
        process.exit(2);
    }
}

function loadEnvConf(env) {
    process.env['NODE_ENV'] = env;
    delete require.cache[require.resolve('#@server/lib/configLib.js')];
    return require('#@server/lib/configLib.js').conf;
}

/** Resolve a URI from CLI options. Order: explicit --uri, --profile, --env. */
function resolveUri(opts, role /* 'source' | 'target' | 'uri' */) {
    const uriKey = role === 'uri' ? 'uri' : `${role}-uri`;
    const profileKey = role === 'uri' ? 'profile' : `${role}-profile`;
    const envKey = role === 'uri' ? 'env' : `${role}-env`;

    if (opts[uriKey]) return { uri: opts[uriKey], origin: `--${uriKey}` };

    if (opts[profileKey]) {
        const profiles = loadProfiles();
        const p = profiles[opts[profileKey]];
        if (!p?.uri) {
            console.error(`Profile "${opts[profileKey]}" not found in ${PROFILES_PATH}`);
            process.exit(2);
        }
        return { uri: p.uri, dbname: p.dbname, origin: `profile:${opts[profileKey]}` };
    }

    const env = opts[envKey] || (opts.production ? 'production' : 'development');
    const conf = loadEnvConf(env);
    if (!conf?.dburi) {
        console.error(`No dburi in config for NODE_ENV=${env}`);
        process.exit(2);
    }
    return { uri: conf.dburi, dbname: conf.dbname, origin: `config:${env}` };
}

function dbnameFromUri(uri) {
    // Mongo URIs may have comma-separated hosts (replica sets), which break
    // the URL parser. Extract the path between the host(s) and the query
    // string with a regex instead.
    const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@]*@)?[^/?]+\/([^?]+)/);
    return m && m[1] ? m[1] : null;
}

function stripDbnameFromUri(uri) {
    // When using --nsFrom/--nsTo, mongorestore interprets a dbname in the URI
    // path as an implicit --db filter, which conflicts with the namespace
    // remap. Strip it.
    return uri.replace(/^(mongodb(?:\+srv)?:\/\/(?:[^@]*@)?[^/?]+)\/[^?]+(\?|$)/, '$1/$2');
}

function looksLikeProduction(uri, dbname) {
    const name = dbname || dbnameFromUri(uri) || '';
    return /prod/i.test(name);
}

function hostsFromUri(uri) {
    const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@]*@)?([^/?]+)/);
    if (!m) return [];
    return m[1].split(',').map((h) => h.split(':')[0].toLowerCase()).sort();
}

function sameCluster(a, b) {
    const ha = hostsFromUri(a), hb = hostsFromUri(b);
    if (!ha.length || !hb.length) return false;
    return ha.join('|') === hb.join('|');
}

function withReadPref(uri, pref = 'secondary') {
    if (/[?&]readPreference=/i.test(uri)) return uri;
    return uri + (uri.includes('?') ? '&' : '?') + `readPreference=${pref}`;
}

function timestamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function humanSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function which(bin) {
    const r = spawnSync('which', [bin], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
}

function requireTools(tools) {
    const missing = tools.filter((t) => !which(t));
    if (missing.length) {
        console.error(`Missing required tool(s): ${missing.join(', ')}`);
        console.error('Install via the MongoDB Database Tools: https://www.mongodb.com/try/download/database-tools');
        process.exit(2);
    }
}

function runStreaming(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
}

function runPiped(srcCmd, srcArgs, dstCmd, dstArgs) {
    return new Promise((resolve, reject) => {
        const src = spawn(srcCmd, srcArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
        const dst = spawn(dstCmd, dstArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
        src.stdout.pipe(dst.stdin);

        let srcCode = null, dstCode = null;
        const finish = () => {
            if (srcCode === null || dstCode === null) return;
            if (srcCode === 0 && dstCode === 0) resolve();
            else reject(new Error(`pipe failed (src=${srcCode}, dst=${dstCode})`));
        };
        src.on('error', reject);
        dst.on('error', reject);
        src.on('exit', (c) => { srcCode = c; finish(); });
        dst.on('exit', (c) => { dstCode = c; finish(); });
    });
}

async function confirmProductionWrite(targetUri, targetDbname, opts) {
    if (!looksLikeProduction(targetUri, targetDbname)) return;
    const expected = targetDbname || dbnameFromUri(targetUri) || '';
    if (opts['confirm-production'] === expected) return;
    console.error(
        `Refusing to write to a production target (${expected || targetUri}).`
    );
    console.error(
        `Pass --confirm-production "${expected}" to acknowledge.`
    );
    process.exit(3);
}

async function promptYesNo(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`${question} [y/N] `, (ans) => {
            rl.close();
            resolve(/^y(es)?$/i.test(ans.trim()));
        });
    });
}

// ---------- subcommand: backup ---------------------------------------------

async function cmdBackup(opts) {
    requireTools(['mongodump']);
    const { uri, dbname, origin } = resolveUri(opts, 'uri');
    const name = dbname || dbnameFromUri(uri) || 'unknown';
    const ts = timestamp();
    const dir = opts.dir || DEFAULT_BACKUP_DIR;
    ensureDir(dir);
    const file = path.join(dir, `${name}-${ts}.archive.gz`);

    console.log(`Source     : ${origin} (db=${name})`);
    console.log(`Destination: ${file}`);

    const dumpUri = opts['no-secondary'] ? uri : withReadPref(uri, 'secondary');
    const args = [`--uri=${dumpUri}`, `--archive=${file}`, '--gzip'];
    // --oplog requires a full-instance dump; if the URI scopes to a single DB
    // (which is our hosted-provider setup), it's incompatible with --oplog.
    const useOplog = !opts['no-oplog'] && !dbnameFromUri(uri);
    if (useOplog) args.push('--oplog');
    if (opts.collection) {
        for (const c of [].concat(opts.collection)) args.push('--collection', c);
    }
    await runStreaming('mongodump', args);

    const stat = fs.statSync(file);
    console.log(`Wrote ${humanSize(stat.size)} to ${file}`);

    if (opts['s3-bucket']) {
        requireTools(['aws']);
        const s3key = `${opts['s3-prefix'] || 'hamlive'}/${path.basename(file)}`;
        const s3uri = `s3://${opts['s3-bucket']}/${s3key}`;
        console.log(`Uploading to ${s3uri}`);
        await runStreaming('aws', ['s3', 'cp', file, s3uri, '--sse', 'AES256']);
    }
    console.log('backup: done');
}

// ---------- subcommand: restore --------------------------------------------

async function cmdRestore(opts) {
    requireTools(['mongorestore']);
    if (!opts.archive) {
        console.error('--archive <path> is required');
        process.exit(2);
    }
    if (!fs.existsSync(opts.archive)) {
        console.error(`Archive not found: ${opts.archive}`);
        process.exit(2);
    }
    const { uri, dbname, origin } = resolveUri(opts, 'uri');
    const name = dbname || dbnameFromUri(uri) || 'unknown';

    console.log(`Archive : ${opts.archive}`);
    console.log(`Target  : ${origin} (db=${name})`);

    await confirmProductionWrite(uri, name, opts);

    if (!opts.yes) {
        const ok = await promptYesNo(`Restore into ${name}? Existing data may be replaced.`);
        if (!ok) { console.log('aborted'); process.exit(1); }
    }

    const remapArgs = [];
    let willRemap = false;
    if (opts['ns-from'] && opts['ns-to']) {
        remapArgs.push(`--nsFrom=${opts['ns-from']}`, `--nsTo=${opts['ns-to']}`);
        willRemap = true;
    } else if (opts['archive-dbname'] && opts['archive-dbname'] !== name) {
        const from = `${opts['archive-dbname']}.*`;
        const to = `${name}.*`;
        console.log(`Namespace remap: ${from} → ${to}`);
        remapArgs.push(`--nsFrom=${from}`, `--nsTo=${to}`);
        willRemap = true;
    }

    // When remapping, strip the dbname from the URI: mongorestore otherwise
    // treats it as an implicit --db filter that conflicts with --nsFrom/--nsTo.
    const restoreUri = willRemap ? stripDbnameFromUri(uri) : uri;
    const args = [`--uri=${restoreUri}`, `--archive=${opts.archive}`, '--gzip', ...remapArgs];
    if (opts.drop) args.push('--drop');

    // mongorestore --oplogReplay is incompatible with namespace remapping and
    // also requires the archive to contain an oplog (only true for full-instance
    // dumps). Auto-disable when remapping; respect explicit --no-oplog-replay.
    const useOplogReplay = !opts['no-oplog-replay'] && !willRemap;
    if (useOplogReplay) args.push('--oplogReplay');
    else if (willRemap && !opts['no-oplog-replay']) {
        console.log('Skipping --oplogReplay because namespaces differ.');
    }

    await runStreaming('mongorestore', args);
    console.log('restore: done');
}

// ---------- subcommand: migrate --------------------------------------------

async function cmdMigrate(opts) {
    requireTools(['mongodump', 'mongorestore']);
    const src = resolveUri(opts, 'source');
    const tgt = resolveUri(opts, 'target');
    const srcName = src.dbname || dbnameFromUri(src.uri) || 'unknown';
    const tgtName = tgt.dbname || dbnameFromUri(tgt.uri) || 'unknown';

    console.log(`Source : ${src.origin} (db=${srcName})`);
    console.log(`Target : ${tgt.origin} (db=${tgtName})`);
    console.log(`Mode   : ${opts.mode}`);
    if (sameCluster(src.uri, tgt.uri)) {
        console.log('Note   : source and target appear to be on the same cluster (same hosts).');
    }

    await confirmProductionWrite(tgt.uri, tgtName, opts);

    if (!opts['allow-non-empty']) {
        const counts = await collectionCounts(tgt.uri);
        const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0);
        if (nonEmpty.length) {
            console.error(`Target ${tgtName} is not empty: ${nonEmpty.map(([k, v]) => `${k}=${v}`).join(', ')}`);
            console.error('Pass --allow-non-empty to proceed (existing docs will be merged/overwritten by mongorestore).');
            process.exit(3);
        }
    }

    if (!opts.yes) {
        const ok = await promptYesNo(`Migrate ${srcName} → ${tgtName}?`);
        if (!ok) { console.log('aborted'); process.exit(1); }
    }

    const dumpUri = opts['no-secondary'] ? src.uri : withReadPref(src.uri, 'secondary');
    const remap = srcName !== tgtName ? [`--nsFrom=${srcName}.*`, `--nsTo=${tgtName}.*`] : [];
    if (remap.length) console.log(`Namespace remap: ${srcName}.* → ${tgtName}.*`);
    // mongodump --oplog requires a full-instance dump; URIs that scope to a
    // single DB are incompatible. mongorestore --oplogReplay also can't be
    // combined with namespace remapping. So oplog is opt-in *and* only valid
    // when the URI is unscoped *and* names match.
    const srcHasDbname = !!dbnameFromUri(src.uri);
    const useOplog = !opts['no-oplog'] && !srcHasDbname && remap.length === 0;
    if (!useOplog && !opts['no-oplog']) {
        const reasons = [];
        if (srcHasDbname) reasons.push('source URI scopes to a single DB');
        if (remap.length) reasons.push('namespaces differ');
        console.log(`Skipping --oplog (${reasons.join('; ')}).`);
    }

    // When remapping, strip the dbname from the target URI so mongorestore
    // doesn't treat it as an implicit --db filter (incompatible with --nsFrom).
    const restoreUri = remap.length ? stripDbnameFromUri(tgt.uri) : tgt.uri;

    if (opts.mode === 'pipe') {
        const dumpArgs = [`--uri=${dumpUri}`, '--archive', '--gzip'];
        if (useOplog) dumpArgs.push('--oplog');
        const restoreArgs = [`--uri=${restoreUri}`, '--archive', '--gzip', ...remap];
        if (opts.drop) restoreArgs.push('--drop');
        if (useOplog && !opts['no-oplog-replay']) restoreArgs.push('--oplogReplay');
        await runPiped('mongodump', dumpArgs, 'mongorestore', restoreArgs);
    } else {
        const dir = opts.dir || DEFAULT_BACKUP_DIR;
        ensureDir(dir);
        const file = path.join(dir, `${srcName}-migrate-${timestamp()}.archive.gz`);
        const dumpArgs = [`--uri=${dumpUri}`, `--archive=${file}`, '--gzip'];
        if (useOplog) dumpArgs.push('--oplog');
        await runStreaming('mongodump', dumpArgs);
        console.log(`Dump  : ${file} (${humanSize(fs.statSync(file).size)})`);
        const restoreArgs = [`--uri=${restoreUri}`, `--archive=${file}`, '--gzip', ...remap];
        if (opts.drop) restoreArgs.push('--drop');
        if (useOplog && !opts['no-oplog-replay']) restoreArgs.push('--oplogReplay');
        await runStreaming('mongorestore', restoreArgs);
    }

    if (opts.verify) {
        console.log('--- verifying ---');
        await verifyParity(src.uri, tgt.uri);
    }
    console.log('migrate: done');
}

// ---------- subcommand: verify ---------------------------------------------

async function collectionCounts(uri) {
    mongoose.set('strictQuery', true);
    const conn = await mongoose.createConnection(uri, { maxPoolSize: 2 }).asPromise();
    try {
        const collections = await conn.db.listCollections().toArray();
        const counts = {};
        for (const c of collections) {
            if (c.type !== 'collection') continue;
            counts[c.name] = await conn.db.collection(c.name).countDocuments({});
        }
        return counts;
    } finally {
        await conn.close();
    }
}

async function collectionIndexes(uri) {
    const conn = await mongoose.createConnection(uri, { maxPoolSize: 2 }).asPromise();
    try {
        const collections = await conn.db.listCollections().toArray();
        const result = {};
        for (const c of collections) {
            if (c.type !== 'collection') continue;
            const idx = await conn.db.collection(c.name).indexes();
            result[c.name] = idx.map((i) => i.name).sort();
        }
        return result;
    } finally {
        await conn.close();
    }
}

async function verifyParity(srcUri, tgtUri) {
    const [srcCounts, tgtCounts, srcIdx, tgtIdx] = await Promise.all([
        collectionCounts(withReadPref(srcUri, 'secondary')),
        collectionCounts(tgtUri),
        collectionIndexes(withReadPref(srcUri, 'secondary')),
        collectionIndexes(tgtUri)
    ]);
    const names = Array.from(new Set([...Object.keys(srcCounts), ...Object.keys(tgtCounts)])).sort();
    let mismatch = 0;
    console.log('collection                     source     target   diff   indexes');
    for (const n of names) {
        const s = srcCounts[n] ?? 0;
        const t = tgtCounts[n] ?? 0;
        const sIdx = (srcIdx[n] || []).join(',');
        const tIdx = (tgtIdx[n] || []).join(',');
        const idxOk = sIdx === tIdx ? 'ok' : 'DIFF';
        const diff = t - s;
        if (s !== t || sIdx !== tIdx) mismatch++;
        console.log(
            `${n.padEnd(30)} ${String(s).padStart(8)} ${String(t).padStart(10)} ${String(diff).padStart(6)}   ${idxOk}`
        );
    }
    if (mismatch) {
        console.error(`\n${mismatch} collection(s) differ between source and target.`);
        process.exitCode = 4;
    } else {
        console.log('\nparity: OK');
    }
}

async function cmdVerify(opts) {
    const src = resolveUri(opts, 'source');
    const tgt = resolveUri(opts, 'target');
    console.log(`Source : ${src.origin}`);
    console.log(`Target : ${tgt.origin}`);
    await verifyParity(src.uri, tgt.uri);
}

// ---------- subcommand: list -----------------------------------------------

async function cmdList(opts) {
    const dir = opts.dir || DEFAULT_BACKUP_DIR;
    if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir)
            .filter((f) => f.endsWith('.archive.gz'))
            .map((f) => {
                const s = fs.statSync(path.join(dir, f));
                return { name: f, size: s.size, mtime: s.mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);
        console.log(`Local (${dir}):`);
        if (!files.length) console.log('  (none)');
        for (const f of files) {
            console.log(`  ${f.mtime.toISOString()}  ${humanSize(f.size).padStart(12)}  ${f.name}`);
        }
    } else {
        console.log(`Local (${dir}): directory does not exist`);
    }

    if (opts['s3-bucket']) {
        requireTools(['aws']);
        const prefix = opts['s3-prefix'] || 'hamlive';
        console.log(`\nS3 (s3://${opts['s3-bucket']}/${prefix}/):`);
        await runStreaming('aws', ['s3', 'ls', `s3://${opts['s3-bucket']}/${prefix}/`, '--human-readable']);
    }
}

// ---------- subcommand: prune ----------------------------------------------

async function cmdPrune(opts) {
    const dir = opts.dir || DEFAULT_BACKUP_DIR;
    const keepDays = Number(opts['keep-days']);
    if (!Number.isFinite(keepDays) || keepDays < 1) {
        console.error('--keep-days must be a positive integer');
        process.exit(2);
    }
    if (!fs.existsSync(dir)) {
        console.log(`No backup dir at ${dir}; nothing to prune.`);
        return;
    }
    const cutoff = Date.now() - keepDays * 86400 * 1000;
    const victims = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.archive.gz'))
        .map((f) => ({ name: f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtime }))
        .filter((f) => f.mtime.getTime() < cutoff);

    if (!victims.length) { console.log('Nothing to prune.'); return; }
    console.log(`Will delete ${victims.length} file(s) older than ${keepDays}d:`);
    for (const v of victims) console.log(`  ${v.mtime.toISOString()}  ${v.name}`);
    if (opts['dry-run']) { console.log('(dry-run; nothing deleted)'); return; }
    if (!opts.yes) {
        const ok = await promptYesNo('Proceed?');
        if (!ok) { console.log('aborted'); return; }
    }
    for (const v of victims) fs.unlinkSync(v.full);
    console.log(`Deleted ${victims.length} file(s).`);
}

// ---------- CLI -------------------------------------------------------------

const commonConnectionOpts = {
    'production': { type: 'boolean', default: false, describe: 'use production config (NODE_ENV=production)' },
    'env': { type: 'string', describe: 'NODE_ENV to load config for (overrides --production)' },
    'profile': { type: 'string', describe: `named profile from ${PROFILES_PATH}` },
    'uri': { type: 'string', describe: 'raw mongodb URI (overrides --profile/--env)' },
    'dir': { type: 'string', describe: `local backup dir (default: ${DEFAULT_BACKUP_DIR})` }
};

const sourceTargetOpts = {
    'source-env': { type: 'string' },
    'source-profile': { type: 'string' },
    'source-uri': { type: 'string' },
    'target-env': { type: 'string' },
    'target-profile': { type: 'string' },
    'target-uri': { type: 'string' }
};

yargs(hideBin(process.argv))
    .scriptName('dbBackup')
    .usage('$0 <command> [options]')
    .command(
        'backup',
        'dump a database to a gzipped archive',
        (y) => y.options({
            ...commonConnectionOpts,
            'collection': { type: 'array', describe: 'limit dump to specific collection(s)' },
            'no-oplog': { type: 'boolean', default: false, describe: 'skip --oplog (use for non-replica-set)' },
            'no-secondary': { type: 'boolean', default: false, describe: 'do not force readPreference=secondary' },
            's3-bucket': { type: 'string' },
            's3-prefix': { type: 'string', default: 'hamlive' }
        }),
        (a) => run(cmdBackup, a)
    )
    .command(
        'restore',
        'restore a gzipped archive into a database',
        (y) => y.options({
            ...commonConnectionOpts,
            'archive': { type: 'string', demandOption: true, describe: 'path to .archive.gz' },
            'archive-dbname': { type: 'string', describe: 'dbname inside the archive (auto-remaps to target if different); e.g. hamlive-prod' },
            'drop': { type: 'boolean', default: false, describe: 'drop collections before restore' },
            'no-oplog-replay': { type: 'boolean', default: false },
            'ns-from': { type: 'string', describe: 'remap namespace from (e.g. hamlive-prod.*); overrides --archive-dbname' },
            'ns-to': { type: 'string', describe: 'remap namespace to (e.g. hamlive-staging.*)' },
            'confirm-production': { type: 'string', describe: 'required dbname when target is prod' },
            'yes': { type: 'boolean', default: false, alias: 'y' }
        }),
        (a) => run(cmdRestore, a)
    )
    .command(
        'migrate',
        'copy data from one URI to another (dump→restore)',
        (y) => y.options({
            ...sourceTargetOpts,
            'dir': commonConnectionOpts.dir,
            'mode': { choices: ['dump-restore', 'pipe'], default: 'dump-restore' },
            'drop': { type: 'boolean', default: false },
            'allow-non-empty': { type: 'boolean', default: false, describe: 'allow target with existing data' },
            'no-oplog': { type: 'boolean', default: false },
            'no-oplog-replay': { type: 'boolean', default: false },
            'no-secondary': { type: 'boolean', default: false },
            'verify': { type: 'boolean', default: true, describe: 'run parity check after restore' },
            'confirm-production': { type: 'string' },
            'yes': { type: 'boolean', default: false, alias: 'y' }
        }),
        (a) => run(cmdMigrate, a)
    )
    .command(
        'verify',
        'compare doc counts and indexes between two URIs',
        (y) => y.options(sourceTargetOpts),
        (a) => run(cmdVerify, a)
    )
    .command(
        'list',
        'list local + S3 backups',
        (y) => y.options({
            'dir': commonConnectionOpts.dir,
            's3-bucket': { type: 'string' },
            's3-prefix': { type: 'string', default: 'hamlive' }
        }),
        (a) => run(cmdList, a)
    )
    .command(
        'prune',
        'delete local backups older than N days',
        (y) => y.options({
            'dir': commonConnectionOpts.dir,
            'keep-days': { type: 'number', default: 30 },
            'dry-run': { type: 'boolean', default: false },
            'yes': { type: 'boolean', default: false, alias: 'y' }
        }),
        (a) => run(cmdPrune, a)
    )
    .demandCommand(1)
    .strict()
    .help()
    .parse();

function run(fn, argv) {
    Promise.resolve(fn(argv))
        .then(() => process.exit(process.exitCode || 0))
        .catch((err) => {
            console.error(err.stack || err.message || err);
            process.exit(1);
        });
}
