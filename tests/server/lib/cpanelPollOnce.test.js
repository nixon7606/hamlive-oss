/* hamlive-oss — MIT License. See LICENSE. */
let mockSettings = null;
jest.mock('../../../server/dist/models/emailSettings', () => ({
  loadEmailSettings: jest.fn(async () => mockSettings),
  saveEmailSettings: jest.fn()
}));

const logRows = [];
const logUpdates = [];
jest.mock('../../../server/dist/models/emailLog', () => ({
  getEmailLog: () => ({
    find: () => ({ lean: async () => logRows }),
    updateOne: async (q, u) => { logUpdates.push({ q, u }); return { matchedCount: 1 }; }
  })
}));

const eventUpserts = [];
let mockUpsertedCountQueue = [];
jest.mock('../../../server/dist/models/emailEvent', () => ({
  getEmailEvent: () => ({
    updateOne: async (q, u, o) => {
      eventUpserts.push({ q, u, o });
      const next = mockUpsertedCountQueue.length ? mockUpsertedCountQueue.shift() : 1;
      return { upsertedCount: next };
    }
  })
}));

jest.mock('../../../server/dist/lib/configLib', () => ({ conf: { email_from: 'noreply@netcontrol.live' } }));

const { pollOnce, shouldPoll, syntheticEventId } = require('../../../server/dist/lib/cpanelDeliveryPoller');

const TRACKING = { enabled: true, host: 'cp', port: 2083, user: 'acct', tokenEnc: 'enc:t', tlsVerify: true };

beforeEach(() => { logRows.length = 0; logUpdates.length = 0; eventUpserts.length = 0; mockUpsertedCountQueue = []; });

test('shouldPoll requires smtp provider + enabled + complete tracking config', () => {
  expect(shouldPoll({ provider: 'smtp', tracking: TRACKING })).toBe(true);
  expect(shouldPoll({ provider: 'sendgrid', tracking: TRACKING })).toBe(false);
  expect(shouldPoll({ provider: 'smtp', tracking: { ...TRACKING, enabled: false } })).toBe(false);
  expect(shouldPoll({ provider: 'smtp', tracking: { ...TRACKING, tokenEnc: '' } })).toBe(false);
  expect(shouldPoll(null)).toBe(false);
});

test('no non-terminal rows → zero API calls', async () => {
  mockSettings = { provider: 'smtp', smtp: {}, tracking: TRACKING };
  const searchImpl = jest.fn();
  const r = await pollOnce({ searchImpl });
  expect(searchImpl).not.toHaveBeenCalled();
  expect(r).toEqual({ polled: 0, updated: 0, events: 0 });
});

test('delivered + bounce rows update EmailLog and upsert idempotent EmailEvents', async () => {
  const now = Date.now();
  mockSettings = { provider: 'smtp', smtp: {}, tracking: TRACKING };
  logRows.push(
    { _id: 'L1', batchId: 'B1', recipient: 'a@x.com', status: 'accepted', createdAt: new Date(now - 60_000) },
    { _id: 'L2', batchId: 'B2', recipient: 'b@x.com', status: 'accepted', createdAt: new Date(now - 60_000) }
  );
  const searchImpl = jest.fn(async () => ([
    { msgid: 'm1', type: 'success', email: 'noreply@netcontrol.live', recipient: 'a@x.com',
      sendunixtime: Math.floor(now / 1000) - 30, actionunixtime: Math.floor(now / 1000) - 10 },
    { msgid: 'm2', type: 'failure', reason: 'mailbox unavailable', email: 'noreply@netcontrol.live',
      recipient: 'b@x.com', sendunixtime: Math.floor(now / 1000) - 30, actionunixtime: Math.floor(now / 1000) - 5 },
    // foreign mail in the same account — must be ignored
    { msgid: 'm3', type: 'success', email: 'noreply-dmarc-support@google.com',
      recipient: 'dmarc_rua@netcontrol.live', sendunixtime: Math.floor(now / 1000) }
  ]));
  const r = await pollOnce({ searchImpl });
  expect(r.updated).toBe(2);
  expect(logUpdates).toHaveLength(2);
  expect(logUpdates[0].q).toEqual({ batchId: 'B1', recipient: 'a@x.com' });
  expect(logUpdates[0].u.$set.status).toBe('delivered');
  expect(logUpdates[1].u.$set.status).toBe('bounce');
  // events: idempotent synthetic key in sgEventId, reason carried, exim id in sgMessageId
  expect(eventUpserts).toHaveLength(2);
  expect(eventUpserts[0].q).toEqual({ sgEventId: syntheticEventId('m1', 'a@x.com', 'success') });
  expect(eventUpserts[0].o).toEqual({ upsert: true });
  expect(eventUpserts[1].u.$setOnInsert.reason).toBe('mailbox unavailable');
  expect(eventUpserts[1].u.$setOnInsert.sgMessageId).toBe('m2');
});

