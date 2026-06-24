const express = require('express');
const request = require('supertest');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/routes/authRoutes', () => ({
  // generate-only path: mints a link WITHOUT sending email.
  generateMagicSignInLink: jest.fn(async () => ({ devMagicLink: 'http://localhost:3000/auth/magiclogin/callback?token=gen' })),
  // present so the controller's destructured import of the send path is defined;
  // it must NOT be called by generate-login.
  sendMagicSignInLink: jest.fn(async () => ({ devMagicLink: 'http://localhost:3000/auth/magiclogin/callback?token=send' }))
}));
const { generateMagicSignInLink, sendMagicSignInLink } = require('../../../server/dist/routes/authRoutes');
const { generateSignInLink } = require('../../../server/dist/controllers/adminController');

const app = express();
app.use(express.json());
app.post('/api/admin/email/generate-login', generateSignInLink);

test('mints a fresh link and returns it without sending email', async () => {
  const res = await request(app).post('/api/admin/email/generate-login').send({ email: 'u@x.com' });
  expect(res.status).toBe(200);
  expect(generateMagicSignInLink).toHaveBeenCalledWith('u@x.com');
  // the whole point of generate-only: the SendGrid send path is never invoked.
  expect(sendMagicSignInLink).not.toHaveBeenCalled();
  expect(res.body.message.generated).toBe(true);
  expect(res.body.message.devMagicLink).toContain('token=gen');
});

test('rejects a missing email with 400', async () => {
  const res = await request(app).post('/api/admin/email/generate-login').send({});
  expect(res.status).toBe(400);
});
