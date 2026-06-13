const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { emailLogSchema } = require('../../../server/dist/models/emailLog');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
const EmailLog = mongoose.models.EmailLog || mongoose.model('EmailLog', emailLogSchema);
const { recentEmails } = require('../../../server/dist/controllers/adminController');
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-recentemails';

const app = express();
app.get('/api/admin/email/recent', recentEmails);

beforeAll(async () => { await mongoose.connect(MONGO_URI); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await EmailLog.deleteMany({}); });

test('returns sends within the window with a status summary (JSON)', async () => {
  const now = Date.now();
  await EmailLog.create({ recipient: 'a@x.com', type: 'magic-login', subject: 's1', batchId: 'b1', status: 'delivered', createdAt: new Date(now - 1000) });
  await EmailLog.create({ recipient: 'b@x.com', type: 'magic-login', subject: 's2', batchId: 'b2', status: 'bounce', createdAt: new Date(now - 2000) });
  await EmailLog.create({ recipient: 'c@x.com', type: 'magic-login', subject: 's3', batchId: 'b3', status: 'delivered', createdAt: new Date(now - 10 * 24 * 3600 * 1000) });
  const from = new Date(now - 24 * 3600 * 1000).toISOString();
  const to = new Date(now + 1000).toISOString();
  const res = await request(app).get('/api/admin/email/recent').query({ from, to });
  expect(res.status).toBe(200);
  expect(res.body.message.rows).toHaveLength(2);
  expect(res.body.message.rows[0].recipient).toBe('a@x.com');
  expect(res.body.message.summary.delivered).toBe(1);
  expect(res.body.message.summary.bounce).toBe(1);
});

test('format=csv returns a CSV download', async () => {
  const now = Date.now();
  await EmailLog.create({ recipient: 'a@x.com', type: 'magic-login', subject: 'Hi, there', batchId: 'b1', status: 'delivered', createdAt: new Date(now - 1000) });
  const res = await request(app).get('/api/admin/email/recent')
    .query({ from: new Date(now - 3600 * 1000).toISOString(), to: new Date(now + 1000).toISOString(), format: 'csv' });
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/csv/);
  expect(res.text).toMatch(/recipient,type,subject,status/);
  expect(res.text).toMatch(/a@x.com/);
  expect(res.text).toMatch(/"Hi, there"/);
});

test('invalid date returns 400', async () => {
  const res = await request(app).get('/api/admin/email/recent').query({ from: 'not-a-date' });
  expect(res.status).toBe(400);
});
