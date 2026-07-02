/* hamlive-oss — MIT License. See LICENSE. */
// Pure helpers for the admin view: schedule-occurrence math (timezone-correct,
// no date library) and recent-sends bucketing. Kept DOM-free so they are unit
// testable in the node test project.

'use strict';

export interface NetSchedule {
    dayOfWeek?: number; hour?: number; minute?: number;
    timezone?: string; notifyBeforeMinutes?: number; enabled?: boolean;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_NUM: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

// Wall-clock parts of an instant in a target timezone.
function wallClock(ts: Date, tz: string): { y: number; m: number; d: number; hh: number; mm: number; dow: number } {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(ts)) parts[p.type] = p.value;
    return {
        y: parseInt(parts['year']!, 10), m: parseInt(parts['month']!, 10),
        d: parseInt(parts['day']!, 10), hh: parseInt(parts['hour']!, 10) % 24,
        mm: parseInt(parts['minute']!, 10), dow: WEEKDAY_NUM[parts['weekday']!] ?? -1,
    };
}

// UTC instant for a wall-clock date/time in a timezone (double-correction trick).
function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
    let ts = Date.UTC(y, m - 1, d, hh, mm);
    for (let i = 0; i < 2; i++) {
        const w = wallClock(new Date(ts), tz);
        ts += Date.UTC(y, m - 1, d, hh, mm) - Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
    }
    return new Date(ts);
}

// Next occurrence of a weekly schedule, as a UTC instant. Null when the
// schedule is disabled, incomplete, or carries an invalid timezone.
export function nextOccurrence(sched: NetSchedule, now: Date = new Date()): Date | null {
    if (!sched || sched.enabled === false) return null;
    const { dayOfWeek, hour, minute } = sched;
    if (dayOfWeek === undefined || hour === undefined || minute === undefined) return null;
    const tz = sched.timezone || 'UTC';
    try {
        const start = wallClock(now, tz);
        for (let offset = 0; offset <= 7; offset++) {
            // Pure calendar-day arithmetic (timezone-independent): Date.UTC
            // normalizes day overflow across month/year boundaries, so this
            // lands on the next local calendar date exactly once per offset
            // regardless of whether that day is 23, 24, or 25 hours long.
            const cand = new Date(Date.UTC(start.y, start.m - 1, start.d + offset));
            if (cand.getUTCDay() !== dayOfWeek) continue;
            const occ = zonedTimeToUtc(cand.getUTCFullYear(), cand.getUTCMonth() + 1, cand.getUTCDate(), hour, minute, tz);
            if (occ.getTime() > now.getTime()) return occ;
        }
        return null; // unreachable for a valid weekly schedule
    } catch {
        return null; // invalid timezone
    }
}

// Coarse "in how long" formatting: two largest units, floor, 'now' under a minute.
export function relTime(deltaMs: number): string {
    if (deltaMs < 60_000) return 'now';
    const totalMin = Math.floor(deltaMs / 60_000);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
}

export function describeSchedule(sched: NetSchedule): string {
    const day = DAY_NAMES[sched.dayOfWeek ?? -1] || '?';
    const hh = String(sched.hour ?? 0).padStart(2, '0');
    const mm = String(sched.minute ?? 0).padStart(2, '0');
    return `${day} ${hh}:${mm} (${sched.timezone || 'UTC'})`;
}

export function bucketRecentRows(rows: Array<{ status?: string }>):
    { total: number; delivered: number; bounced: number; deferred: number; other: number } {
    const b = { total: rows.length, delivered: 0, bounced: 0, deferred: 0, other: 0 };
    for (const r of rows) {
        if (r.status === 'delivered') b.delivered++;
        else if (r.status === 'bounce' || r.status === 'dropped' || r.status === 'blocked') b.bounced++;
        else if (r.status === 'deferred') b.deferred++;
        else b.other++;
    }
    return b;
}
