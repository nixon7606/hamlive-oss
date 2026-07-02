/* hamlive-oss — MIT License. See LICENSE. */
const express = require('express');
const request = require('supertest');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
let capturedFilter = null;
jest.mock('../../../server/dist/models/userProfile', () => ({
  getUserProfile: () => ({
    find: (f) => { capturedFilter = f; return { select: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) }) }; },
    countDocuments: async () => 0
  })
}));
// adminController pulls in several models at require time; mock the others it touches lazily is unnecessary —
// it only calls them inside handlers we don't hit. If require fails on a missing transitive dep, mock that module the same way.

const { listUsers } = require('../../../server/dist/controllers/adminController');
const app = express();
app.get('/api/admin/users', listUsers);

beforeEach(() => { capturedFilter = null; });

test('status=locked filters on locked:true', async () => {
  await request(app).get('/api/admin/users?status=locked');
  expect(capturedFilter).toEqual({ locked: true });
});

test('status=active excludes locked and flagged', async () => {
  await request(app).get('/api/admin/users?status=active');
  expect(capturedFilter).toEqual({ locked: { $ne: true }, flaggedForDeletion: { $ne: true } });
});

test('status combines with search via $and', async () => {
  await request(app).get('/api/admin/users?status=new&search=abc');
  expect(capturedFilter.$and).toHaveLength(2);
  expect(capturedFilter.$and[1]).toEqual({ newAccount: true });
});

test('absent/unknown status → no status filter', async () => {
  await request(app).get('/api/admin/users');
  expect(capturedFilter).toEqual({});
  await request(app).get('/api/admin/users?status=bogus');
  expect(capturedFilter).toEqual({});
});
