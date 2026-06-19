const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { emailLogSchema } = require('../../../server/dist/models/emailLog');
const { emailEventSchema } = require('../../../server/dist/models/emailEvent');

jest.mock('../../../server/dist/lib/sendgridWebhook', () => ({ verifySignature: jest.fn() }));
const { verifySignature } = require('../../../server/dist/lib/sendgridWebhook');

const EmailLog = mongoose.models.EmailLog || mongoose.model('EmailLog', emailLogSchema);
const EmailEvent = mongoose.models.EmailEvent || mongoose.model('EmailEvent', emailEventSchema);
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-sgwebhook';

const webhookRoutes = require('../../../server/dist/routes/sendgridWebhookRoutes');
const app = express();
app.use('/api/sendgrid/events', express.raw({ type: '*/*' }), webhookRoutes);

beforeAll(async () => { await mongoose.connect(MONGO_URI); await EmailEvent.syncIndexes(); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => {
  await EmailLog.deleteMany({}); await EmailEvent.deleteMany({}); verifySignature.mockReset();
});

const payload = [{
  sg_event_id: 'evt1', email: 'a@b.com', event: 'delivered',
  timestamp: 1700000000, sg_message_id: 'MSG123.recv', hlBatch: 'batch1', hlType: 'magic-login'
}];

test('rejects an invalid signature with 401', async () => {
  verifySignature.mockReturnValue(false);
  const res = await request(app).post('/api/sendgrid/events').set('X-Twilio-Email-Event-Webhook-Timestamp', String(Math.floor(Date.now() / 1000))).send(payload);
  expect(res.status).toBe(401);
  expect(await EmailEvent.countDocuments()).toBe(0);
});

test('valid signature upserts events and advances emailLog status', async () => {
  verifySignature.mockReturnValue(true);
  await EmailLog.create({ recipient: 'a@b.com', type: 'magic-login', subject: 's', batchId: 'batch1' });
  const res = await request(app).post('/api/sendgrid/events').set('X-Twilio-Email-Event-Webhook-Timestamp', String(Math.floor(Date.now() / 1000))).send(payload);
  expect(res.status).toBe(200);
  expect(await EmailEvent.countDocuments()).toBe(1);
  const log = await EmailLog.findOne({ batchId: 'batch1', recipient: 'a@b.com' });
  expect(log.status).toBe('delivered');
});

test('duplicate sg_event_id is idempotent', async () => {
  verifySignature.mockReturnValue(true);
  await request(app).post('/api/sendgrid/events').set('X-Twilio-Email-Event-Webhook-Timestamp', String(Math.floor(Date.now() / 1000))).send(payload);
  await request(app).post('/api/sendgrid/events').set('X-Twilio-Email-Event-Webhook-Timestamp', String(Math.floor(Date.now() / 1000))).send(payload);
  expect(await EmailEvent.countDocuments()).toBe(1);
});
