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

// Statuses an admin should treat as delivery failures (SendGrid event names
// stored verbatim on EmailLog, plus what the cPanel poller writes).
export function isBouncedStatus(s: string | undefined): boolean {
    return s === 'bounce' || s === 'dropped' || s === 'blocked' || s === 'spamreport';
}

export function bucketRecentRows(rows: Array<{ status?: string }>):
    { total: number; delivered: number; bounced: number; deferred: number; other: number } {
    const b = { total: rows.length, delivered: 0, bounced: 0, deferred: 0, other: 0 };
    for (const r of rows) {
        if (r.status === 'delivered') b.delivered++;
        else if (isBouncedStatus(r.status)) b.bounced++;
        else if (r.status === 'deferred') b.deferred++;
        else b.other++;
    }
    return b;
}

function escText(s: string): string {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
    )[c] ?? c);
}

interface Occurrence { net: any; occ: Date; }

function upcoming(nets: any[], now: Date): Occurrence[] {
    const out: Occurrence[] = [];
    for (const net of nets) {
        const occ = nextOccurrence(net.schedule || {}, now);
        if (occ) out.push({ net, occ });
    }
    return out.sort((a, b) => a.occ.getTime() - b.occ.getTime());
}

function blockHTML(o: Occurrence): string {
    const hh = String(o.occ.getHours()).padStart(2, '0');
    const mm = String(o.occ.getMinutes()).padStart(2, '0');
    const s = o.net.schedule || {};
    const tip = `${describeSchedule(s)} · opens ${s.notifyBeforeMinutes ?? 30} min early`;
    const isLive = o.net.hasLiveNet && o.net.liveNetStatus === 'live';
    const live = isLive ? ' sched-live' : '';
    const liveTag = isLive ? ' <span class="badge badge-live">● LIVE</span>' : '';
    return `<button type="button" class="sched-block${live}" data-id="${escText(o.net._id)}" title="${escText(tip)}">` +
        `<span class="sched-time">${hh}:${mm}</span> ${escText(o.net.title || '')}${liveTag}</button>`;
}

const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Recurring weekly pattern: column = viewer-local day of the next occurrence.
export function buildWeekHTML(nets: any[], now: Date = new Date()): string {
    const byDay: Occurrence[][] = [[], [], [], [], [], [], []];
    for (const o of upcoming(nets, now)) byDay[o.occ.getDay()]!.push(o);
    for (const day of byDay) day.sort((a, b) =>
        (a.occ.getHours() * 60 + a.occ.getMinutes()) - (b.occ.getHours() * 60 + b.occ.getMinutes()));
    return `<div class="sched-week">` + byDay.map((day, i) =>
        `<div class="sched-day"><div class="sched-day-head">${DAY_FULL[i]}</div>` +
        (day.length ? day.map(blockHTML).join('') : '<div class="text-muted small">—</div>') +
        `</div>`).join('') + `</div>`;
}

// Dated next-7-days agenda.
export function buildAgendaHTML(nets: any[], now: Date = new Date()): string {
    const occ = upcoming(nets, now);
    if (!occ.length) return '<p class="text-muted">No scheduled nets.</p>';
    const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const today = dayKey(now);
    const tomorrow = dayKey(new Date(now.getTime() + 86400_000));
    const groups = new Map<string, { label: string; items: Occurrence[] }>();
    for (const o of occ) {
        const k = dayKey(o.occ);
        if (!groups.has(k)) {
            const label = k === today ? 'Today' : k === tomorrow ? 'Tomorrow'
                : o.occ.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            groups.set(k, { label, items: [] });
        }
        groups.get(k)!.items.push(o);
    }
    return [...groups.values()].map(g =>
        `<div class="sched-agenda-day"><h6 class="mt-2">${escText(g.label)}</h6>${g.items.map(blockHTML).join('')}</div>`
    ).join('');
}
