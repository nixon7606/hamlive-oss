/* hamlive-oss — MIT License. See LICENSE. */
/**
 * A stored template that no longer compiles must not take the email type down:
 * renderTemplate falls back to the on-disk default instead of throwing
 * (a broken magic-link template would otherwise disable sign-in platform-wide).
 */
jest.mock('../../../server/dist/models/emailTemplate', () => ({
  getEmailTemplate: () => ({
    findOne: async () => ({ subject: 'Sign in', html: '{{#if link}broken' })
  })
}));

const ts = require('../../../server/dist/lib/templateService');

test('renderTemplate falls back to the default when the stored template will not compile', async () => {
  const out = await ts.renderTemplate('magic-link', { link: 'https://x/login?token=abc' });
  expect(out.html).toContain('https://x/login?token=abc'); // default rendered
});
