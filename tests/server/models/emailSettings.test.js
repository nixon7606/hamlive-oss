const mongoose = require('mongoose');
const { emailSettingsSchema, loadEmailSettings, saveEmailSettings, getEmailSettings } = require('../../../server/dist/models/emailSettings');
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-emailsettings';

beforeAll(async () => { await mongoose.connect(MONGO_URI); getEmailSettings(); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await mongoose.model('EmailSettings').deleteMany({}); });

test('loadEmailSettings returns null when unset', async () => {
  expect(await loadEmailSettings()).toBeNull();
});

test('saveEmailSettings upserts a single doc', async () => {
  await saveEmailSettings({ provider: 'smtp', smtp: { host: 'h', port: 587, secure: true, user: 'u', passwordEnc: 'enc' } }, null);
  await saveEmailSettings({ provider: 'console' }, null);
  const all = await mongoose.model('EmailSettings').find({});
  expect(all.length).toBe(1);
  expect(all[0].provider).toBe('console');
  expect(all[0].smtp.host).toBe('h'); // unset fields preserved
});

test('provider enum rejects garbage', async () => {
  await expect(saveEmailSettings({ provider: 'pigeon' }, null)).rejects.toThrow();
});
