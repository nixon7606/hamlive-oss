/* hamlive-oss — MIT License. See LICENSE. */

const { checkSecrets } = require('../../../server/dist/lib/configLib');

test('flags the known default cookie/magic secrets', () => {
  const problems = checkSecrets({ cookie_session_key: 'dev-cookie-key-change-me', magic_link_secret: 'dev-magic-link-secret-change-me' });
  expect(problems.length).toBe(2);
  expect(problems.join(' ')).toMatch(/COOKIE_SESSION_KEY/);
  expect(problems.join(' ')).toMatch(/MAGIC_LINK_SECRET/);
});

test('flags missing or too-short secrets', () => {
  expect(checkSecrets({ cookie_session_key: '', magic_link_secret: 'short' }).length).toBe(2);
});

test('passes for strong unique secrets', () => {
  const strong = 'a'.repeat(40);
  expect(checkSecrets({ cookie_session_key: strong, magic_link_secret: 'b'.repeat(40) })).toEqual([]);
});
