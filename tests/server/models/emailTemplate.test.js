const mongoose = require('mongoose');
const { emailTemplateSchema, getEmailTemplate } = require('../../../server/dist/models/emailTemplate');
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-emailtemplate';

beforeAll(async () => { await mongoose.connect(MONGO_URI); await getEmailTemplate().init(); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await mongoose.model('EmailTemplate').deleteMany({}); });

test('stores a template keyed uniquely', async () => {
  const T = getEmailTemplate();
  await T.create({ key: 'magic-link', subject: 'S', html: '<b>{{link}}</b>' });
  await expect(T.create({ key: 'magic-link', subject: 'dup', html: 'x' })).rejects.toThrow();
});

test('rejects an unknown key', async () => {
  await expect(getEmailTemplate().create({ key: 'nope', subject: 'S', html: 'x' })).rejects.toThrow();
});
