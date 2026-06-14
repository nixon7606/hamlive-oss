const mongoose = require('mongoose');
const { emailLogSchema } = require('../../../server/dist/models/emailLog');
const EmailLog = mongoose.model('EmailLog', emailLogSchema);
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-emaillog';

beforeAll(async () => { await mongoose.connect(MONGO_URI); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await EmailLog.deleteMany({}); });

test('creates an emailLog with defaults', async () => {
  const doc = await EmailLog.create({
    recipient: 'a@b.com', type: 'magic-login', subject: 'Sign in', batchId: 'batch1'
  });
  expect(doc.status).toBe('queued');
  expect(doc.recipient).toBe('a@b.com');
  expect(doc.createdAt).toBeInstanceOf(Date);
});

test('requires recipient and batchId', async () => {
  await expect(EmailLog.create({ type: 'magic-login' })).rejects.toThrow();
});
