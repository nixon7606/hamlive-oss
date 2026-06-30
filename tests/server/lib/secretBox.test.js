const { encryptSecret, decryptSecret } = require('../../../server/dist/lib/secretBox');

beforeAll(() => { process.env.EMAIL_SECRET_KEY = 'a'.repeat(40); });

test('round-trips a secret', () => {
  const token = encryptSecret('hunter2');
  expect(token.startsWith('v1:')).toBe(true);
  expect(token).not.toContain('hunter2');
  expect(decryptSecret(token)).toBe('hunter2');
});

test('two encryptions of the same plaintext differ (random salt/iv)', () => {
  expect(encryptSecret('x')).not.toBe(encryptSecret('x'));
});

test('tampering with ciphertext throws on decrypt', () => {
  const token = encryptSecret('secret');
  const parts = token.split(':');
  parts[4] = Buffer.from('tampered').toString('base64');
  expect(() => decryptSecret(parts.join(':'))).toThrow();
});
