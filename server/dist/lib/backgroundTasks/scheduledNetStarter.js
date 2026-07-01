/* hamlive-oss — MIT License. See LICENSE. */

/**
 * ScheduledNetStarter — Checks every 60s for nets with matching schedules.
 * When found, creates a LiveNet with countdown timer and sends email notifications.
 *
 * Runs via setInterval in server.js (not PluginBase, since the task loader is one-shot).
 */

const { logger } = require('../logger');
const { NetAnnounceStart } = require('../userNotification');

// Once a net auto-starts, don't start it again for the same occurrence — even if
// it's closed while the start window still matches. The match window is only a
// couple of minutes, so this guard just needs to outlast it (and is far shorter
// than the weekly gap to the next occurrence).
const RESTART_GUARD_MS = 10 * 60 * 1000;

/**
 * True if this schedule was auto-started so recently that re-firing now would be
 * the same occurrence (prevents a closed net from being immediately re-opened).
 */
function wasRecentlyAutoStarted(lastAutoStartedAt, now, guardMs = RESTART_GUARD_MS) {
    if (!lastAutoStartedAt) return false;
    const t = new Date(lastAutoStartedAt).getTime();
    if (Number.isNaN(t)) return false;
    return now.getTime() - t < guardMs;
}

/**
 * Check all NetProfiles for matching schedules and start any that are due.
 */
async function checkScheduledNets() {
    const mongoose = require('mongoose');
    const db = mongoose.connection;
    const { getNetProfile } = require('../../models/netProfile');
    const { getLiveNet } = require('../../models/liveNet');
    const { getStationInteraction } = require('../../models/stationInteraction');
    const { createChatChannel } = require('../localChat');
    const UserProfile = require('../../models/userProfile').getUserProfile(db);

    const NetProfile = getNetProfile(db);
    const LiveNet = getLiveNet(db);
    const StationInteraction = getStationInteraction(db);
    const now = new Date();

    try {
        const profiles = await NetProfile.find({
            'schedule.enabled': true,
            liveNet: { $exists: false }
        }).lean();

        let started = 0;
        for (const profile of profiles) {
            const sched = profile.schedule || {};
            if (!sched.enabled || sched.dayOfWeek === undefined || sched.hour === undefined || sched.minute === undefined) continue;

            // The net opens (and emails go out) notifyBeforeMinutes BEFORE its
            // scheduled start, then counts down to the start. Use the same
            // clamped value here and for the countdown in startScheduledNet.
            const notifyMin = Math.min(Math.max(sched.notifyBeforeMinutes || 30, 5), 120);
            if (!isTimeMatch(now, sched, notifyMin)) continue;

            // Don't re-open a net that already auto-started this occurrence (e.g.
            // the NCS closed it while the start window still matches).
            if (wasRecentlyAutoStarted(sched.lastAutoStartedAt, now)) {
                logger.debug(`ScheduledNetStarter: "${profile.title}" already auto-started this occurrence, skipping`);
                continue;
            }

            logger.info(`ScheduledNetStarter: time match for "${profile.title}"`);
            try {
                await startScheduledNet(profile, { NetProfile, LiveNet, StationInteraction, UserProfile, db, createChatChannel });
                started++;
            } catch (err) {
                logger.error(`ScheduledNetStarter: failed for "${profile.title}": ${err.message}`);
            }
        }

        if (started > 0) {
            logger.info(`ScheduledNetStarter: started ${started} scheduled net(s)`);
        }
    } catch (err) {
        logger.error(`ScheduledNetStarter: error: ${err.message}`);
    }
}

/**
 * Check whether NOW is the moment to open a scheduled net.
 *
 * The schedule's dayOfWeek/hour/minute is the net's OFFICIAL START. The net is
 * opened `notifyMin` minutes early (so followers get the email + a countdown to
 * the start), so the open moment is when (now + notifyMin) lands on the
 * scheduled start time — adding the offset also handles hour/day/week rollover
 * (e.g. a 00:15 start with 30-min notify opens at 23:45 the previous day).
 * notifyMin defaults to 0, which preserves the original "fire at start" behavior.
 */
