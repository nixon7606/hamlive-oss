/**
 * Tests for ChatBan model.
 */
const mongoose = require('mongoose');
const { chatBanSchema } = require('../../../server/dist/models/chatBan');

const ChatBan = mongoose.model('ChatBan', chatBanSchema);

const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-ban';

const mockNetProfileId = new mongoose.Types.ObjectId();
const mockUserProfileId = new mongoose.Types.ObjectId();
const mockBannerId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await mongoose.connect(MONGO_URI);
});

afterAll(async () => {
  // Clean up model registration to avoid conflicts
  delete mongoose.models.ChatBan;
  await mongoose.disconnect();
});

beforeEach(async () => {
  if (mongoose.connection.db) {
    const collections = await mongoose.connection.db.listCollections().toArray();
    for (const col of collections) {
      if (col.name === 'chatbans') {
        await mongoose.connection.db.collection('chatbans').deleteMany({});
      }
    }
  }
});

describe('ChatBan Schema', () => {
  const validBan = () => ({
    netProfile: mockNetProfileId,
    userProfile: mockUserProfileId,
    callSign: 'N0ADN',
    reason: 'Spamming chat',
    bannedBy: {
      callSign: 'NCS001',
      userProfile: mockBannerId
    }
  });

  test('creates a valid ban record', async () => {
    const ban = await ChatBan.create(validBan());
    expect(ban).toBeDefined();
    expect(ban.callSign).toBe('N0ADN');
    expect(ban.reason).toBe('Spamming chat');
    expect(ban.bannedBy.callSign).toBe('NCS001');
    expect(ban.unbannedAt).toBeNull();
    expect(ban.createdAt).toBeDefined();
    expect(ban.updatedAt).toBeDefined();
  });

  test('rejects missing netProfile', async () => {
    const data = validBan();
    delete data.netProfile;
    await expect(ChatBan.create(data)).rejects.toThrow();
  });

  test('rejects missing userProfile', async () => {
    const data = validBan();
    delete data.userProfile;
    await expect(ChatBan.create(data)).rejects.toThrow();
  });

  test('rejects missing callSign', async () => {
    const data = validBan();
    delete data.callSign;
    await expect(ChatBan.create(data)).rejects.toThrow();
  });

  test('uses default reason if not provided', async () => {
    const data = validBan();
    delete data.reason;
    const ban = await ChatBan.create(data);
    expect(ban.reason).toBe('No reason given');
  });

  test('allows unban fields when set', async () => {
    const ban = await ChatBan.create(validBan());
    ban.unbannedAt = new Date();
    ban.unbannedBy = {
      callSign: 'NCS002',
      userProfile: mockBannerId
    };
    await ban.save();
    const found = await ChatBan.findById(ban._id);
    expect(found.unbannedAt).toBeInstanceOf(Date);
    expect(found.unbannedBy.callSign).toBe('NCS002');
  });

  test('enforces maxlength on reason', async () => {
    const data = validBan();
    data.reason = 'x'.repeat(201);
    await expect(ChatBan.create(data)).rejects.toThrow('maximum allowed length');
  });

  test('enforces maxlength on callSign', async () => {
    const data = validBan();
    data.callSign = 'VERYLONGCALL';
    await expect(ChatBan.create(data)).rejects.toThrow('maximum allowed length');
  });
});