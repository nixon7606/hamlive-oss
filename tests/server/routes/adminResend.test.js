const express = require('express');
const request = require('supertest');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/routes/authRoutes', () => ({
  sendMagicSignInLink: jest.fn(async () => ({ devMagicLink: 'http://localhost:3000/auth/magiclogin/callback?token=x' }))
}));
// isRealSenderActive() → getActiveTransport() calls loadEmailSettings(). Stub it to
// return null so buildTransport falls to ConsoleTransport (no DB needed in unit tests).
jest.mock('../../../server/dist/models/emailSettings', () => ({
  loadEmailSettings: jest.fn(async () => null),
  saveEmailSettings: jest.fn()
}));
const { sendMagicSignInLink } = require('../../../server/dist/routes/authRoutes');
const { resendSignInLink } = require('../../../server/dist/controllers/adminController');

const app = express();
app.use(express.json());
app.post('/api/admin/email/resend-login', resendSignInLink);

test('resends a sign-in link to the given email', async () => {
  const res = await request(app).post('/api/admin/email/resend-login').send({ email: 'u@x.com' });
  expect(res.status).toBe(200);
  expect(sendMagicSignInLink).toHaveBeenCalledWith('u@x.com');
  expect(res.body.message.sent).toBe(true);
});

test('rejects a missing email with 400', async () => {
  const res = await request(app).post('/api/admin/email/resend-login').send({});
  expect(res.status).toBe(400);
});
