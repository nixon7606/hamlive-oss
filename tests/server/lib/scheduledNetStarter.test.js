/* hamlive-oss — MIT License. See LICENSE. */
/**
 * Unit tests for isTimeMatch — verifies a scheduled net opens notifyMin BEFORE
 * its official start (and that the offset handles day/week rollover).
 */
const { isTimeMatch, wasRecentlyAutoStarted } = require('../../../server/dist/lib/backgroundTasks/scheduledNetStarter');

// Use UTC schedules so formatToParts is deterministic regardless of DST.
const startAt = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo, d, h, mi, 0));

test('opens notifyMin BEFORE the scheduled start, not at the start', () => {
  const start = startAt(2026, 5, 17, 20, 0); // 8:00pm UTC
  const sched = { dayOfWeek: start.getUTCDay(), hour: 20, minute: 0, timezone: 'UTC', enabled: true };

  // 30 min before the start (7:30pm) → should fire
  expect(isTimeMatch(new Date(start.getTime() - 30 * 60000), sched, 30)).toBe(true);
  // at the start itself (8:00pm) → should NOT fire (it already opened at 7:30)
  expect(isTimeMatch(start, sched, 30)).toBe(false);
  // 30 min before but with no notify → should NOT fire
  expect(isTimeMatch(new Date(start.getTime() - 30 * 60000), sched, 0)).toBe(false);
});

test('notifyMin = 0 preserves "fire exactly at the scheduled time" behavior', () => {
  const start = startAt(2026, 5, 17, 20, 0);
  const sched = { dayOfWeek: start.getUTCDay(), hour: 20, minute: 0, timezone: 'UTC', enabled: true };
  expect(isTimeMatch(start, sched, 0)).toBe(true);
});

test('matches within the 0-1 minute catch window', () => {
  const start = startAt(2026, 5, 17, 20, 0);
  const sched = { dayOfWeek: start.getUTCDay(), hour: 20, minute: 0, timezone: 'UTC', enabled: true };
  const open = new Date(start.getTime() - 30 * 60000);
  expect(isTimeMatch(new Date(open.getTime() + 45 * 1000), sched, 30)).toBe(true);  // 45s into the window
  expect(isTimeMatch(new Date(open.getTime() + 70 * 1000), sched, 30)).toBe(true);  // ~1 min in
  expect(isTimeMatch(new Date(open.getTime() - 60 * 1000), sched, 30)).toBe(false); // a minute early
});

test('notify offset rolls back across midnight and the day-of-week boundary', () => {
  // Official start Sunday 00:15 UTC; 30-min notify opens Saturday 23:45.
  const start = startAt(2026, 5, 21, 0, 15); // pick a date, derive its dow
  const sched = { dayOfWeek: start.getUTCDay(), hour: 0, minute: 15, timezone: 'UTC', enabled: true };
  const open = new Date(start.getTime() - 30 * 60000); // previous day 23:45
  expect(open.getUTCDay()).not.toBe(start.getUTCDay()); // sanity: different day
  expect(isTimeMatch(open, sched, 30)).toBe(true);
});

test('wasRecentlyAutoStarted guards against re-opening a just-started occurrence', () => {
  const now = new Date(Date.UTC(2026, 5, 17, 20, 0, 0));
  const guard = 10 * 60 * 1000;
  // never started → not recent
  expect(wasRecentlyAutoStarted(null, now, guard)).toBe(false);
  expect(wasRecentlyAutoStarted(undefined, now, guard)).toBe(false);
  // started 1 min ago → still within guard (would re-open → block it)
  expect(wasRecentlyAutoStarted(new Date(now.getTime() - 60 * 1000), now, guard)).toBe(true);
  // started 11 min ago → past the guard (and past the match window) → allowed
  expect(wasRecentlyAutoStarted(new Date(now.getTime() - 11 * 60 * 1000), now, guard)).toBe(false);
  // last week's occurrence → not recent
  expect(wasRecentlyAutoStarted(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), now, guard)).toBe(false);
  // garbage timestamp → treated as not recent (don't block on bad data)
  expect(wasRecentlyAutoStarted('not-a-date', now, guard)).toBe(false);
});

test('respects the schedule timezone for the start time', () => {
  const tz = 'America/Denver';
  const startUtc = new Date(Date.UTC(2026, 5, 15, 2, 0, 0)); // some concrete instant
  // Derive the START's Denver wall-clock (dow/hour/minute) from that instant, so
  // the assertion can't be wrong about which weekday/hour it actually is.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, weekday: 'long', hour: '2-digit', hour12: false, minute: '2-digit', hourCycle: 'h23'
  });
  const p = fmt.formatToParts(startUtc);
  const wd = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const sched = {
    dayOfWeek: wd[p.find(x => x.type === 'weekday').value],
    hour: parseInt(p.find(x => x.type === 'hour').value, 10),
    minute: parseInt(p.find(x => x.type === 'minute').value, 10),
    timezone: tz,
    enabled: true
  };
  // Opens 30 min before that Denver start; not at the start itself.
  expect(isTimeMatch(new Date(startUtc.getTime() - 30 * 60000), sched, 30)).toBe(true);
  expect(isTimeMatch(startUtc, sched, 30)).toBe(false);
});
