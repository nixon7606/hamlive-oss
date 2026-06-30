/* hamlive-oss — MIT License. See LICENSE. */
let mockSettings = null;
jest.mock('../../../server/dist/models/emailSettings', () => ({
  loadEmailSettings: jest.fn(async () => mockSettings),
  saveEmailSettings: jest.fn()
}));
const transports = require('../../../server/dist/lib/emailTransports');
afterEach(() => transports.invalidateTransportCache());

test('isRealSenderActive is false in console mode, true for SMTP', async () => {
  mockSettings = { provider: 'console' };
  expect(await transports.isRealSenderActive()).toBe(false);
  transports.invalidateTransportCache();
  mockSettings = { provider: 'smtp', smtp: { host: 'h', port: 25, secure: false } };
  expect(await transports.isRealSenderActive()).toBe(true);
});
