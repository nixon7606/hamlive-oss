/**
 * Tests for ChatMessage Mongoose model.
 * Uses mongodb-memory-server for isolated test DB.
 */
const mongoose = require('mongoose');
const { chatMessageSchema } = require('../../../server/dist/models/chatMessage');
const { chatBanSchema } = require('../../../server/dist/models/chatBan');

// Register models before connecting
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
mongoose.model('ChatBan', chatBanSchema);

const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-models';

const mockNetProfileId = new mongoose.Types.ObjectId();
const mockLiveNetId = new mongoose.Types.ObjectId();
const mockUserProfileId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await mongoose.connect(MONGO_URI);
});

afterAll(async () => {
  await mongoose.disconnect();
});

beforeEach(async () => {
  await ChatMessage.deleteMany({});
});

describe('ChatMessage Schema Validation', () => {
  const validMessage = () => ({
    netProfile: mockNetProfileId,
    liveNet: mockLiveNetId,
    userProfile: mockUserProfileId,
    callSign: 'N0AD',
    displayName: 'Wayne',
    text: 'Hello, net!'
  });

  test('creates a valid message', async () => {
    const msg = await ChatMessage.create(validMessage());
    expect(msg).toBeDefined();
    expect(msg.callSign).toBe('N0AD');
    expect(msg.text).toBe('Hello, net!');
    expect(msg.deleted).toBe(false);
    expect(msg.edited).toBe(false);
    expect(msg.replyCount).toBe(0);
    expect(msg.imageUrl).toBeNull();
    expect(msg.createdAt).toBeDefined();
    expect(msg.updatedAt).toBeDefined();
  });

  test('rejects missing netProfile', async () => {
    const data = validMessage();
    delete data.netProfile;
    await expect(ChatMessage.create(data)).rejects.toThrow();
  });

  test('rejects missing liveNet', async () => {
    const data = validMessage();
    delete data.liveNet;
    await expect(ChatMessage.create(data)).rejects.toThrow();
  });

  test('rejects missing userProfile', async () => {
    const data = validMessage();
    delete data.userProfile;
    await expect(ChatMessage.create(data)).rejects.toThrow();
  });

  test('rejects callSign longer than 10 chars', async () => {
    const data = validMessage();
    data.callSign = 'VERYLONGCALL';
    await expect(ChatMessage.create(data)).rejects.toThrow('maximum allowed length');
  });

  test('rejects text longer than 500 chars', async () => {
    const data = validMessage();
    data.text = 'x'.repeat(501);
    await expect(ChatMessage.create(data)).rejects.toThrow('maximum allowed length');
  });

  test('sets default values correctly', async () => {
    const msg = await ChatMessage.create(validMessage());
    expect(msg.deleted).toBe(false);
    expect(msg.edited).toBe(false);
    expect(msg.replyCount).toBe(0);
    expect(msg.imageUrl).toBeNull();
    expect(msg.parentMessage).toBeNull();
    expect(msg.displayName).toBe('Wayne');
  });

  test('creates message with parent reference', async () => {
    const parent = await ChatMessage.create(validMessage());
    const reply = await ChatMessage.create({
      ...validMessage(),
      text: 'Reply to parent',
      parentMessage: parent._id
    });
    expect(reply.parentMessage.toString()).toBe(parent._id.toString());
  });

  test('creates message with imageUrl', async () => {
    const msg = await ChatMessage.create({
      ...validMessage(),
      text: '',
      imageUrl: '/uploads/chat/test.jpg'
    });
    expect(msg.imageUrl).toBe('/uploads/chat/test.jpg');
    expect(msg.text).toBe('');
  });

  test('populates timestamps on create', async () => {
    const msg = await ChatMessage.create(validMessage());
    expect(msg.createdAt).toBeInstanceOf(Date);
    expect(msg.updatedAt).toBeInstanceOf(Date);
    expect(msg.createdAt.getTime()).toBeGreaterThan(0);
  });

  test('supports reactions Map', async () => {
    const msg = await ChatMessage.create(validMessage());
    expect(msg.reactions).toBeDefined();
    // Default should be empty Map-like object
    expect(typeof msg.reactions).toBe('object');
  });

  test('supports soft delete', async () => {
    const msg = await ChatMessage.create(validMessage());
    msg.deleted = true;
    await msg.save();
    const found = await ChatMessage.findById(msg._id);
    expect(found.deleted).toBe(true);
  });

  test('supports edit tracking', async () => {
    const msg = await ChatMessage.create(validMessage());
    msg.edited = true;
    msg.editedAt = new Date();
    await msg.save();
    const found = await ChatMessage.findById(msg._id);
    expect(found.edited).toBe(true);
    expect(found.editedAt).toBeInstanceOf(Date);
  });

  test('supports replyCount increment', async () => {
    const msg = await ChatMessage.create(validMessage());
    msg.replyCount = 3;
    await msg.save();
    const found = await ChatMessage.findById(msg._id);
    expect(found.replyCount).toBe(3);
  });
});