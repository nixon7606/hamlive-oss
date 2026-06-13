const express = require('express');
const request = require('supertest');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/lib/sendgridSuppression', () => ({
  getSuppressions: jest.fn(async () => []),
  removeSuppression: jest.fn(async () => {}),
  LISTS: ['bounces', 'blocks', 'spam_reports', 'invalid_emails']
}));
jest.mock('../../../server/dist/routes/authRoutes', () => ({ sendMagicSignInLink: jest.fn(async () => ({ devMagicLink: null })) }));
const { removeSuppression } = require('../../../server/dist/lib/sendgridSuppression');
const { sendMagicSignInLink } = require('../../../server/dist/routes/authRoutes');
const { unsuppressEmail } = require('../../../server/dist/controllers/adminController');

const app = express();
app.use(express.json());
app.post('/api/admin/email/unsuppress', unsuppressEmail);

test('removes a suppression then resends', async () => {
  const res = await request(app).post('/api/admin/email/unsuppress').send({ email: 'u@x.com', list: 'bounces' });
  expect(res.status).toBe(200);
  expect(removeSuppression).toHaveBeenCalledWith('u@x.com', 'bounces');
  expect(sendMagicSignInLink).toHaveBeenCalledWith('u@x.com');
  expect(res.body.message.removed).toBe(true);
});

test('rejects missing email/list with 400', async () => {
  const res = await request(app).post('/api/admin/email/unsuppress').send({ email: 'u@x.com' });
  expect(res.status).toBe(400);
});
