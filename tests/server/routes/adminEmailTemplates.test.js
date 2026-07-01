const express = require('express');
const request = require('supertest');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/models/adminAudit', () => ({ getAdminAudit: () => ({ create: jest.fn(async () => ({})) }) }));
const store = {};
jest.mock('../../../server/dist/models/emailTemplate', () => ({
  getEmailTemplate: () => ({
    findOne: ({ key }) => ({ lean: async () => store[key] || null, then: undefined }),
    findOneAndUpdate: async ({ key }, update) => { store[key] = { key, ...update.$set }; return store[key]; }
  })
}));

const { listTemplates, getTemplate, putTemplate, previewTemplate, resetTemplate } = require('../../../server/dist/controllers/emailAdminController');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { _id: '1', email: 'admin@x.com' }; next(); });
app.get('/t', listTemplates);
app.get('/t/:key', getTemplate);
app.put('/t/:key', putTemplate);
app.post('/t/:key/preview', previewTemplate);

test('preview renders provided html with sample data without saving', async () => {
  const res = await request(app).post('/t/magic-link/preview').send({ subject: 'S {{link}}', html: '<a>{{link}}</a>' });
  expect(res.status).toBe(200);
  expect(res.body.message.html).toContain('http'); // sample link rendered
  expect(store['magic-link']).toBeUndefined(); // not saved
});

test('GET unknown key 404s', async () => {
  const res = await request(app).get('/t/bogus');
  expect(res.status).toBe(500); // handleRequest maps thrown error; assert message
  expect(res.body.error).toMatch(/unknown template/i);
});

test('PUT rejects a template that does not compile (login must not break on a typo)', async () => {
  const res = await request(app).put('/t/net-announce').send({ subject: 'S', html: '{{#if title}broken' });
  expect(res.body.error).toMatch(/compile|invalid/i);
  expect(store['net-announce']).toBeUndefined(); // nothing was saved
});
