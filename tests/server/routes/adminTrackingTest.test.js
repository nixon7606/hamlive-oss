const express = require('express');
const request = require('supertest');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/models/emailSettings', () => ({
  loadEmailSettings: jest.fn()
}));
jest.mock('../../../server/dist/models/adminAudit', () => ({ getAdminAudit: () => ({ create: jest.fn(async () => ({})) }) }));
jest.mock('../../../server/dist/lib/cpanelDeliveryPoller', () => ({
  searchEmailTrack: jest.fn(),
  filterToSender: jest.fn((rows, sender) => (rows || []).filter(r => r.email === sender)),
  resolveSenderAddress: jest.fn(() => 'noreply@netcontrol.live')
}));

const { testTracking } = require('../../../server/dist/controllers/emailAdminController');
const { loadEmailSettings } = require('../../../server/dist/models/emailSettings');
const { searchEmailTrack, filterToSender, resolveSenderAddress } = require('../../../server/dist/lib/cpanelDeliveryPoller');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { _id: '1', email: 'admin@x.com' }; next(); });
app.post('/api/admin/email/tracking/test', testTracking);

const fullTracking = { enabled: true, host: 'cp.example.com', port: 2083, user: 'acct', tokenEnc: 'enc:tok', tlsVerify: true };

test('POST returns ok:true with row count and sender-filtered count on success', async () => {
  loadEmailSettings.mockResolvedValue({ tracking: fullTracking });
  searchEmailTrack.mockResolvedValue([
    { id: 1, email: 'noreply@netcontrol.live' },
    { id: 2, email: 'someone-else@example.com' }
  ]);
  const res = await request(app).post('/api/admin/email/tracking/test');
  expect(res.status).toBe(200);
  expect(res.body.message).toEqual({ ok: true, rows: 2, fromSender: 1 });
  expect(filterToSender).toHaveBeenCalled();
  expect(resolveSenderAddress).toHaveBeenCalled();
});

test('POST returns ok:false with the error message when the search throws', async () => {
  loadEmailSettings.mockResolvedValue({ tracking: fullTracking });
  searchEmailTrack.mockRejectedValue(new Error('EmailTrack HTTP 401'));
  const res = await request(app).post('/api/admin/email/tracking/test');
  expect(res.status).toBe(200);
  expect(res.body.message).toEqual({ ok: false, error: 'EmailTrack HTTP 401' });
});

test('POST returns ok:false when tracking is not fully configured', async () => {
  loadEmailSettings.mockResolvedValue({ tracking: { enabled: true, host: '', user: '', tokenEnc: '' } });
  const res = await request(app).post('/api/admin/email/tracking/test');
  expect(res.status).toBe(200);
  expect(res.body.message).toEqual({ ok: false, error: 'tracking is not fully configured' });
});
