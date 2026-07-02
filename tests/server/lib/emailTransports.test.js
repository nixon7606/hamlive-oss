const { buildSendGridPayload, ConsoleTransport } = require('../../../server/dist/lib/emailTransports');

test('buildSendGridPayload maps normalized html + attachments to SG shape', () => {
  const sg = buildSendGridPayload({
    to: ['a@b.com'], from: 'x@y.com', subject: 'Hi', html: '<b>hi</b>',
    attachments: [{ filename: 'r.csv', contentBase64: 'YWJj', contentType: 'text/csv' }]
  });
  expect(sg.to).toEqual(['a@b.com']);
  expect(sg.html).toBe('<b>hi</b>');
  expect(sg.attachments[0]).toEqual({ content: 'YWJj', filename: 'r.csv', type: 'text/csv', disposition: 'attachment' });
});

test('buildSendGridPayload passes through templateId/templateData (no html)', () => {
  const sg = buildSendGridPayload({ to: ['a@b.com'], from: 'x@y.com', templateId: 'd-1', templateData: { title: 'T' } });
  expect(sg.templateId).toBe('d-1');
  expect(sg.dynamic_template_data).toEqual({ title: 'T' });
  expect(sg.html).toBeUndefined();
});

test('ConsoleTransport returns null messageId and does not throw', async () => {
  const r = await new ConsoleTransport().send({ to: ['a@b.com'], subject: 'Hi', html: '<b>x</b>' });
  expect(r).toEqual({ messageId: null });
});

const nodemailer = require('nodemailer');
const { SmtpTransport } = require('../../../server/dist/lib/emailTransports');

test('SmtpTransport sends html + attachments via nodemailer', async () => {
  const sendMail = jest.fn(async () => ({ messageId: '<abc@local>' }));
  jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });
  const t = new SmtpTransport({ host: 'localhost', port: 1025, secure: false, user: 'u', pass: 'p', from: 'x@y.com' });
  const r = await t.send({
    to: ['a@b.com'], from: 'x@y.com', subject: 'Hi', html: '<b>hi</b>',
    attachments: [{ filename: 'r.csv', contentBase64: 'YWJj', contentType: 'text/csv' }]
  });
  expect(r.messageId).toBe('<abc@local>');
  const arg = sendMail.mock.calls[0][0];
  expect(arg.to).toBe('a@b.com');
  expect(arg.html).toBe('<b>hi</b>');
  expect(arg.attachments[0].filename).toBe('r.csv');
  expect(Buffer.isBuffer(arg.attachments[0].content)).toBe(true);
});

test('SmtpTransport refuses a templateId-only message', async () => {
  const t = new SmtpTransport({ host: 'localhost', port: 1025, secure: false, from: 'x@y.com' });
  await expect(t.send({ to: ['a@b.com'], subject: 'x', templateId: 'd-1', templateData: {} }))
    .rejects.toThrow(/template/i);
});

// ── per-recipient delivery + fromOverride ────────────────────────────────────

test('SmtpTransport sends one copy per recipient (no shared To header)', async () => {
  const sendMail = jest.fn(async () => ({ messageId: '<abc@local>' }));
  jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });
  const t = new SmtpTransport({ host: 'localhost', port: 1025, secure: false, from: 'x@y.com' });
  await t.send({ to: ['a@b.com', 'c@d.com'], from: 'x@y.com', subject: 'Hi', html: '<b>hi</b>' });
  expect(sendMail).toHaveBeenCalledTimes(2);
  expect(sendMail.mock.calls[0][0].to).toBe('a@b.com');
  expect(sendMail.mock.calls[1][0].to).toBe('c@d.com');
  // no recipient list ever appears in a single header
  for (const call of sendMail.mock.calls) expect(call[0].to).not.toContain(',');
});

test('SmtpTransport continues past a failed recipient and only throws when all fail', async () => {
  const sendMail = jest
    .fn()
    .mockRejectedValueOnce(new Error('mailbox full'))
    .mockResolvedValueOnce({ messageId: '<ok@local>' });
  jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });
  const t = new SmtpTransport({ host: 'localhost', port: 1025, secure: false, from: 'x@y.com' });
  const r = await t.send({ to: ['bad@b.com', 'good@d.com'], subject: 'Hi', html: 'x' });
  expect(sendMail).toHaveBeenCalledTimes(2);
  expect(r.messageId).toBe('<ok@local>');
  // the failed recipient is reported, not swallowed
  expect(r.rejected).toEqual([{ recipient: 'bad@b.com', reason: 'mailbox full', permanent: false }]);

  const allFail = jest.fn(async () => { throw new Error('550'); });
  jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail: allFail });
  const t2 = new SmtpTransport({ host: 'localhost', port: 1025, secure: false, from: 'x@y.com' });
  await expect(t2.send({ to: ['a@b.com'], subject: 'Hi', html: 'x' })).rejects.toThrow(/failed/);
});

test('SmtpTransport all-fail error carries per-recipient rejections and a permanent flag on 5xx', async () => {
  const err550 = new Error('550 domain may not exist');
  err550.responseCode = 550;
  const sendMail = jest.fn(async () => { throw err550; });
  jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });
  const t = new SmtpTransport({ host: 'localhost', port: 1025, secure: false, from: 'x@y.com' });
  let thrown;
  await t.send({ to: ['bad@gmail.co'], subject: 'Hi', html: 'x' }).catch(e => { thrown = e; });
  expect(thrown.rejected).toEqual([{ recipient: 'bad@gmail.co', reason: '550 domain may not exist', permanent: true }]);
  expect(thrown.permanent).toBe(true);

  // A transient failure (no 5xx responseCode) must NOT be flagged permanent —
  // the retry loop keys off this.
  const errConn = new Error('connection reset');
  const sendMail2 = jest.fn(async () => { throw errConn; });
  jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail: sendMail2 });
  const t2 = new SmtpTransport({ host: 'localhost', port: 1025, secure: false, from: 'x@y.com' });
  let thrown2;
  await t2.send({ to: ['a@b.com'], subject: 'Hi', html: 'x' }).catch(e => { thrown2 = e; });
  expect(thrown2.permanent).toBe(false);
});

test('SmtpTransport fromOverride wins over the message from; absent override keeps msg.from', async () => {
  const sendMail = jest.fn(async () => ({ messageId: '<abc@local>' }));
  jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });

  const withOverride = new SmtpTransport({
    host: 'localhost', port: 1025, secure: false,
    from: 'default@y.com', fromOverride: 'Net <net@club.org>'
  });
  await withOverride.send({ to: ['a@b.com'], from: 'app@y.com', subject: 'Hi', html: 'x' });
  expect(sendMail.mock.calls[0][0].from).toBe('Net <net@club.org>');

  const noOverride = new SmtpTransport({ host: 'localhost', port: 1025, secure: false, from: 'default@y.com' });
  await noOverride.send({ to: ['a@b.com'], from: 'app@y.com', subject: 'Hi', html: 'x' });
  expect(sendMail.mock.calls[1][0].from).toBe('app@y.com');
});
