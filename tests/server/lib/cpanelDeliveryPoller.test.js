/* hamlive-oss — MIT License. See LICENSE. */
const {
  mapTrackType, syntheticEventId, filterToSender, correlateRow
} = require('../../../server/dist/lib/cpanelDeliveryPoller');

test('mapTrackType mirrors the SendGrid status vocabulary', () => {
  expect(mapTrackType('success')).toBe('delivered');
  expect(mapTrackType('failure')).toBe('bounce');
  expect(mapTrackType('defer')).toBe('deferred');
  expect(mapTrackType('inprogress')).toBeNull(); // leave EmailLog as-is
  expect(mapTrackType('weird-new-type')).toBeNull();
});

test('syntheticEventId is deterministic and distinguishes type/recipient', () => {
  const a = syntheticEventId('1weh-abc', 'x@y.com', 'success');
  expect(a).toBe(syntheticEventId('1weh-abc', 'x@y.com', 'success')); // idempotency key
  expect(a).toMatch(/^cpt-[0-9a-f]{64}$/);
  expect(a).not.toBe(syntheticEventId('1weh-abc', 'x@y.com', 'failure'));
  expect(a).not.toBe(syntheticEventId('1weh-abc', 'z@y.com', 'success'));
});

test('filterToSender keeps only rows sent by our address (feed contains foreign mail)', () => {
  const rows = [
    { email: 'noreply@netcontrol.live', recipient: 'a@x.com' },
    { email: 'noreply-dmarc-support@google.com', recipient: 'dmarc_rua@netcontrol.live' },
    { sender: 'NoReply@NetControl.Live', email: '', recipient: 'b@x.com' }
  ];
  const kept = filterToSender(rows, 'noreply@netcontrol.live');
  expect(kept).toHaveLength(2);
  expect(kept.map(r => r.recipient)).toEqual(['a@x.com', 'b@x.com']);
});

test('correlateRow matches recipient + send-time window, closest row wins', () => {
  const t0 = Date.now();
  const logRows = [
    { _id: 'L1', recipient: 'a@x.com', createdAt: new Date(t0) },
    { _id: 'L2', recipient: 'a@x.com', createdAt: new Date(t0 - 10 * 60 * 1000) },
    { _id: 'L3', recipient: 'other@x.com', createdAt: new Date(t0) }
  ];
  // EmailTrack times are unix SECONDS
  const hit = correlateRow({ recipient: 'A@X.com', sendunixtime: Math.floor(t0 / 1000) - 60 }, logRows);
  expect(hit._id).toBe('L1');
  // outside the 15-min window → no match
  const miss = correlateRow({ recipient: 'a@x.com', sendunixtime: Math.floor(t0 / 1000) - 3600 }, logRows.slice(0, 1));
  expect(miss).toBeNull();
});
