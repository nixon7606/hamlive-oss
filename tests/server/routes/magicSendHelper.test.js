jest.mock('../../../server/dist/lib/configLib', () => ({
  conf: { magic_link_secret: 'test-secret', base_url: 'http://localhost:3000', app_name: 'Ham.Live' }
}));
// isRealSenderActive() → getActiveTransport() calls loadEmailSettings(). Stub it to
// return null (no DB settings) so buildTransport falls back to ConsoleTransport (no
// sendgrid key in test env), avoiding a real MongoDB connection.
jest.mock('../../../server/dist/models/emailSettings', () => ({
  loadEmailSettings: jest.fn(async () => null),
  saveEmailSettings: jest.fn()
}));

const authRoutes = require('../../../server/dist/routes/authRoutes');

test('sendMagicSignInLink resolves with a dev magic link when email is disabled', async () => {
  expect(typeof authRoutes.sendMagicSignInLink).toBe('function');
  const result = await authRoutes.sendMagicSignInLink('tester@example.com');
  expect(result.devMagicLink).toMatch(/\/auth\/magiclogin\/callback\?token=/);
});
