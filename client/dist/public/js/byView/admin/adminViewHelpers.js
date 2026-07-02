'use strict';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_NUM = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};
function wallClock(ts, tz) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const parts = {};
    for (const p of fmt.formatToParts(ts))
        parts[p.type] = p.value;
    return {
        y: parseInt(parts['year'], 10), m: parseInt(parts['month'], 10),
        d: parseInt(parts['day'], 10), hh: parseInt(parts['hour'], 10) % 24,
        mm: parseInt(parts['minute'], 10), dow: WEEKDAY_NUM[parts['weekday']] ?? -1,
    };
}
function zonedTimeToUtc(y, m, d, hh, mm, tz) {
    let ts = Date.UTC(y, m - 1, d, hh, mm);
    for (let i = 0; i < 2; i++) {
        const w = wallClock(new Date(ts), tz);
        ts += Date.UTC(y, m - 1, d, hh, mm) - Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
    }
    return new Date(ts);
}
export function nextOccurrence(sched, now = new Date()) {
    if (!sched || sched.enabled === false)
        return null;
    const { dayOfWeek, hour, minute } = sched;
    if (dayOfWeek === undefined || hour === undefined || minute === undefined)
        return null;
    const tz = sched.timezone || 'UTC';
    try {
        const start = wallClock(now, tz);
        for (let offset = 0; offset <= 7; offset++) {
            const cand = new Date(Date.UTC(start.y, start.m - 1, start.d + offset));
            if (cand.getUTCDay() !== dayOfWeek)
                continue;
            const occ = zonedTimeToUtc(cand.getUTCFullYear(), cand.getUTCMonth() + 1, cand.getUTCDate(), hour, minute, tz);
            if (occ.getTime() > now.getTime())
                return occ;
        }
        return null;
    }
    catch {
        return null;
    }
}
export function relTime(deltaMs) {
    if (deltaMs < 60_000)
        return 'now';
    const totalMin = Math.floor(deltaMs / 60_000);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d > 0)
        return h > 0 ? `${d}d ${h}h` : `${d}d`;
    if (h > 0)
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
}
export function describeSchedule(sched) {
    const day = DAY_NAMES[sched.dayOfWeek ?? -1] || '?';
    const hh = String(sched.hour ?? 0).padStart(2, '0');
    const mm = String(sched.minute ?? 0).padStart(2, '0');
    return `${day} ${hh}:${mm} (${sched.timezone || 'UTC'})`;
}
export function bucketRecentRows(rows) {
    const b = { total: rows.length, delivered: 0, bounced: 0, deferred: 0, other: 0 };
    for (const r of rows) {
        if (r.status === 'delivered')
            b.delivered++;
        else if (r.status === 'bounce' || r.status === 'dropped' || r.status === 'blocked')
            b.bounced++;
        else if (r.status === 'deferred')
            b.deferred++;
        else
            b.other++;
    }
    return b;
}
//# sourceMappingURL=adminViewHelpers.js.map