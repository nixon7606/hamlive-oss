jest.mock('../../../server/dist/lib/configLib', () => ({
  conf: { magic_link_secret: 'test-secret', base_url: 'http://localhost:3000', app_name: 'Ham.Live' }
}));

const authRoutes = require('../../../server/dist/routes/authRoutes');

test('sendMagicSignInLink resolves with a dev magic link when email is disabled', async () => {
  expect(typeof authRoutes.sendMagicSignInLink).toBe('function');
  const result = await authRoutes.sendMagicSignInLink('tester@example.com');
  expect(result.devMagicLink).toMatch(/\/auth\/magiclogin\/callback\?token=/);
});
