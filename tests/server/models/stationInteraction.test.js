/* hamlive-oss — MIT License. See LICENSE. */
/**
 * StationInteraction createdBy enum — the scheduled-net auto-starter creates a
 * net-control interaction with createdBy: 'scheduler', which must be a valid
 * value or the net never starts (validation error).
 */
const mongoose = require('mongoose');
const { getStationInteraction } = require('../../../server/dist/models/stationInteraction');

const StationInteraction = getStationInteraction(); // default mongoose model; validateSync needs no DB

const baseDoc = (createdBy) => new StationInteraction({
  callSign: 'N0AD',
  role: 'netcontrol',
  netProfile: new mongoose.Types.ObjectId(),
  userProfile: new mongoose.Types.ObjectId(),
  createdBy
});

test("createdBy 'scheduler' passes validation (used by the auto-starter)", () => {
  const err = baseDoc('scheduler').validateSync();
  expect(err?.errors?.createdBy).toBeUndefined();
});

test("createdBy 'user' and 'admin' still pass", () => {
  expect(baseDoc('user').validateSync()?.errors?.createdBy).toBeUndefined();
  expect(baseDoc('admin').validateSync()?.errors?.createdBy).toBeUndefined();
});

test('an unknown createdBy is still rejected', () => {
  const err = baseDoc('banana').validateSync();
  expect(err?.errors?.createdBy).toBeDefined();
});
