const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { emailLogSchema } = require('../../../server/dist/models/emailLog');
const { emailEventSchema } = require('../../../server/dist/models/emailEvent');

// Mock handleRequest to bypass flexOpts middleware requirement (same pattern as chatRoutes.test.js)
jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => {
    fn().then(result => res.json(result)).catch(err => {
      res.status(500).json({ error: err.message });
    });
  }
}));

const { listEmailActivity } = require('../../../server/dist/controllers/adminController');

const EmailLog = mongoose.models.EmailLog || mongoose.model('EmailLog', emailLogSchema);
const EmailEvent = mongoose.models.EmailEvent || mongoose.model('EmailEvent', emailEventSchema);
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-adminemail';

const app = express();
app.get('/api/admin/email', listEmailActivity);

beforeAll(async () => { await mongoose.connect(MONGO_URI); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await EmailLog.deleteMany({}); await EmailEvent.deleteMany({}); });

test('returns logs and their events for a recipient (case-insensitive)', async () => {
  await EmailLog.create({ recipient: 'user@x.com', type: 'magic-login', subject: 'Sign in', batchId: 'b1', sgMessageId: 'M1', status: 'delivered' });
  await EmailEvent.create({ sgEventId: 'e1', batchId: 'b1', email: 'user@x.com', event: 'delivered', timestamp: new Date() });
  const res = await request(app).get('/api/admin/email').query({ recipient: 'USER@x.com' });
  expect(res.status).toBe(200);
  expect(res.body.message.logs).toHaveLength(1);
  expect(res.body.message.logs[0].sgMessageId).toBe('M1');
  expect(res.body.message.events).toHaveLength(1);
  expect(res.body.message.events[0].event).toBe('delivered');
});

test('blank recipient returns empty result', async () => {
  const res = await request(app).get('/api/admin/email');
  expect(res.status).toBe(200);
  expect(res.body.message.logs).toEqual([]);
  expect(res.body.message.events).toEqual([]);
});
