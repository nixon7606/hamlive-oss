jest.mock('@sendgrid/client', () => ({ setApiKey: jest.fn(), request: jest.fn() }));
jest.mock('../../../server/dist/lib/configLib', () => ({ conf: { sendgrid_api_key: 'SG.test' } }));
const client = require('@sendgrid/client');
const { getSuppressions, removeSuppression } = require('../../../server/dist/lib/sendgridSuppression');

beforeEach(() => client.request.mockReset());

test('getSuppressions returns the lists an email is on', async () => {
  client.request.mockImplementation(async ({ url }) => {
    if (url.includes('/bounces/')) return [{ statusCode: 200 }, [{ created: 1700000000, email: 'u@x.com', reason: '550 no mailbox' }]];
    return [{ statusCode: 200 }, []];
  });
  const result = await getSuppressions('u@x.com');
  expect(result).toEqual([{ list: 'bounces', reason: '550 no mailbox', created: 1700000000 }]);
});

test('removeSuppression issues a DELETE for the right list+email', async () => {
  client.request.mockResolvedValue([{ statusCode: 204 }, {}]);
  await removeSuppression('u@x.com', 'bounces');
  expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
    method: 'DELETE', url: '/v3/suppression/bounces/u%40x.com'
  }));
});
