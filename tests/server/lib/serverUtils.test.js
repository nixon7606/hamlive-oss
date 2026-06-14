const { isCurrentlyLocked } = require('../../../server/dist/lib/serverUtils');

describe('isCurrentlyLocked()', () => {
  test('not locked → false', () => {
    expect(isCurrentlyLocked({ locked: false, lockedUntil: null })).toBe(false);
  });
  test('locked, no expiry → true (permanent)', () => {
    expect(isCurrentlyLocked({ locked: true, lockedUntil: null })).toBe(true);
  });
  test('locked, future expiry → true', () => {
    expect(isCurrentlyLocked({ locked: true, lockedUntil: new Date(Date.now() + 60_000) })).toBe(true);
  });
  test('locked, past expiry → false (auto-lifted)', () => {
    expect(isCurrentlyLocked({ locked: true, lockedUntil: new Date(Date.now() - 60_000) })).toBe(false);
  });
  test('null/undefined user → false', () => {
    expect(isCurrentlyLocked(null)).toBe(false);
    expect(isCurrentlyLocked(undefined)).toBe(false);
  });
});
