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
