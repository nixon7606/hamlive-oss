/* hamlive-oss — MIT License. See LICENSE. */
const { buildAndValidateSchedule } = require('../../../server/dist/controllers/netProfileController');

test('returns undefined for no input', () => {
  expect(buildAndValidateSchedule(undefined)).toBeUndefined();
});
test('normalizes a valid schedule with defaults', () => {
  const out = buildAndValidateSchedule({ dayOfWeek: 2, hour: 19, minute: 30, enabled: true });
  expect(out).toMatchObject({ dayOfWeek: 2, hour: 19, minute: 30, timezone: 'UTC', notifyBeforeMinutes: 15, enabled: true });
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