function isTimeMatch(now, sched, notifyMin = 0) {
    const tz = sched.timezone || 'UTC';
    try {
        const effective = new Date(now.getTime() + (notifyMin || 0) * 60000);
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            weekday: 'long',
            hour: '2-digit', hour12: false,
            minute: '2-digit', hourCycle: 'h23'
        });
        const parts = formatter.formatToParts(effective);
        const weekday = parts.find(p => p.type === 'weekday')?.value || '';
        // ICU can render midnight as "24" under hourCycle h23; normalize 24 -> 0.
        const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10) % 24;
        const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');

        const weekdayMap = {
            'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
            'Thursday': 4, 'Friday': 5, 'Saturday': 6
        };
        const currentDow = weekdayMap[weekday] ?? -1;

        if (currentDow !== sched.dayOfWeek) return false;
        if (hour !== sched.hour) return false;
        const diff = minute - sched.minute;
        return diff >= 0 && diff <= 1;
    } catch (err) {
        // A bad stored timezone means this net can NEVER auto-start — make it
        // visible in prod logs, not debug-only.
        logger.warn(`ScheduledNetStarter: timezone error for ${tz}: ${err.message}`);
        return false;
    }
}

/**
 * Start a scheduled net: create LiveNet, set up chat, notify followers.
 */
async function startScheduledNet(profile, { NetProfile, LiveNet, StationInteraction, UserProfile, db, createChatChannel }) {
    // Re-check to avoid race conditions
    const fresh = await NetProfile.findById(profile._id);
    if (!fresh || fresh.liveNet) {
        logger.debug(`ScheduledNetStarter: "${profile.title}" already active, skipping`);
        return;
    }

    const ownerId = fresh.owners?.[0];
    if (!ownerId) {
        logger.warn(`ScheduledNetStarter: "${profile.title}" has no owners`);
        return;
    }

    const owner = await UserProfile.findById(ownerId).lean();
    if (!owner) {
        logger.warn(`ScheduledNetStarter: owner not found for "${profile.title}"`);
        return;
    }

    const notifyMin = Math.min(Math.max(fresh.schedule?.notifyBeforeMinutes || 30, 5), 120);

    const interaction = new StationInteraction({
        netProfile: fresh._id,
        callSign: owner.callSign || 'SCHEDULED',
        displayName: owner.displayName || 'Scheduled Net',
        location: owner.location || '',
        photo: owner.photo || '',
        email: owner.email || '',
        createdBy: 'scheduler',
        role: 'netcontrol',
        checkedState: true,
        checkedInAt: new Date(),
        userProfile: ownerId,
        sigReports: { rst: {} }
    });
    await interaction.save();

    const liveNet = new LiveNet({
        countdownTimer: notifyMin,
        netProfile: fresh._id,
        netControl: ownerId,
        url: `/views/livenet/${fresh._id}`,
        lookupTable: {
            [owner.callSign?.toUpperCase() || 'SCHEDULED']: {
                stationInteraction: interaction._id
            }
        }
    });
    const lnResult = await liveNet.save();

    interaction.liveNet = lnResult._id;
    await interaction.save();

    fresh.liveNet = lnResult._id;
    // Mark the occurrence as started so closing it won't trigger an immediate
    // re-open while the start window still matches (see wasRecentlyAutoStarted).
    if (fresh.schedule) {
        fresh.schedule.lastAutoStartedAt = new Date();
        fresh.markModified('schedule');
    }
    await fresh.save();

    logger.info(`ScheduledNetStarter: started "${fresh.title}"`);

    // Chat
    try {
        await createChatChannel({
            npid: fresh._id,
            netTitle: fresh.title,
            createdById: ownerId.toString()
        });
    } catch (e) {
        logger.warn(`ScheduledNetStarter: chat error for "${fresh.title}": ${e.message}`);
    }

    // Email followers
    if (fresh.followers?.length && fresh.schedule?.notifyBeforeEnabled !== false) {
        try {
            const email = await NetAnnounceStart.init({
                netControl: owner.callSign || 'Scheduled Net',
                netProfileDoc: fresh,
                liveNetDoc: lnResult
            });
            await email.sendMailToUPIDs({ upids: fresh.followers, db });
        } catch (e) {
            logger.warn(`ScheduledNetStarter: email error for "${fresh.title}": ${e.message}`);
        }
    }
}

module.exports = { checkScheduledNets, startScheduledNet, isTimeMatch, wasRecentlyAutoStarted };