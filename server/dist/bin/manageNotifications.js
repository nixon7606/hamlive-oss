#!/usr/bin/env node
/* hamlive-oss — MIT License. See LICENSE. */

const yargs = require('yargs');
const hideBin = require('yargs/helpers').hideBin;
const mongoose = require('mongoose');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const argv = yargs(hideBin(process.argv))
    .option('p', {
        alias: 'production',
        describe: 'connect to production db',
        type: 'boolean',
        default: false
    })
    .option('f', {
        alias: 'file',
        describe: 'load notification from JSON file (non-interactive)',
        type: 'string'
    })
    .option('y', {
        alias: 'yes',
        describe: 'skip confirmation prompts (use with --file)',
        type: 'boolean',
        default: false
    })
    .help().argv;

process.env['NODE_ENV'] = argv.production ? 'production' : 'development';

const {
    conf: { dburi: dbUriRaw, batch_mongoose_poolsize }
} = require('#@server/lib/configLib.js');
const { getSystemNotification } = require('#@server/models/systemNotification.js');
const { getUserProfile } = require('#@server/models/userProfile.js');

// URL-encode special characters in password if needed
const dbUri = dbUriRaw.replace(/(:)([^:@]+)([@])/g, (match, colon, password, at) => {
    const encoded = encodeURIComponent(password);
    return colon + encoded + at;
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function exitWithCleanup(code = 0, msg = null) {
    try {
        await mongoose.connection.close();
    } catch (e) {
        // ignore errors on close
    }
    rl.close();
    if (msg) {
        if (code === 0) {
            console.log(msg);
        } else {
            console.error(msg);
        }
    }
    process.exit(code);
}

// ============================================================================
// UI Helpers
// ============================================================================

const SEVERITY_ICONS = { info: 'i', warning: '!', critical: '!' };
const SEVERITY_COLORS = { info: '\x1b[36m', warning: '\x1b[33m', critical: '\x1b[31m' };
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function formatDate(date) {
    if (!date) return 'never';
    return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function truncate(str, len) {
    if (!str) return '';
    const clean = str.replace(/\n/g, ' ').replace(/<[^>]*>/g, '');
    return clean.length > len ? clean.substring(0, len - 3) + '...' : clean;
}

function progressBar(percent, width = 20) {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return `[${'='.repeat(filled)}${' '.repeat(empty)}] ${percent.toFixed(1)}%`;
}

// ============================================================================
// Statistics & Reporting
// ============================================================================

async function getNotificationStats(SystemNotification, UserProfile) {
    const notifications = await SystemNotification.find({}).sort({ createdAt: -1 }).lean();
    const totalUsers = await UserProfile.countDocuments({});

    // Get all dismissals in one query
    const usersWithDismissals = await UserProfile.find(
        { dismissedNotifications: { $exists: true, $ne: [] } },
        { dismissedNotifications: 1 }
    ).lean();

    // Build dismissal counts
    const dismissalCounts = {};
    usersWithDismissals.forEach(user => {
        user.dismissedNotifications?.forEach(d => {
            dismissalCounts[d.notificationId] = (dismissalCounts[d.notificationId] || 0) + 1;
        });
    });

    // Enrich notifications with stats
    return notifications.map(n => ({
        ...n,
        seenCount: dismissalCounts[n.notificationId] || 0,
        seenPercent: totalUsers > 0 ? ((dismissalCounts[n.notificationId] || 0) / totalUsers) * 100 : 0,
        totalUsers
    }));
}

// ============================================================================
// Display Functions
// ============================================================================

function displayHeader(dbName, isProduction) {
    console.clear();
    const envLabel = isProduction ? `${RED}PRODUCTION${RESET}` : `${GREEN}development${RESET}`;
    console.log(`${BOLD}Notifications${RESET} ${DIM}(${dbName})${RESET} [${envLabel}]\n`);
}

function displayNotificationList(notifications, showIndex = false) {
    if (notifications.length === 0) {
        console.log(`${DIM}No notifications found.${RESET}\n`);
        return;
    }

    notifications.forEach((n, idx) => {
        const status = n.active ? `${GREEN}ON${RESET}` : `${DIM}OFF${RESET}`;
        const severity = `${SEVERITY_COLORS[n.severity]}${n.severity}${RESET}`;
        const prefix = showIndex ? `${BOLD}${idx + 1}.${RESET} ` : '';
        const seen = n.seenPercent !== undefined ? ` ${DIM}${n.seenPercent.toFixed(0)}% seen${RESET}` : '';

        console.log(`${prefix}${BOLD}${n.title}${RESET} [${status}] [${severity}]${seen}`);
        console.log(`   ${DIM}${n.notificationId}${RESET}`);
        if (showIndex) {
            console.log(`   ${DIM}${truncate(n.message, 60)}${RESET}`);
        }
        console.log('');
    });
}

function displayDetailedStats(notifications) {
    if (notifications.length === 0) {
        console.log(`${DIM}No notifications to report on.${RESET}\n`);
        return;
    }

    const totalUsers = notifications[0]?.totalUsers || 0;
    const active = notifications.filter(n => n.active).length;

    console.log(`${BOLD}Overview${RESET}`);
    console.log(`  Total notifications: ${notifications.length} (${active} active)`);
    console.log(`  Total users: ${totalUsers}\n`);

    console.log(`${BOLD}Engagement by Notification${RESET}\n`);

    notifications.forEach(n => {
        const status = n.active ? `${GREEN}ACTIVE${RESET}` : `${DIM}inactive${RESET}`;
        console.log(`  ${BOLD}${n.title}${RESET} [${status}]`);
        console.log(`  ${DIM}${n.notificationId}${RESET}`);
        console.log(`  ${progressBar(n.seenPercent)}`);
        console.log(`  ${n.seenCount} of ${totalUsers} users have seen this`);
        console.log(`  Created: ${formatDate(n.createdAt)}\n`);
    });
}

// ============================================================================
// Quick Create Flow
// ============================================================================

async function quickCreate(SystemNotification) {
    console.log(`${BOLD}Quick Create Notification${RESET}\n`);

    // Step 1: ID (with smart default)
    const dateStr = new Date().toISOString().slice(0, 7); // YYYY-MM
    const defaultId = `announcement-${dateStr}`;
    const idInput = await question(`ID ${DIM}[${defaultId}]${RESET}: `);
    const notificationId = idInput.trim() || defaultId;

    // Check if exists
    const existing = await SystemNotification.findOne({ notificationId });
    if (existing) {
        const overwrite = await question(`${RED}Already exists.${RESET} Overwrite? ${DIM}(y/N)${RESET}: `);
        if (overwrite.toLowerCase() !== 'y') {
            console.log('Cancelled.\n');
            return null;
        }
        await SystemNotification.deleteOne({ notificationId });
    }

    // Step 2: Title
    const title = await question(`Title: `);
    if (!title.trim()) {
        console.log(`${RED}Title required.${RESET}\n`);
        return null;
    }

    // Step 3: Message (improved input)
    console.log(`\nMessage ${DIM}(HTML ok. Enter a blank line when done)${RESET}:`);
    const messageLines = [];
    let line;
    while ((line = await question('')) !== '') {
        messageLines.push(line);
    }
    const message = messageLines.join('\n');

    if (!message.trim()) {
        console.log(`${RED}Message required.${RESET}\n`);
        return null;
    }

    // Step 4: Severity (single key)
    const sevInput = await question(`Severity ${DIM}(i)nfo (w)arning (c)ritical [w]${RESET}: `);
    const severityMap = { i: 'info', w: 'warning', c: 'critical', '': 'warning' };
    const severity = severityMap[sevInput.toLowerCase()] || 'warning';

    // Preview
    console.log(`\n${BOLD}Preview${RESET}`);
    console.log(`  ID: ${notificationId}`);
    console.log(`  Title: ${title}`);
    console.log(`  Severity: ${severity}`);
    console.log(`  Message: ${truncate(message, 80)}\n`);

    const confirm = await question(`Create? ${DIM}(Y/n)${RESET}: `);
    if (confirm.toLowerCase() === 'n') {
        console.log('Cancelled.\n');
        return null;
    }

    const notification = new SystemNotification({
        notificationId,
        title,
        message,
        severity,
        active: true,
        expiresAt: null
    });

    await notification.save();
    console.log(`\n${GREEN}Created!${RESET} ${notificationId}\n`);
    return notification;
}

// ============================================================================
// Action Functions
// ============================================================================

async function actionToggle(SystemNotification, notifications) {
    if (notifications.length === 0) {
        console.log(`${DIM}No notifications to toggle.${RESET}\n`);
        return;
    }

    console.log(`${BOLD}Toggle Active State${RESET}\n`);
    displayNotificationList(notifications, true);

    const input = await question(`Select # ${DIM}(or Enter to cancel)${RESET}: `);
    const idx = parseInt(input) - 1;

    if (isNaN(idx) || idx < 0 || idx >= notifications.length) {
        return;
    }

    const n = notifications[idx];
    const newState = !n.active;

    await SystemNotification.updateOne({ _id: n._id }, { active: newState });
    console.log(`\n${newState ? GREEN + 'Activated' : RED + 'Deactivated'}${RESET}: ${n.notificationId}\n`);
}

async function actionDelete(SystemNotification, notifications) {
    if (notifications.length === 0) {
        console.log(`${DIM}No notifications to delete.${RESET}\n`);
        return;
    }

    console.log(`${BOLD}Delete Notification${RESET}\n`);
    displayNotificationList(notifications, true);

    const input = await question(`Select # to delete ${DIM}(or Enter to cancel)${RESET}: `);
    const idx = parseInt(input) - 1;

    if (isNaN(idx) || idx < 0 || idx >= notifications.length) {
        return;
    }

    const n = notifications[idx];
    const confirm = await question(`Delete "${n.title}"? ${DIM}(y/N)${RESET}: `);

    if (confirm.toLowerCase() !== 'y') {
        console.log('Cancelled.\n');
        return;
    }

    await SystemNotification.deleteOne({ _id: n._id });
    console.log(`\n${GREEN}Deleted.${RESET}\n`);
}

async function actionClearDismissals(UserProfile, notifications) {
    if (notifications.length === 0) {
        console.log(`${DIM}No notifications.${RESET}\n`);
        return;
    }

    console.log(`${BOLD}Reset Dismissals${RESET} ${DIM}(for testing)${RESET}\n`);
    displayNotificationList(notifications, true);
    console.log(`${BOLD}A.${RESET} Clear ALL dismissals\n`);

    const input = await question(`Select # or A ${DIM}(or Enter to cancel)${RESET}: `);

    let notificationId;
    if (input.toLowerCase() === 'a') {
        notificationId = 'all';
    } else {
        const idx = parseInt(input) - 1;
        if (isNaN(idx) || idx < 0 || idx >= notifications.length) {
            return;
        }
        notificationId = notifications[idx].notificationId;
    }

    let filter, update;
    if (notificationId === 'all') {
        filter = { dismissedNotifications: { $exists: true, $ne: [] } };
        update = { $set: { dismissedNotifications: [] } };
    } else {
        filter = { 'dismissedNotifications.notificationId': notificationId };
        update = { $pull: { dismissedNotifications: { notificationId } } };
    }

    const count = await UserProfile.countDocuments(filter);
    if (count === 0) {
        console.log(`\n${DIM}No dismissals to clear.${RESET}\n`);
        return;
    }

    const confirm = await question(`Reset for ${count} user(s)? ${DIM}(y/N)${RESET}: `);
    if (confirm.toLowerCase() !== 'y') {
        console.log('Cancelled.\n');
        return;
    }

    const result = await UserProfile.updateMany(filter, update);
    console.log(`\n${GREEN}Cleared ${result.modifiedCount} dismissal(s).${RESET}\n`);
}

async function actionLoadFile(SystemNotification) {
    console.log(`${BOLD}Load from JSON File${RESET}\n`);

    const filePath = await question(`File path: `);
    if (!filePath.trim()) {
        return;
    }

    const result = await loadFromFileCore(SystemNotification, filePath.trim(), false);
    if (!result) {
        console.log('');
    }
}

// ============================================================================
// File Loading (shared logic)
// ============================================================================

async function loadFromFileCore(SystemNotification, filePath, skipConfirm = false) {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
        console.log(`${RED}File not found:${RESET} ${resolvedPath}`);
        return false;
    }

    let data;
    try {
        const fileContent = fs.readFileSync(resolvedPath, 'utf8');
        data = JSON.parse(fileContent);
    } catch (err) {
        console.log(`${RED}Invalid JSON:${RESET} ${err.message}`);
        return false;
    }

    const { notificationId, title, message, severity = 'warning', active = true, supersedes = [] } = data;

    // Validation
    if (!notificationId || typeof notificationId !== 'string') {
        console.log(`${RED}Missing "notificationId"${RESET}`);
        return false;
    }
    if (!title || typeof title !== 'string') {
        console.log(`${RED}Missing "title"${RESET}`);
        return false;
    }
    if (!message || typeof message !== 'string') {
        console.log(`${RED}Missing "message"${RESET}`);
        return false;
    }
    if (!['info', 'warning', 'critical'].includes(severity)) {
        console.log(`${RED}Invalid severity${RESET} (must be info/warning/critical)`);
        return false;
    }

    // Preview
    console.log(`\n${BOLD}${title}${RESET}`);
    console.log(`  ID: ${notificationId}`);
    console.log(`  Severity: ${severity}`);
    console.log(`  Active: ${active}`);
    if (supersedes.length > 0) {
        console.log(`  Supersedes: ${supersedes.join(', ')}`);
    }
    console.log(`  Message: ${truncate(message, 60)}\n`);

    // Check supersedes
    if (supersedes.length > 0) {
        const toDelete = await SystemNotification.find({ notificationId: { $in: supersedes } });
        if (toDelete.length > 0) {
            console.log(`${DIM}Will delete ${toDelete.length} superseded notification(s)${RESET}`);
        }
    }

    // Check existing
    const existing = await SystemNotification.findOne({ notificationId });
    if (existing) {
        console.log(`${DIM}Will overwrite existing notification${RESET}`);
    }

    if (!skipConfirm) {
        const confirm = await question(`Proceed? ${DIM}(Y/n)${RESET}: `);
        if (confirm.toLowerCase() === 'n') {
            console.log('Cancelled.');
            return false;
        }
    }

    // Delete superseded
    if (supersedes.length > 0) {
        await SystemNotification.deleteMany({ notificationId: { $in: supersedes } });
    }

    // Delete existing
    if (existing) {
        await SystemNotification.deleteOne({ notificationId });
    }

    // Create
    const notification = new SystemNotification({
        notificationId,
        title,
        message,
        severity,
        active,
        expiresAt: data.expiresAt || null
    });

    await notification.save();
    console.log(`\n${GREEN}Created!${RESET} ${notificationId}\n`);
    return true;
}

// ============================================================================
// Main Menu
// ============================================================================

async function mainMenu(SystemNotification, UserProfile, dbName, isProduction) {
    while (true) {
        displayHeader(dbName, isProduction);

        // Get notifications with stats
        const notifications = await getNotificationStats(SystemNotification, UserProfile);

        // Show current notifications
        displayNotificationList(notifications);

        // Menu
        console.log(`${BOLD}Actions${RESET}`);
        console.log(`  ${CYAN}n${RESET} New notification    ${CYAN}t${RESET} Toggle on/off    ${CYAN}d${RESET} Delete`);
        console.log(
            `  ${CYAN}s${RESET} Stats & reporting   ${CYAN}r${RESET} Reset dismissals  ${CYAN}f${RESET} Load from file`
        );
        console.log(`  ${CYAN}q${RESET} Quit\n`);

        const choice = await question(`> `);

        switch (choice.toLowerCase()) {
            case 'n':
                await quickCreate(SystemNotification);
                await question(`${DIM}Press Enter...${RESET}`);
                break;

            case 't':
                await actionToggle(SystemNotification, notifications);
                await question(`${DIM}Press Enter...${RESET}`);
                break;

            case 'd':
                await actionDelete(SystemNotification, notifications);
                await question(`${DIM}Press Enter...${RESET}`);
                break;

            case 's':
                console.clear();
                console.log(`${BOLD}Notification Statistics${RESET}\n`);
                displayDetailedStats(notifications);
                await question(`${DIM}Press Enter...${RESET}`);
                break;

            case 'r':
                await actionClearDismissals(UserProfile, notifications);
                await question(`${DIM}Press Enter...${RESET}`);
                break;

            case 'f':
                await actionLoadFile(SystemNotification);
                await question(`${DIM}Press Enter...${RESET}`);
                break;

            case 'q':
            case '':
                await exitWithCleanup(0, `\n${DIM}Bye!${RESET}\n`);
                return;

            default:
                // Invalid input, just refresh
                break;
        }
    }
}

// ============================================================================
// Entry Point
// ============================================================================

async function main() {
    try {
        mongoose.set('strictQuery', true);
        const db = await mongoose.connect(dbUri, {
            maxPoolSize: batch_mongoose_poolsize
        });

        const SystemNotification = getSystemNotification(mongoose.connection);
        const UserProfile = getUserProfile(mongoose.connection);

        // Non-interactive mode: --file option
        if (argv.file) {
            const envLabel = argv.production ? 'PRODUCTION' : 'development';
            console.log(`\n${DIM}Database: ${db.connection.name} [${envLabel}]${RESET}`);

            const success = await loadFromFileCore(SystemNotification, argv.file, argv.yes);
            await exitWithCleanup(success ? 0 : 1);
            return;
        }

        // Interactive mode
        await mainMenu(SystemNotification, UserProfile, db.connection.name, argv.production);
    } catch (error) {
        await exitWithCleanup(1, `\n${RED}Error:${RESET} ${error.message}\n${error.stack}`);
    }
}

main();
