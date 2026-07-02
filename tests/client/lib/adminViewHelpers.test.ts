// Pin the process timezone BEFORE anything touches Date — several helpers
// format in the viewer-local zone and the assertions must be deterministic.
process.env.TZ = 'UTC';

import { nextOccurrence, relTime, describeSchedule, bucketRecentRows }
    from '../../../client/src/public/js/byView/admin/adminViewHelpers';

// Fixed reference: Wed 2026-07-01 18:00:00 UTC
const NOW = new Date(Date.UTC(2026, 6, 1, 18, 0, 0));

test('nextOccurrence: later today in UTC', () => {
  const occ = nextOccurrence({ dayOfWeek: 3, hour: 20, minute: 30, timezone: 'UTC', enabled: true }, NOW);
  expect(occ?.toISOString()).toBe('2026-07-01T20:30:00.000Z');
});

test('nextOccurrence: already passed today → next week', () => {
  const occ = nextOccurrence({ dayOfWeek: 3, hour: 10, minute: 0, timezone: 'UTC', enabled: true }, NOW);
  expect(occ?.toISOString()).toBe('2026-07-08T10:00:00.000Z');
});

test('nextOccurrence: timezone conversion (Denver is UTC-6 in July/DST)', () => {
  // Sun 19:30 America/Denver == Mon 01:30 UTC
  const occ = nextOccurrence({ dayOfWeek: 0, hour: 19, minute: 30, timezone: 'America/Denver', enabled: true }, NOW);
  expect(occ?.toISOString()).toBe('2026-07-06T01:30:00.000Z'); // Sun Jul 5, 19:30 MDT
});

test('nextOccurrence: null for disabled/incomplete/invalid tz', () => {
  expect(nextOccurrence({ enabled: false, dayOfWeek: 1, hour: 1, minute: 0, timezone: 'UTC' }, NOW)).toBeNull();
  expect(nextOccurrence({ enabled: true }, NOW)).toBeNull();
  expect(nextOccurrence({ enabled: true, dayOfWeek: 1, hour: 1, minute: 0, timezone: 'Not/AZone' }, NOW)).toBeNull();
});

test('relTime formats coarse two-unit deltas', () => {
  expect(relTime(2 * 86400_000 + 4 * 3600_000)).toBe('2d 4h');
  expect(relTime(3 * 3600_000 + 12 * 60_000)).toBe('3h 12m');
  expect(relTime(12 * 60_000)).toBe('12m');
  expect(relTime(20_000)).toBe('now');
});

test('describeSchedule renders day, zero-padded time, and timezone', () => {
  expect(describeSchedule({ dayOfWeek: 0, hour: 19, minute: 5, timezone: 'America/Denver', enabled: true }))
    .toBe('Sun 19:05 (America/Denver)');
});

test('bucketRecentRows counts statuses', () => {
  const b = bucketRecentRows([
    { status: 'delivered' }, { status: 'delivered' }, { status: 'bounce' },
    { status: 'deferred' }, { status: 'accepted' }, {}
  ]);
  expect(b).toEqual({ total: 6, delivered: 2, bounced: 1, deferred: 1, other: 2 });
});
