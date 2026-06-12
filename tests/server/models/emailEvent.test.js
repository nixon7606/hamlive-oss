const mongoose = require('mongoose');
const { emailEventSchema } = require('../../../server/dist/models/emailEvent');
const EmailEvent = mongoose.model('EmailEvent', emailEventSchema);
const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-emailevent';

beforeAll(async () => { await mongoose.connect(MONGO_URI); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(async () => { await EmailEvent.deleteMany({}); });

test('sgEventId is unique (idempotent inserts)', async () => {
  await EmailEvent.syncIndexes();
  await EmailEvent.create({ sgEventId: 'evt1', batchId: 'b1', email: 'a@b.com', event: 'delivered' });
  await expect(
    EmailEvent.create({ sgEventId: 'evt1', batchId: 'b1', email: 'a@b.com', event: 'delivered' })
  ).rejects.toThrow();
});
