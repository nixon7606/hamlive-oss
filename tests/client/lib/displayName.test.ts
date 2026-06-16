import { buildSenderLabel } from '../../../client/src/public/js/lib/displayName';

test('combines distinct name and callsign as Name(CALL)', () => {
  expect(buildSenderLabel('Wayne', 'N0AD')).toBe('Wayne(N0AD)');
});

test('callsign only when there is no name', () => {
  expect(buildSenderLabel('', 'N0AD')).toBe('N0AD');
  expect(buildSenderLabel(undefined, 'N0AD')).toBe('N0AD');
});

test('name only when there is no callsign', () => {
  expect(buildSenderLabel('Wayne', '')).toBe('Wayne');
  expect(buildSenderLabel('Wayne', undefined)).toBe('Wayne');
});

test('does not duplicate when name equals callsign (case-insensitive)', () => {
  expect(buildSenderLabel('N0AD', 'N0AD')).toBe('N0AD');
  expect(buildSenderLabel('n0ad', 'N0AD')).toBe('N0AD');
});

test('falls back to Unknown when both are empty', () => {
  expect(buildSenderLabel('', '')).toBe('Unknown');
  expect(buildSenderLabel(undefined, undefined)).toBe('Unknown');
});

test('trims surrounding whitespace', () => {
  expect(buildSenderLabel('  Wayne  ', ' N0AD ')).toBe('Wayne(N0AD)');
});
