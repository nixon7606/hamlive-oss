const express = require('express');
const request = require('supertest');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/models/emailSettings', () => {
  let doc = null;
  return {
    loadEmailSettings: jest.fn(async () => doc),
    saveEmailSettings: jest.fn(async (patch) => { doc = { provider: patch.provider, smtp: { ...(doc?.smtp), ...(patch.smtp) }, tracking: { ...(doc?.tracking), ...(patch.tracking) } }; return doc; })
  };
});
jest.mock('../../../server/dist/lib/secretBox', () => ({ encryptSecret: jest.fn(p => `enc:${p}`), decryptSecret: jest.fn() }));
jest.mock('../../../server/dist/lib/emailTransports', () => ({ invalidateTransportCache: jest.fn(), getActiveTransport: jest.fn() }));
jest.mock('../../../server/dist/models/adminAudit', () => ({ getAdminAudit: () => ({ create: jest.fn(async () => ({})) }) }));

const { getSettings, putSettings } = require('../../../server/dist/controllers/emailAdminController');
const { saveEmailSettings } = require('../../../server/dist/models/emailSettings');
const { encryptSecret } = require('../../../server/dist/lib/secretBox');
const { invalidateTransportCache } = require('../../../server/dist/lib/emailTransports');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { _id: '1', email: 'admin@x.com' }; next(); });
app.get('/api/admin/email/settings', getSettings);
app.put('/api/admin/email/settings', putSettings);

test('GET settings never leaks the password and reports passwordSet', async () => {
  const res = await request(app).get('/api/admin/email/settings');
  expect(res.status).toBe(200);
  expect(JSON.stringify(res.body)).not.toMatch(/passwordEnc|password"/i);
  expect(res.body.message).toHaveProperty('provider');
});

test('PUT encrypts a provided password, saves, and invalidates cache', async () => {
  const res = await request(app).put('/api/admin/email/settings')
    .send({ provider: 'smtp', smtp: { host: 'h', port: 587, secure: true, user: 'u', password: 'hunter2' } });
  expect(res.status).toBe(200);
  expect(encryptSecret).toHaveBeenCalledWith('hunter2');
  expect(saveEmailSettings).toHaveBeenCalled();
  const savedPatch = saveEmailSettings.mock.calls[0][0];
  expect(savedPatch.smtp.passwordEnc).toBe('enc:hunter2');
  expect(savedPatch.smtp).not.toHaveProperty('password');
  expect(invalidateTransportCache).toHaveBeenCalled();
});

test('PUT without a password does not call encrypt (preserves existing)', async () => {
  encryptSecret.mockClear();
  const res = await request(app).put('/api/admin/email/settings')
    .send({ provider: 'smtp', smtp: { host: 'h2', port: 25, secure: false, user: 'u' } });
  expect(res.status).toBe(200);
  expect(encryptSecret).not.toHaveBeenCalled();
});

test('GET reports passwordInvalid when the stored password no longer decrypts (key rotation)', async () => {
  const { decryptSecret } = require('../../../server/dist/lib/secretBox');

  // store a password so passwordEnc exists
  await request(app).put('/api/admin/email/settings')
    .send({ provider: 'smtp', smtp: { host: 'h', port: 587, secure: true, user: 'u', password: 'hunter2' } });

  // decryptable → not flagged
  decryptSecret.mockImplementation(() => 'hunter2');
  let res = await request(app).get('/api/admin/email/settings');
  expect(res.body.message.smtp.passwordSet).toBe(true);
  expect(res.body.message.smtp.passwordInvalid).toBe(false);

  // key rotated → decrypt throws → flagged so the admin knows to re-enter it
  decryptSecret.mockImplementation(() => { throw new Error('bad auth tag'); });
  res = await request(app).get('/api/admin/email/settings');
  expect(res.body.message.smtp.passwordSet).toBe(true);
  expect(res.body.message.smtp.passwordInvalid).toBe(true);
});

test('PUT encrypts a provided tracking token, write-only; GET reports tokenSet, never the token', async () => {
  const res = await request(app).put('/api/admin/email/settings')
    .send({ provider: 'smtp', tracking: { enabled: true, host: 'cp.example.com', port: 2083, user: 'acct', tlsVerify: true, token: 'SECRETTOKEN' } });
  expect(res.status).toBe(200);
  const savedPatch = saveEmailSettings.mock.calls.at(-1)[0];
  expect(savedPatch.tracking.tokenEnc).toBe('enc:SECRETTOKEN');
  expect(savedPatch.tracking).not.toHaveProperty('token');

  const get = await request(app).get('/api/admin/email/settings');
  expect(JSON.stringify(get.body)).not.toContain('SECRETTOKEN');
  expect(JSON.stringify(get.body)).not.toContain('tokenEnc');
  expect(get.body.message.tracking.tokenSet).toBe(true);
});

test('PUT without a token preserves the stored tokenEnc', async () => {
  await request(app).put('/api/admin/email/settings')
    .send({ provider: 'smtp', tracking: { enabled: false, host: 'cp2', port: 2083, user: 'acct', tlsVerify: false } });
  const savedPatch = saveEmailSettings.mock.calls.at(-1)[0];
  expect(savedPatch.tracking).not.toHaveProperty('tokenEnc');
});
