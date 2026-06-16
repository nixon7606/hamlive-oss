import { withinSelfDeleteWindow, SELF_DELETE_WINDOW_MS } from '../../../client/src/public/js/lib/selfDelete';

const NOW = 1_700_000_000_000; // fixed clock for determinism

test('constant is 15 minutes in ms', () => {
  expect(SELF_DELETE_WINDOW_MS).toBe(15 * 60 * 1000);
});

test('message sent just now is within the window', () => {
  expect(withinSelfDeleteWindow(new Date(NOW).toISOString(), NOW)).toBe(true);
});

test('message sent 14 minutes ago is within the window', () => {
  expect(withinSelfDeleteWindow(new Date(NOW - 14 * 60 * 1000).toISOString(), NOW)).toBe(true);
});

test('message sent 16 minutes ago is outside the window', () => {
  expect(withinSelfDeleteWindow(new Date(NOW - 16 * 60 * 1000).toISOString(), NOW)).toBe(false);
});

test('accepts a Date instance', () => {
  expect(withinSelfDeleteWindow(new Date(NOW - 60 * 1000), NOW)).toBe(true);
});

test('undefined or invalid createdAt is not deletable', () => {
  expect(withinSelfDeleteWindow(undefined, NOW)).toBe(false);
  expect(withinSelfDeleteWindow('not-a-date', NOW)).toBe(false);
});