test('inprogress rows change nothing; defer maps to deferred (stays pollable)', async () => {
  const now = Date.now();
  mockSettings = { provider: 'smtp', smtp: {}, tracking: TRACKING };
  logRows.push({ _id: 'L1', batchId: 'B1', recipient: 'a@x.com', status: 'accepted', createdAt: new Date(now) });
  const searchImpl = jest.fn(async () => ([
    { msgid: 'm1', type: 'inprogress', email: 'noreply@netcontrol.live', recipient: 'a@x.com', sendunixtime: Math.floor(now / 1000) },
    { msgid: 'm1', type: 'defer', reason: 'greylisted', email: 'noreply@netcontrol.live', recipient: 'a@x.com', sendunixtime: Math.floor(now / 1000) }
  ]));
  await pollOnce({ searchImpl });
  expect(logUpdates).toHaveLength(1);
  expect(logUpdates[0].u.$set.status).toBe('deferred');
});

test('pollOnce is a no-op when shouldPoll is false (provider flipped back to sendgrid)', async () => {
  mockSettings = { provider: 'sendgrid', tracking: TRACKING };
  const searchImpl = jest.fn();
  const r = await pollOnce({ searchImpl });
  expect(searchImpl).not.toHaveBeenCalled();
  expect(r).toEqual({ polled: 0, updated: 0, events: 0 });
});

// Fix 1 (CRITICAL): EmailTrack returns one row per delivery ATTEMPT — a defer
// then a later success is routine (greylisting). If the feed is newest-first,
// processing rows in raw feed order lets the defer row "win" and the
// EmailLog gets stuck at 'deferred' forever (it's non-terminal, so every
// 5-minute cycle just re-clobbers it back). Rows must be sorted ascending by
// event time so the LATEST attempt is applied LAST.
test('same msgid+recipient, success row before defer row in feed order (newest-first) → final status is delivered', async () => {
  const now = Date.now();
  mockSettings = { provider: 'smtp', smtp: {}, tracking: TRACKING };
  logRows.push({ _id: 'L1', batchId: 'B1', recipient: 'a@x.com', status: 'accepted', createdAt: new Date(now - 60_000) });
  const searchImpl = jest.fn(async () => ([
    // Newest-first feed: the success (later actionunixtime) comes FIRST.
    { msgid: 'm1', type: 'success', email: 'noreply@netcontrol.live', recipient: 'a@x.com',
      sendunixtime: Math.floor(now / 1000) - 30, actionunixtime: Math.floor(now / 1000) - 5 },
    { msgid: 'm1', type: 'defer', reason: 'greylisted', email: 'noreply@netcontrol.live', recipient: 'a@x.com',
      sendunixtime: Math.floor(now / 1000) - 30, actionunixtime: Math.floor(now / 1000) - 20 },
  ]));
  await pollOnce({ searchImpl });
  expect(logUpdates.length).toBeGreaterThan(0);
  const finalUpdate = logUpdates[logUpdates.length - 1];
  expect(finalUpdate.u.$set.status).toBe('delivered');
});

// Fix 2: Number('') is 0 (finite), so the old `Number.isFinite` guard let a
// blank actionunixtime write new Date(0) (1970) into lastEventAt/timestamp.
test('blank actionunixtime does not write a 1970 timestamp', async () => {
  const now = Date.now();
  mockSettings = { provider: 'smtp', smtp: {}, tracking: TRACKING };
  logRows.push({ _id: 'L1', batchId: 'B1', recipient: 'a@x.com', status: 'accepted', createdAt: new Date(now) });
  const searchImpl = jest.fn(async () => ([
    { msgid: 'm1', type: 'success', email: 'noreply@netcontrol.live', recipient: 'a@x.com',
      sendunixtime: Math.floor(now / 1000), actionunixtime: '' },
  ]));
  await pollOnce({ searchImpl });
  expect(logUpdates).toHaveLength(1);
  const ts = logUpdates[0].u.$set.lastEventAt.getTime();
  expect(ts).toBeGreaterThan(now - 60_000);
});

// Fix 5: events++ should count actual new EmailEvent inserts (upsertedCount),
// not upsert *attempts* — otherwise idempotent re-polls of the same rows
// keep inflating the counter.
test('events counter reflects upsertedCount, not attempts (re-poll of existing event → events stays 0)', async () => {
  const now = Date.now();
  mockSettings = { provider: 'smtp', smtp: {}, tracking: TRACKING };
  logRows.push({ _id: 'L1', batchId: 'B1', recipient: 'a@x.com', status: 'accepted', createdAt: new Date(now) });
  const searchImpl = jest.fn(async () => ([
    { msgid: 'm1', type: 'success', email: 'noreply@netcontrol.live', recipient: 'a@x.com',
      sendunixtime: Math.floor(now / 1000), actionunixtime: Math.floor(now / 1000) },
  ]));
  mockUpsertedCountQueue = [0]; // simulates: EmailEvent already existed, no new insert
  const r = await pollOnce({ searchImpl });
  expect(r.events).toBe(0);
  expect(r.updated).toBe(1);
});
