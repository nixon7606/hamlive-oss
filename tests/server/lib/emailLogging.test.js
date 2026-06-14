/* hamlive-oss — MIT License. See LICENSE. */
const mongoose = require('mongoose');
const { emailLogSchema } = require('../../../server/dist/models/emailLog');
const EmailLog = mongoose.models.EmailLog || mongoose.model('EmailLog', emailLogSchema);
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-emaillogging';

jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  sendMultiple: jest.fn(async () => ([{ headers: { 'x-message-id': 'MSG123' } }]))
}));
jest.mock('../../../server/dist/lib/configLib', () => ({
  conf: { sendgrid_api_key: 'SG.test', app_name: 'Ham.Live', email_from: 'Ham <no-reply@x.com>' }
}));

const { EmailBase } = require('../../../server/dist/lib/userNotification');

beforeAll(async () => { await mongoose.connect(MONGO_URI); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await EmailLog.deleteMany({}); });

test('creates an emailLog per recipient with sgMessageId and type', async () => {
  const mail = new EmailBase({ subject: 'Hi', message: '<p>hi</p>', type: 'magic-login' });
  await mail.sendMailToAddrs(['a@b.com']);
  await new Promise(r => setTimeout(r, 50)); // logging is fire-and-forget
  const logs = await EmailLog.find({ recipient: 'a@b.com' });
  expect(logs).toHaveLength(1);
  expect(logs[0].type).toBe('magic-login');
  expect(logs[0].sgMessageId).toBe('MSG123');
  expect(logs[0].status).toBe('queued');
});
