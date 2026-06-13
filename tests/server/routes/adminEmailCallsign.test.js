const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { emailLogSchema } = require('../../../server/dist/models/emailLog');
const { emailEventSchema } = require('../../../server/dist/models/emailEvent');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/lib/sendgridSuppression', () => ({ getSuppressions: async () => [], removeSuppression: async () => {}, LISTS: [] }));

const EmailLog = mongoose.models.EmailLog || mongoose.model('EmailLog', emailLogSchema);
mongoose.models.EmailEvent || mongoose.model('EmailEvent', emailEventSchema);
const { listEmailActivity } = require('../../../server/dist/controllers/adminController');
const { getUserProfile } = require('../../../server/dist/models/userProfile');

const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-emailcallsign';
const app = express();
app.get('/api/admin/email', listEmailActivity);

beforeAll(async () => { await mongoose.connect(MONGO_URI); getUserProfile(); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => {
  await EmailLog.deleteMany({});
  await mongoose.connection.db.collection('userprofiles').deleteMany({});
});

test('resolves a callsign to the user email and returns that mail', async () => {
  await mongoose.connection.db.collection('userprofiles').insertOne({ callSign: 'KC0XYZ', email: 'op@example.com' });
  await EmailLog.create({ recipient: 'op@example.com', type: 'magic-login', subject: 'Sign in', batchId: 'b1', status: 'delivered' });
  const res = await request(app).get('/api/admin/email').query({ recipient: 'kc0xyz' });
  expect(res.status).toBe(200);
  expect(res.body.message.resolved).toEqual({ callSign: 'KC0XYZ', email: 'op@example.com' });
  expect(res.body.message.logs).toHaveLength(1);
});

test('unknown callsign returns empty with notFound', async () => {
  const res = await request(app).get('/api/admin/email').query({ recipient: 'NOPE1' });
  expect(res.status).toBe(200);
  expect(res.body.message.logs).toEqual([]);
  expect(res.body.message.resolved).toBeNull();
  expect(res.body.message.notFound).toBe('callsign');
});

test('an email input still works directly (resolved null)', async () => {
  await EmailLog.create({ recipient: 'direct@example.com', type: 'magic-login', subject: 's', batchId: 'b2', status: 'queued' });
  const res = await request(app).get('/api/admin/email').query({ recipient: 'DIRECT@example.com' });
  expect(res.body.message.logs).toHaveLength(1);
  expect(res.body.message.resolved).toBeNull();
});
