const { verifySignature } = require('../../../server/dist/lib/sendgridWebhook');

test('returns false when verification key is not configured', () => {
  expect(verifySignature(Buffer.from('[]'), 'sig', 'ts', '')).toBe(false);
});

test('returns false on a bad signature', () => {
  const key = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'A'.repeat(88);
  expect(verifySignature(Buffer.from('[]'), 'badsig', '123', key)).toBe(false);
});
