/* hamlive-oss — MIT License. See LICENSE. */
/**
 * handleRequest must honor a caller-set err.status (assertKey → 404,
 * putTemplate validation → 400) instead of flattening everything to 500 —
 * otherwise routine client mistakes read as server outages in logs/monitoring.
 */
const { handleRequest } = require('../../../server/dist/lib/responseUtils');

const flexOpts = {
  gracePeriodDays: 0, ads: 0, chat: true, analytics: false, email: true,
  maxNetsPerUser: 1, maxOwnersPerNet: 1, baseTtlMs: 5000, awayInMs: 1,
  httpClientTimeout: 1, requestRateFactor: 1, qrzDataReqTimeoutMs: 1,
  qrzSessionReqTimeoutMs: 1, qrzReqQuota: 1, maxFollowersPerNet: 1,
  maxFollowingPerUser: 1, sigReportTypeByMode: {}
};

function mockRes() {
  const res = { locals: { flexOpts }, statusCode: null, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}

test('handleRequest responds with err.status when set (404/400)', async () => {
  const res404 = mockRes();
  await handleRequest(res404, async () => { const e = new Error('unknown template key: bogus'); e.status = 404; throw e; });
  expect(res404.statusCode).toBe(404);
  expect(res404.body.errorMessage).toMatch(/unknown template/);

  const res400 = mockRes();
  await handleRequest(res400, async () => { const e = new Error('subject and html are required'); e.status = 400; throw e; });
  expect(res400.statusCode).toBe(400);
});

test('handleRequest still defaults to 500 for plain errors', async () => {
  const res = mockRes();
  await handleRequest(res, async () => { throw new Error('boom'); });
  expect(res.statusCode).toBe(500);
  expect(res.body.errorMessage).toBe('boom');
});
