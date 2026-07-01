/* hamlive-oss — MIT License. See LICENSE. */
jest.mock('../../../server/dist/lib/secretBox', () => ({
  decryptSecret: jest.fn(tok => {
    if (tok === 'enc:good') return 'THETOKEN';
    throw new Error('bad auth tag');
  }),
  encryptSecret: jest.fn()
}));

const {
  buildSearchUrl, parseSearchResponse, searchEmailTrack
} = require('../../../server/dist/lib/cpanelDeliveryPoller');

test('buildSearchUrl uses API 2 json-api with the verified boolean flags', () => {
  const url = buildSearchUrl({ host: 'cp.example.com', port: 2083, user: 'acct' });
  expect(url).toContain('https://cp.example.com:2083/json-api/cpanel?');
  expect(url).toContain('cpanel_jsonapi_user=acct');
  expect(url).toContain('cpanel_jsonapi_apiversion=2');
  expect(url).toContain('cpanel_jsonapi_module=EmailTrack');
  expect(url).toContain('cpanel_jsonapi_func=search');
  // the ONLY spelling that returns successes on a real box:
  expect(url).toContain('success=1');
  expect(url).toContain('defer=1');
  expect(url).toContain('failure=1');
  expect(url).toContain('inprogress=1');
});

test('parseSearchResponse unwraps data and surfaces cPanel errors', () => {
  expect(parseSearchResponse({ cpanelresult: { data: [{ msgid: 'a' }] } })).toEqual([{ msgid: 'a' }]);
  expect(parseSearchResponse({ cpanelresult: { data: [] } })).toEqual([]);
  expect(() => parseSearchResponse({ errors: ['Failed to load module "EmailTrack"'] }))
    .toThrow(/EmailTrack/);
  expect(() => parseSearchResponse({ cpanelresult: { error: 'Access denied' } }))
    .toThrow(/Access denied/);
});

test('searchEmailTrack decrypts the token and sends the cpanel auth header', async () => {
  const requestImpl = jest.fn(async (url, opts) => ({
    statusCode: 200,
    body: JSON.stringify({ cpanelresult: { data: [{ msgid: 'm1' }] } })
  }));
  const rows = await searchEmailTrack(
    { host: 'cp.example.com', port: 2083, user: 'acct', tokenEnc: 'enc:good', tlsVerify: true },
    { requestImpl }
  );
  expect(rows).toEqual([{ msgid: 'm1' }]);
  const [url, opts] = requestImpl.mock.calls[0];
  expect(url).toContain('cp.example.com');
  expect(opts.headers.Authorization).toBe('cpanel acct:THETOKEN');
  expect(opts.rejectUnauthorized).toBe(true);
});

test('searchEmailTrack maps tlsVerify:false and undecryptable tokens to clear errors', async () => {
  const requestImpl = jest.fn(async () => ({ statusCode: 200, body: '{"cpanelresult":{"data":[]}}' }));
  await searchEmailTrack({ host: 'h', port: 2083, user: 'u', tokenEnc: 'enc:good', tlsVerify: false }, { requestImpl });
  expect(requestImpl.mock.calls[0][1].rejectUnauthorized).toBe(false);

  await expect(
    searchEmailTrack({ host: 'h', port: 2083, user: 'u', tokenEnc: 'enc:BAD', tlsVerify: true }, { requestImpl })
  ).rejects.toThrow(/decrypt/i);
});
