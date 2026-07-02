// Pin the process timezone BEFORE anything touches Date — several helpers
// format in the viewer-local zone and the assertions must be deterministic.
process.env.TZ = 'UTC';

import { nextOccurrence, relTime, describeSchedule, bucketRecentRows }
    from '../../../client/src/public/js/byView/admin/adminViewHelpers';
import { buildWeekHTML, buildAgendaHTML } from '../../../client/src/public/js/byView/admin/adminViewHelpers';

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

test('nextOccurrence: does not skip the spring-forward day (probes calendar days)', () => {
  // Sat Mar 7 2026 23:30 MST — last hour before the eve of the Mar 8 spring-forward.
  const eve = new Date(Date.UTC(2026, 2, 8, 6, 30));
  const occ = nextOccurrence({ dayOfWeek: 0, hour: 10, minute: 0, timezone: 'America/Denver', enabled: true }, eve);
  expect(occ?.toISOString()).toBe('2026-03-08T16:00:00.000Z'); // Sun Mar 8 10:00 MDT, NOT a week later
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

const NETS = [
  { _id: 'n1', title: 'Sunday Rag Chew', hasLiveNet: false,
    schedule: { enabled: true, dayOfWeek: 0, hour: 19, minute: 30, timezone: 'UTC', notifyBeforeMinutes: 30 } },
  { _id: 'n2', title: 'Wednesday Tech Net', hasLiveNet: true,
    schedule: { enabled: true, dayOfWeek: 3, hour: 20, minute: 0, timezone: 'UTC', notifyBeforeMinutes: 15 } },
  { _id: 'n3', title: 'No Schedule Net', hasLiveNet: false, schedule: { enabled: false } },
];

test('buildWeekHTML: 7 day columns, enabled nets only, live class, data-id present', () => {
  const html = buildWeekHTML(NETS, NOW);
  expect((html.match(/class="sched-day"/g) || []).length).toBe(7); // exact — "sched-day-head" must not count
  expect(html).toContain('Sunday Rag Chew');
  expect(html).toContain('data-id="n1"');
  expect(html).toContain('sched-live');           // n2 is live
  expect(html).not.toContain('No Schedule Net');  // disabled excluded
});

test('buildWeekHTML escapes titles', () => {
  const html = buildWeekHTML([{ _id: 'x', title: '<img src=x>', hasLiveNet: false,
    schedule: { enabled: true, dayOfWeek: 1, hour: 1, minute: 0, timezone: 'UTC' } }], NOW);
  expect(html).not.toContain('<img src=x>');
  expect(html).toContain('&lt;img');
});

test('buildAgendaHTML: chronological next-7-days with day headings', () => {
  const html = buildAgendaHTML(NETS, NOW);
  // NOW is Wed 18:00 UTC; Wednesday Tech Net (20:00) is Today, Sunday net later
  expect(html.indexOf('Wednesday Tech Net')).toBeLessThan(html.indexOf('Sunday Rag Chew'));
  expect(html).toContain('Today');
});
