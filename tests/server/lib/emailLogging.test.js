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
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn(async () => ({ messageId: '<m@local>' })) }))
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

test('SMTP sends record EmailLog rows as accepted (the cPanel poller advances them)', async () => {
  // Point the active transport at SMTP via a real EmailSettings doc in the test DB.
  const { emailSettingsSchema } = require('../../../server/dist/models/emailSettings');
  const EmailSettings = mongoose.models.EmailSettings || mongoose.model('EmailSettings', emailSettingsSchema);
  await EmailSettings.create({ singleton: 'email', provider: 'smtp', smtp: { host: 'localhost', port: 25 } });
  const { invalidateTransportCache } = require('../../../server/dist/lib/emailTransports');
  invalidateTransportCache();
  try {
    const mail = new EmailBase({ subject: 'Hi', message: '<p>hi</p>', type: 'magic-login' });
    await mail.sendMailToAddrs(['smtp-status@b.com']);
    await new Promise(r => setTimeout(r, 50)); // logging is fire-and-forget
    const logs = await EmailLog.find({ recipient: 'smtp-status@b.com' });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('accepted'); // NOT SendGrid's 'queued'
  } finally {
    await EmailSettings.deleteMany({});
    invalidateTransportCache();
  }
});

// A recipient the relay 550-rejects at SMTP time never enters the mail queue,
// so no webhook/poller will ever surface it — the send path itself must record
// the bounce, and must not burn retries on an error that can never succeed.
describe('synchronous SMTP rejections', () => {
  const { emailSettingsSchema } = require('../../../server/dist/models/emailSettings');
  const { emailEventSchema } = require('../../../server/dist/models/emailEvent');
  const EmailSettings = mongoose.models.EmailSettings || mongoose.model('EmailSettings', emailSettingsSchema);
  const EmailEvent = mongoose.models.EmailEvent || mongoose.model('EmailEvent', emailEventSchema);
  const { invalidateTransportCache } = require('../../../server/dist/lib/emailTransports');
  const nodemailer = require('nodemailer');

  beforeEach(async () => {
    await EmailSettings.create({ singleton: 'email', provider: 'smtp', smtp: { host: 'localhost', port: 25 } });
    await EmailEvent.deleteMany({});
    invalidateTransportCache();
  });
  afterEach(async () => {
    await EmailSettings.deleteMany({});
    invalidateTransportCache();
    nodemailer.createTransport.mockImplementation(() => ({ sendMail: jest.fn(async () => ({ messageId: '<m@local>' })) }));
  });

  test('a 550-rejected recipient gets a bounce EmailLog + EmailEvent with the relay reason, with NO retries', async () => {
    const err550 = new Error('550 The account or domain may not exist');
    err550.responseCode = 550;
    const sendMail = jest.fn(async () => { throw err550; });
    nodemailer.createTransport.mockImplementation(() => ({ sendMail }));

    const mail = new EmailBase({ subject: 'Hi', message: '<p>hi</p>', type: 'magic-login' });
    await expect(mail.sendMailToAddrs(['bad@gmail.co'])).rejects.toThrow(/failed/);
    await new Promise(r => setTimeout(r, 50)); // logging is fire-and-forget

    expect(sendMail).toHaveBeenCalledTimes(1); // permanent 5xx — no retry spam

    const logs = await EmailLog.find({ recipient: 'bad@gmail.co' });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('bounce');

    const events = await EmailEvent.find({ email: 'bad@gmail.co' });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('bounce');
    expect(events[0].reason).toMatch(/may not exist/);
    expect(events[0].batchId).toBe(logs[0].batchId);
  });

  test('a partial rejection records accepted for the good recipient and bounce for the bad one', async () => {
    const err550 = new Error('550 no such user');
    err550.responseCode = 550;
    const sendMail = jest.fn(async ({ to }) => {
      if (to === 'bad2@gmail.co') throw err550;
      return { messageId: '<ok@local>' };
    });
    nodemailer.createTransport.mockImplementation(() => ({ sendMail }));

    const mail = new EmailBase({ subject: 'Hi', message: '<p>hi</p>', type: 'net-announce' });
    const result = await mail.sendMailToAddrs(['good2@b.com', 'bad2@gmail.co']);
    await new Promise(r => setTimeout(r, 50));

    expect(result.sent).toEqual(['good2@b.com']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].recipient).toBe('bad2@gmail.co');

    expect((await EmailLog.findOne({ recipient: 'good2@b.com' })).status).toBe('accepted');
    expect((await EmailLog.findOne({ recipient: 'bad2@gmail.co' })).status).toBe('bounce');
    expect((await EmailEvent.findOne({ email: 'bad2@gmail.co' })).reason).toMatch(/no such user/);
  });
});
