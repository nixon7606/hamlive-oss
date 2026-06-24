/**
 * Unit tests for validateImageUrl — the server-side guard against stored XSS via
 * chat imageUrl. The URL is later rendered into a src="..." HTML attribute, so
 * anything that could break out of that attribute must be rejected.
 */
const { validateImageUrl } = require('../../../server/dist/lib/localChat');

describe('validateImageUrl — accepts safe URLs', () => {
  test.each([
    'https://example.com/image.png',
    'https://cdn.example.com/path/to/pic.jpg?v=2',
    '/uploads/chat/abc123.png'
  ])('accepts %s', url => {
    expect(validateImageUrl(url)).toBe(url);
  });
});

describe('validateImageUrl — rejects XSS / unsafe input', () => {
  test.each([
    ['attribute breakout via double quote', 'https://x"onerror="alert(1)'],
    ['attribute breakout via single quote', "https://x'onerror='alert(1)"],
    ['angle bracket', 'https://x/<script>'],
    ['whitespace (allows trailing attributes)', 'https://x onerror=alert(1)'],
    ['backslash', 'https://x\\y'],
    ['javascript: scheme', 'javascript:alert(1)'],
    ['data: scheme', 'data:text/html,<script>alert(1)</script>'],
    ['plain http (not https)', 'http://example.com/x.png'],
    ['protocol-relative', '//evil.com/x.png'],
    ['empty', ''],
    ['null', null],
    ['non-string', 12345]
  ])('rejects %s', (_label, url) => {
    expect(validateImageUrl(url)).toBeNull();
  });
});
