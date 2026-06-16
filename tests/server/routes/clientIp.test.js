jest.mock('../../../server/dist/lib/configLib', () => ({
  conf: { magic_link_secret: 'test-secret', base_url: 'http://localhost:3000', app_name: 'Ham.Live' }
}));

const authRoutes = require('../../../server/dist/routes/authRoutes');

describe('clientIp', () => {
  test('prefers the CF-Connecting-IP header (real visitor behind a Cloudflare Tunnel)', () => {
    const req = {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
      ip: '::1',                       // loopback: the local end of the cloudflared connection
      connection: { remoteAddress: '::1' },
    };
    expect(authRoutes.clientIp(req)).toBe('203.0.113.7');
  });

  test('falls back to req.ip when no CF-Connecting-IP header is present', () => {
    const req = { headers: {}, ip: '198.51.100.4', connection: { remoteAddress: '::1' } };
    expect(authRoutes.clientIp(req)).toBe('198.51.100.4');
  });

  test('falls back to connection.remoteAddress, then to empty string', () => {
    expect(authRoutes.clientIp({ headers: {}, connection: { remoteAddress: '198.51.100.9' } })).toBe('198.51.100.9');
    expect(authRoutes.clientIp({ headers: {}, connection: {} })).toBe('');
  });
});
