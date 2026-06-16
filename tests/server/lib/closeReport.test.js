/* hamlive-oss — MIT License. See LICENSE. */
/**
 * closeReportHasParticipants — the close-report email is skipped when the only
 * checked-in station was net control (a net nobody else joined).
 */
const { closeReportHasParticipants } = require('../../../server/dist/lib/sharedNetOps');

test('no attendees → no participants', () => {
  expect(closeReportHasParticipants([])).toBe(false);
  expect(closeReportHasParticipants(undefined)).toBe(false);
});

test('only net control checked in → no participants (skip email)', () => {
  expect(closeReportHasParticipants([{ callSign: 'N0AD', role: 'netcontrol' }])).toBe(false);
  expect(closeReportHasParticipants([
    { callSign: 'N0AD', role: 'netcontrol' },
    { callSign: 'W1AW', role: 'netcontrol' } // co-control, still nobody joined
  ])).toBe(false);
});

test('a non-control attendee → has participants (send email)', () => {
  expect(closeReportHasParticipants([
    { callSign: 'N0AD', role: 'netcontrol' },
    { callSign: 'KD5SPR', role: 'netuser' }
  ])).toBe(true);
  expect(closeReportHasParticipants([{ callSign: 'KD5SPR', role: 'netlogger' }])).toBe(true);
});
