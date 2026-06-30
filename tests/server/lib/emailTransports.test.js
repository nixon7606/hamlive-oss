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
