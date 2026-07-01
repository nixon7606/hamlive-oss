// Mutable settings the factory returns; hoisted ahead of all requires by jest.
// Variable must be prefixed with 'mock' to be allowed in jest.mock factory scope.
let mockSettings = null;
let mockSettingsFail = false;
jest.mock('../../../server/dist/models/emailSettings', () => ({
  loadEmailSettings: jest.fn(async () => {
    if (mockSettingsFail) throw new Error('db down');
    return mockSettings;
  }),
  saveEmailSettings: jest.fn()
}));

const transports = require('../../../server/dist/lib/emailTransports');

afterEach(() => { transports.invalidateTransportCache(); });

test('getActiveTransport picks SMTP from settings and caches until invalidated', async () => {
  mockSettings = { provider: 'smtp', smtp: { host: 'h', port: 587, secure: false, user: 'u', passwordEnc: null } };
  const t1 = await transports.getActiveTransport();
  expect(t1).toBeInstanceOf(transports.SmtpTransport);
  // change settings, but the cache should still serve the old transport
  mockSettings = { provider: 'console' };
  expect(await transports.getActiveTransport()).toBe(t1);
  transports.invalidateTransportCache();
  expect(await transports.getActiveTransport()).toBeInstanceOf(transports.ConsoleTransport);
});

test('getActiveTransport handles SMTP password decrypt failure gracefully', async () => {
  mockSettings = { provider: 'smtp', smtp: { host: 'h', port: 587, secure: false, user: 'u', passwordEnc: 'not-a-valid-token' } };
  // Should not throw despite decryptSecret throwing on malformed token
  const t = await transports.getActiveTransport();
  expect(t).toBeInstanceOf(transports.SmtpTransport);
});

test('a transient settings-load failure is NOT cached — next call retries the DB', async () => {
  mockSettings = { provider: 'smtp', smtp: { host: 'h', port: 587, secure: false, user: 'u', passwordEnc: null } };
  mockSettingsFail = true;
  // DB down → fallback transport for this send only
  const t1 = await transports.getActiveTransport();
  expect(t1).not.toBeInstanceOf(transports.SmtpTransport);
  // DB recovers → the configured SMTP transport must be picked up WITHOUT
  // an admin re-save or restart
  mockSettingsFail = false;
  const t2 = await transports.getActiveTransport();
  expect(t2).toBeInstanceOf(transports.SmtpTransport);
});
