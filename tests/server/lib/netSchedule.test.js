/* hamlive-oss — MIT License. See LICENSE. */
const { buildAndValidateSchedule } = require('../../../server/dist/controllers/netProfileController');

test('returns undefined for no input', () => {
  expect(buildAndValidateSchedule(undefined)).toBeUndefined();
});
test('normalizes a valid schedule with defaults', () => {
  const out = buildAndValidateSchedule({ dayOfWeek: 2, hour: 19, minute: 30, enabled: true });
  expect(out).toMatchObject({ dayOfWeek: 2, hour: 19, minute: 30, timezone: 'UTC', notifyBeforeMinutes: 30, enabled: true });
});
test('rejects out-of-range dayOfWeek', () => {
  expect(() => buildAndValidateSchedule({ dayOfWeek: 9, hour: 1, minute: 1 })).toThrow(/dayOfWeek/);
});
test('rejects out-of-range hour', () => {
  expect(() => buildAndValidateSchedule({ hour: 25 })).toThrow(/hour/);
});
test('enabled:false skips range checks and returns disabled', () => {
  expect(buildAndValidateSchedule({ enabled: false }).enabled).toBe(false);
});

// ── notifyBeforeEnabled passthrough (the UI checkbox was dead: nothing ever sent it) ──
test('passes notifyBeforeEnabled false through; defaults to true when absent', () => {
  const off = buildAndValidateSchedule({ dayOfWeek: 1, hour: 19, minute: 0, notifyBeforeEnabled: false });
  expect(off.notifyBeforeEnabled).toBe(false);
  const on = buildAndValidateSchedule({ dayOfWeek: 1, hour: 19, minute: 0 });
  expect(on.notifyBeforeEnabled).toBe(true);
});

// ── timezone validation (invalid IANA name used to save fine, then silently never fire) ──
test('rejects an invalid IANA timezone, accepts a valid one', () => {
  expect(() => buildAndValidateSchedule({ dayOfWeek: 1, hour: 19, minute: 0, timezone: 'America/Chicgo' }))
    .toThrow(/timezone/i);
  const ok = buildAndValidateSchedule({ dayOfWeek: 1, hour: 19, minute: 0, timezone: 'America/Chicago' });
  expect(ok.timezone).toBe('America/Chicago');
});

// ── notifyBeforeMinutes matches the UI/starter contract: 5-120, default 30 ──
test('rejects notifyBeforeMinutes above 120 (UI and starter cap)', () => {
  expect(() => buildAndValidateSchedule({ dayOfWeek: 1, hour: 19, minute: 0, notifyBeforeMinutes: 300 }))
    .toThrow(/notifyBeforeMinutes/);
});
