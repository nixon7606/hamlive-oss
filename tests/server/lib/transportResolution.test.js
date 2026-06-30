// Mutable settings the factory returns; hoisted ahead of all requires by jest.
// Variable must be prefixed with 'mock' to be allowed in jest.mock factory scope.
let mockSettings = null;
jest.mock('../../../server/dist/models/emailSettings', () => ({
  loadEmailSettings: jest.fn(async () => mockSettings),
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
