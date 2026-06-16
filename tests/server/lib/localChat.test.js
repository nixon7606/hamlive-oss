/**
 * Integration tests for localChat.js
 *
 * Uses jest.mock() to inject test schemas into the model modules,
 * then runs against mongodb-memory-server.
 */
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-localchat';

// Set up test upload directory
const TEST_UPLOAD_DIR = path.join(__dirname, '../../.test-uploads/chat');
process.env.CHAT_UPLOAD_DIR = TEST_UPLOAD_DIR;

const { Schema } = mongoose;

// Define test schemas that match the real ones but use test model names
const testChatMessageSchema = new Schema({
  netProfile: { type: Schema.Types.ObjectId, ref: 'mockNetProfile', required: true, index: true },
  liveNet: { type: Schema.Types.ObjectId, ref: 'mockLiveNet', required: true, index: true },
  userProfile: { type: Schema.Types.ObjectId, ref: 'TestUserProfile', required: true },
  callSign: { type: String, required: true, maxlength: 10 },
  displayName: { type: String, maxlength: 30, default: '' },
  text: { type: String, maxlength: 500, default: '' },
  deleted: { type: Boolean, default: false, index: true },
  edited: { type: Boolean, default: false },
  pinned: { type: Boolean, default: false },
  editedAt: { type: Date, default: null },
  imageUrl: { type: String, default: null },
  reactions: { type: Map, of: [{ type: Schema.Types.ObjectId, ref: 'TestUserProfile' }], default: new Map() },
  parentMessage: { type: Schema.Types.ObjectId, ref: 'TestChatMessage', default: null, index: true },
  replyCount: { type: Number, default: 0 }
}, { timestamps: true });

const testChatBanSchema = new Schema({
  netProfile: { type: Schema.Types.ObjectId, ref: 'mockNetProfile', required: true, index: true },
  userProfile: { type: Schema.Types.ObjectId, ref: 'TestUserProfile', required: true },
  callSign: { type: String, required: true, maxlength: 10 },
  reason: { type: String, required: true, maxlength: 200, default: 'No reason given' },
  bannedBy: {
    callSign: { type: String, required: true },
    userProfile: { type: Schema.Types.ObjectId, ref: 'TestUserProfile' }
  },
  unbannedAt: { type: Date, default: null },
  unbannedBy: {
    callSign: { type: String },
    userProfile: { type: Schema.Types.ObjectId, ref: 'TestUserProfile' }
  },
  expiresAt: { type: Date, default: null },
}, { timestamps: true });

const testNetProfileSchema = new Schema({ title: String });
const testLiveNetSchema = new Schema({
  netProfile: { type: Schema.Types.ObjectId, ref: 'mockNetProfile' },
  closing: { type: Boolean, default: false }
});
const testStationInteractionSchema = new Schema({
  liveNet: { type: Schema.Types.ObjectId, ref: 'mockLiveNet' },
  userProfile: { type: Schema.Types.ObjectId, ref: 'TestUserProfile' },
  role: { type: String, default: 'netuser' }
});

// Register test models with 'mock' prefix (jest allows mock-prefixed vars in jest.mock factories)
const mockChatMessage = mongoose.model('MockChatMessage', testChatMessageSchema);
const mockChatBan = mongoose.model('MockChatBan', testChatBanSchema);
const mockNetProfile = mongoose.model('MockNetProfile', testNetProfileSchema);
const mockLiveNet = mongoose.model('MockLiveNet', testLiveNetSchema);
const mockStationInteraction = mongoose.model('MockStationInteraction', testStationInteractionSchema);

// Mock localChat's model loading to use our test models
jest.mock('../../../server/dist/models/chatMessage', () => ({
  getChatMessage: jest.fn(() => mockChatMessage)
}));
jest.mock('../../../server/dist/models/chatBan', () => ({
  getChatBan: jest.fn(() => mockChatBan)
}));
jest.mock('../../../server/dist/models/netProfile', () => ({
  getNetProfile: jest.fn(() => mockNetProfile)
}));
jest.mock('../../../server/dist/models/liveNet', () => ({
  getLiveNet: jest.fn(() => mockLiveNet)
}));
jest.mock('../../../server/dist/models/stationInteraction', () => ({
  getStationInteraction: jest.fn(() => mockStationInteraction)
}));

// Mock sseChat logger to avoid noise
jest.mock('../../../server/dist/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const localChat = require('../../../server/dist/lib/localChat');
const { chatBroadcaster } = require('../../../server/dist/lib/sseChat');

let npid, userId, ncsId;

beforeAll(async () => {
  await mongoose.connect(MONGO_URI);
  if (!fs.existsSync(TEST_UPLOAD_DIR)) {
    fs.mkdirSync(TEST_UPLOAD_DIR, { recursive: true });
  }
});

afterAll(async () => {
  if (fs.existsSync(TEST_UPLOAD_DIR)) {
    fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
  }
  await mongoose.disconnect();
});

beforeEach(async () => {
  // Clean all collections
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }

  // Create fresh test data for each test
  const net = await mockNetProfile.create({ title: 'Test Net' });
  npid = net._id.toString();

  const liveNet = await mockLiveNet.create({ netProfile: net._id, closing: false });
  await mockStationInteraction.create({
    liveNet: liveNet._id,
    userProfile: new mongoose.Types.ObjectId(ncsId || undefined),
    role: 'netcontrol'
  });

  userId = new mongoose.Types.ObjectId().toString();
  ncsId = new mongoose.Types.ObjectId().toString();

  // Create NCS station interaction
  await mockStationInteraction.create({
    liveNet: liveNet._id,
    userProfile: new mongoose.Types.ObjectId(ncsId),
    role: 'netcontrol'
  });
});

const mockUser = (id, callsign = 'N0AD', displayName = 'Wayne') => ({
  _id: new mongoose.Types.ObjectId(id),
  callSign: callsign,
  displayName
});

const mockNcs = () => mockUser(ncsId, 'NCS001', 'Net Control');
const mockMember = () => mockUser(userId, 'KD5SPR', 'Bob');

describe('isChatEnabled and helpers', () => {
  test('isChatEnabled returns true', () => {
    expect(localChat.isChatEnabled()).toBe(true);
  });

  test('getChatRoomId returns net- prefixed string', () => {
    const id = localChat.getChatRoomId(npid);
    expect(id).toBe(`net-${npid}`);
  });

  test('createChatChannel returns room info', async () => {
    const result = await localChat.createChatChannel({ npid, netTitle: 'Test', createdById: userId });
    expect(result.roomId).toBe(`net-${npid}`);
  });

  test('deleteChatChannel does not throw', async () => {
    await expect(localChat.deleteChatChannel(npid)).resolves.not.toThrow();
  });
});

describe('sendMessage()', () => {
  test('sends a text message', async () => {
    const result = await localChat.sendMessage({ npid, user: mockMember(), text: 'Hello net!' });
    expect(result).toBeDefined();
    expect(result.callSign).toBe('KD5SPR');
    expect(result.text).toBe('Hello net!');
    expect(result.id).toBeDefined();
    expect(result.netProfile).toBe(npid);
  });

  test('sends an image-only message', async () => {
    const result = await localChat.sendMessage({ npid, user: mockMember(), text: '', imageUrl: '/uploads/chat/test.jpg' });
    expect(result.text).toBe('');
    expect(result.imageUrl).toBe('/uploads/chat/test.jpg');
  });

  test('rejects empty message without text or image', async () => {
    await expect(localChat.sendMessage({ npid, user: mockMember(), text: '' })).rejects.toThrow('message must have text or image');
  });

  test('rejects message from banned user', async () => {
    await localChat.banUser({ npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam', bannedBy: { callSign: 'NCS001', userProfile: ncsId } });
    await expect(localChat.sendMessage({ npid, user: mockMember(), text: 'Should fail' })).rejects.toThrow('banned');
  });

  test('rejects message if net is closing', async () => {
    await mockLiveNet.updateOne({ _id: new mongoose.Types.ObjectId(npid) }, { closing: true });
    // The query in localChat uses findOne({ netProfile: npid }), so update by that
    await mockLiveNet.findOneAndUpdate({ netProfile: npid }, { closing: true });
    await expect(localChat.sendMessage({ npid, user: mockMember(), text: 'Should fail' })).rejects.toThrow('net is closing');
  });

  test('replies to a parent message', async () => {
    const parent = await localChat.sendMessage({ npid, user: mockMember(), text: 'Parent message' });
    const reply = await localChat.sendMessage({ npid, user: mockNcs(), text: 'Reply to parent', parentMessageId: parent.id });
    expect(reply.parentMessage).toBe(parent.id);
  });

  test('rejects reply to non-existent parent', async () => {
    await expect(localChat.sendMessage({ npid, user: mockMember(), text: 'Reply', parentMessageId: new mongoose.Types.ObjectId().toString() })).rejects.toThrow('parent message not found');
  });

  test('rejects message longer than 500 chars', async () => {
    await expect(localChat.sendMessage({ npid, user: mockMember(), text: 'x'.repeat(501) })).rejects.toThrow('max 500 chars');
  });

  test('rejects message from missing user', async () => {
    await expect(localChat.sendMessage({ npid, user: null, text: 'Test' })).rejects.toThrow('missing user');
  });
});

describe('editMessage()', () => {
  test('edits own message', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Original' });
    const edited = await localChat.editMessage({ npid, messageId: msg.id, user: mockMember(), newText: 'Edited' });
    expect(edited.text).toBe('Edited');
    expect(edited.edited).toBe(true);
  });

  test('rejects edit by different user', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Original' });
    await expect(localChat.editMessage({ npid, messageId: msg.id, user: mockNcs(), newText: 'Hacked' })).rejects.toThrow('not your message');
  });

  // Regression: an edit must broadcast via broadcastUpdate ('chat-update' →
  // client updates in place), NOT the generic broadcast ('chat-message' →
  // client appends a NEW message, duplicating it).
  test('broadcasts an edit as an update, not a new message', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Original' });
    const updateSpy = jest.spyOn(chatBroadcaster, 'broadcastUpdate').mockImplementation(() => {});
    const newSpy = jest.spyOn(chatBroadcaster, 'broadcast').mockImplementation(() => {});
    try {
      await localChat.editMessage({ npid, messageId: msg.id, user: mockMember(), newText: 'Edited' });
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(newSpy).not.toHaveBeenCalled();
      const [, data] = updateSpy.mock.calls[0];
      expect(data.id).toBe(msg.id);
      expect(data.text).toBe('Edited');
    } finally {
      updateSpy.mockRestore();
      newSpy.mockRestore();
    }
  });
});

describe('toggleReaction()', () => {
  test('adds a reaction', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'React to me' });
    const result = await localChat.toggleReaction({ npid, messageId: msg.id, user: mockMember(), reactionType: 'like' });
    expect(result.action).toBe('added');
  });

  test('removes a reaction on second toggle', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Toggle me' });
    await localChat.toggleReaction({ npid, messageId: msg.id, user: mockMember(), reactionType: 'like' });
    const result = await localChat.toggleReaction({ npid, messageId: msg.id, user: mockMember(), reactionType: 'like' });
    expect(result.action).toBe('removed');
  });

  test('rejects invalid reaction type', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Test' });
    await expect(localChat.toggleReaction({ npid, messageId: msg.id, user: mockMember(), reactionType: 'invalid' })).rejects.toThrow('invalid reaction type');
  });

  // Regression: toggleReaction reads the message via a non-lean findById, so
  // msg.reactions is a Mongoose Map. buildMessagePayload used Object.entries(),
  // which returns [] for a Map — the broadcast carried empty reactions and the
  // like never appeared live for other clients.
  test('broadcasts the reaction (Map serialized, not dropped)', async () => {
    const spy = jest.spyOn(chatBroadcaster, 'broadcastReaction').mockImplementation(() => {});
    try {
      const member = mockMember();
      const msg = await localChat.sendMessage({ npid, user: member, text: 'Like this' });
      await localChat.toggleReaction({ npid, messageId: msg.id, user: member, reactionType: 'like' });

      expect(spy).toHaveBeenCalledTimes(1);
      const [, data] = spy.mock.calls[0];
      expect(data.reactions.like).toBeDefined();
      expect(data.reactions.like).toContain(member._id.toString());
    } finally {
      spy.mockRestore();
    }
  });
});

describe('getMessages()', () => {
  test('returns messages for net', async () => {
    await localChat.sendMessage({ npid, user: mockMember(), text: 'Msg 1' });
    await localChat.sendMessage({ npid, user: mockNcs(), text: 'Msg 2' });
    const msgs = await localChat.getMessages({ npid });
    expect(msgs.length).toBe(2);
  });

  test('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await localChat.sendMessage({ npid, user: mockMember(), text: `Msg ${i}` });
    }
    const msgs = await localChat.getMessages({ npid, limit: 3 });
    expect(msgs.length).toBe(3);
  });

  test('filters deleted messages', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Delete me' });
    await localChat.deleteMessage({ npid, messageId: msg.id, moderatorCallsign: 'NCS001', userProfileId: ncsId });
    const msgs = await localChat.getMessages({ npid });
    expect(msgs.find(m => m.id === msg.id)).toBeUndefined();
  });

  test('batch-fetches parent details for replies', async () => {
    const parent = await localChat.sendMessage({ npid, user: mockMember(), text: 'Parent' });
    const reply = await localChat.sendMessage({ npid, user: mockNcs(), text: 'Reply', parentMessageId: parent.id });
    const msgs = await localChat.getMessages({ npid });
    const foundReply = msgs.find(m => m.id === reply.id);
    expect(foundReply.parentMessage).toBe(parent.id);
    expect(foundReply.parentCallSign).toBe('KD5SPR');
  });
});

describe('getChatSession()', () => {
  test('returns session info', async () => {
    const session = await localChat.getChatSession({ npid, user: mockMember() });
    expect(session.enabled).toBe(true);
    expect(session.roomId).toBe(`net-${npid}`);
    expect(session.userId).toBe(userId);
    expect(session.callSign).toBe('KD5SPR');
  });
});

describe('deleteMessage()', () => {
  test('soft-deletes a message (NCS only)', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Delete me' });
    const result = await localChat.deleteMessage({ npid, messageId: msg.id, moderatorCallsign: 'NCS001', userProfileId: ncsId });
    expect(result.success).toBe(true);
  });

  test('rejects deletion by a non-NCS who is not the author', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Delete me' });
    const strangerId = new mongoose.Types.ObjectId().toString();
    await expect(localChat.deleteMessage({
      npid, messageId: msg.id, moderatorCallsign: 'W1AW', userProfileId: strangerId
    })).rejects.toThrow('permissions');
  });

  test('author can delete their own recent message', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'My typo' });
    const result = await localChat.deleteMessage({
      npid, messageId: msg.id, moderatorCallsign: 'KD5SPR', userProfileId: userId
    });
    expect(result.success).toBe(true);
    const msgs = await localChat.getMessages({ npid });
    expect(msgs.find(m => m.id === msg.id)).toBeUndefined();
  });

  test('author cannot delete their own message older than the 15-minute window', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Old message' });
    const old = new Date(Date.now() - 20 * 60 * 1000);
    // Use the native MongoDB collection to bypass Mongoose's immutable createdAt (timestamps: true)
    await mockChatMessage.collection.updateOne({ _id: new mongoose.Types.ObjectId(msg.id) }, { $set: { createdAt: old } });
    await expect(localChat.deleteMessage({
      npid, messageId: msg.id, moderatorCallsign: 'KD5SPR', userProfileId: userId
    })).rejects.toThrow('15 minutes');
    const msgs = await localChat.getMessages({ npid });
    expect(msgs.find(m => m.id === msg.id)).toBeDefined();
  });

  test('NCS can delete a message older than the 15-minute window', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Old message' });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await mockChatMessage.collection.updateOne({ _id: new mongoose.Types.ObjectId(msg.id) }, { $set: { createdAt: old } });
    const result = await localChat.deleteMessage({
      npid, messageId: msg.id, moderatorCallsign: 'NCS001', userProfileId: ncsId
    });
    expect(result.success).toBe(true);
  });
});

describe('Ban/Unban', () => {
  test('banUser creates a ban record', async () => {
    const ban = await localChat.banUser({ npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam', bannedBy: { callSign: 'NCS001', userProfile: ncsId } });
    expect(ban.callSign).toBe('KD5SPR');
    expect(ban.reason).toBe('Spam');
    expect(ban.expiresAt).toBeNull();
  });

  test('checkIsBanned returns null for unbanned user', async () => {
    const result = await localChat.checkIsBanned({ npid, userProfileId: userId });
    expect(result).toBeNull();
  });

  test('checkIsBanned returns ban for banned user', async () => {
    await localChat.banUser({ npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam', bannedBy: { callSign: 'NCS001', userProfile: ncsId } });
    const result = await localChat.checkIsBanned({ npid, userProfileId: userId });
    expect(result).not.toBeNull();
    expect(result.reason).toBe('Spam');
  });

  test('prevents duplicate bans', async () => {
    await localChat.banUser({ npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'First', bannedBy: { callSign: 'NCS001', userProfile: ncsId } });
    await expect(localChat.banUser({ npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Second', bannedBy: { callSign: 'NCS001', userProfile: ncsId } })).rejects.toThrow('already banned');
  });

  test('unbanUser removes ban', async () => {
    await localChat.banUser({ npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam', bannedBy: { callSign: 'NCS001', userProfile: ncsId } });
    await localChat.unbanUser({ npid, userProfileId: userId, callSign: 'KD5SPR', unbannedBy: { callSign: 'NCS002', userProfile: ncsId } });
    const result = await localChat.checkIsBanned({ npid, userProfileId: userId });
    expect(result).toBeNull();
  });

  test('banUser persists expiresAt', async () => {
    const when = new Date(Date.now() + 3600_000);
    const ban = await localChat.banUser({
      npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam',
      bannedBy: { callSign: 'NCS001', userProfile: ncsId },
      expiresAt: when
    });
    expect(ban.expiresAt?.getTime()).toBe(when.getTime());
  });

  test('getBannedUsers returns active bans', async () => {
    await localChat.banUser({ npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam', bannedBy: { callSign: 'NCS001', userProfile: ncsId } });
    const bans = await localChat.getBannedUsers(npid);
    expect(bans.length).toBe(1);
    expect(bans[0].callSign).toBe('KD5SPR');
  });

  test('checkIsBanned ignores an expired ban', async () => {
    await localChat.banUser({
      npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam',
      bannedBy: { callSign: 'NCS001', userProfile: ncsId },
      expiresAt: new Date(Date.now() - 60_000) // expired 1 min ago
    });
    const result = await localChat.checkIsBanned({ npid, userProfileId: userId });
    expect(result).toBeNull();
  });

  test('checkIsBanned honors a future-dated ban', async () => {
    await localChat.banUser({
      npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam',
      bannedBy: { callSign: 'NCS001', userProfile: ncsId },
      expiresAt: new Date(Date.now() + 60_000) // expires in 1 min
    });
    const result = await localChat.checkIsBanned({ npid, userProfileId: userId });
    expect(result).not.toBeNull();
  });

  test('getBannedUsers excludes expired bans', async () => {
    await localChat.banUser({
      npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam',
      bannedBy: { callSign: 'NCS001', userProfile: ncsId },
      expiresAt: new Date(Date.now() - 60_000)
    });
    const bans = await localChat.getBannedUsers(npid);
    expect(bans).toHaveLength(0);
  });
});

describe('banFromMessage()', () => {
  test('NCS bans the author of a message', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'spammy' });
    const result = await localChat.banFromMessage({
      npid, messageId: msg.id, reason: 'Disruptive',
      moderator: { callSign: 'NCS001', userProfile: ncsId, userProfileId: ncsId }
    });
    expect(result.callSign).toBe('KD5SPR');
    const banned = await localChat.checkIsBanned({ npid, userProfileId: userId });
    expect(banned).not.toBeNull();
    expect(banned.reason).toBe('Disruptive');
  });

  test('non-moderator cannot ban', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'hi' });
    await expect(localChat.banFromMessage({
      npid, messageId: msg.id, reason: 'x',
      moderator: { callSign: 'KD5SPR', userProfile: userId, userProfileId: userId }
    })).rejects.toThrow(/only NCS|permission/i);
  });

  test('cannot ban yourself', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockNcs(), text: 'mine' });
    await expect(localChat.banFromMessage({
      npid, messageId: msg.id, reason: 'x',
      moderator: { callSign: 'NCS001', userProfile: ncsId, userProfileId: ncsId }
    })).rejects.toThrow(/yourself/i);
  });

  test('passes expiresAt through to the ban', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'spammy' });
    const when = new Date(Date.now() + 3600_000).toISOString();
    await localChat.banFromMessage({
      npid, messageId: msg.id, reason: 'Disruptive', expiresAt: when,
      moderator: { callSign: 'NCS001', userProfile: ncsId, userProfileId: ncsId }
    });
    const banned = await localChat.checkIsBanned({ npid, userProfileId: userId });
    expect(new Date(banned.expiresAt).getTime()).toBe(new Date(when).getTime());
  });
});

describe('broadcastTyping()', () => {
  test('broadcasts typing event without throwing', () => {
    expect(() => localChat.broadcastTyping({ npid, callSign: 'KD5SPR', isTyping: true })).not.toThrow();
  });
});

describe('getThreadMessages()', () => {
  test('returns replies for a parent message', async () => {
    const parent = await localChat.sendMessage({ npid, user: mockMember(), text: 'Parent' });
    await localChat.sendMessage({ npid, user: mockNcs(), text: 'Reply 1', parentMessageId: parent.id });
    await localChat.sendMessage({ npid, user: mockMember(), text: 'Reply 2', parentMessageId: parent.id });
    const replies = await localChat.getThreadMessages({ parentMessageId: parent.id });
    expect(replies.length).toBe(2);
  });
});

describe('uploadImage()', () => {
  test('rejects invalid file type', async () => {
    const file = { originalname: 'test.txt', mimetype: 'text/plain', buffer: Buffer.from('not an image') };
    await expect(localChat.uploadImage(file)).rejects.toThrow('invalid file type');
  });

  test('accepts valid image', async () => {
    // Buffer must begin with real JPEG magic bytes (FF D8 FF) — uploadImage now
    // validates file content, not just the extension/MIME.
    const buffer = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('fake-jpeg-data')]);
    const file = { originalname: 'test.jpg', mimetype: 'image/jpeg', buffer };
    const url = await localChat.uploadImage(file);
    expect(url).toMatch(/^\/uploads\/chat\/.+\.jpg$/);
  });

  test('rejects disallowed extension', async () => {
    const file = { originalname: 'test.svg', mimetype: 'image/jpeg', buffer: Buffer.from('test') };
    await expect(localChat.uploadImage(file)).rejects.toThrow('invalid extension');
  });

  test('rejects missing file', async () => {
    await expect(localChat.uploadImage(null)).rejects.toThrow('no file provided');
  });
});

describe('pinMessage / unpinMessage', () => {
  const ncsMod = () => ({ callSign: 'NCS001', userProfile: ncsId, userProfileId: ncsId });

  test('NCS pins a message; pinning another replaces it (single pin)', async () => {
    const a = await localChat.sendMessage({ npid, user: mockMember(), text: 'first' });
    const b = await localChat.sendMessage({ npid, user: mockMember(), text: 'second' });
    await localChat.pinMessage({ npid, messageId: a.id, moderator: ncsMod() });
    await localChat.pinMessage({ npid, messageId: b.id, moderator: ncsMod() });
    const pinned = await mockChatMessage.find({ pinned: true });
    expect(pinned.map(d => d._id.toString())).toEqual([b.id]);
  });

  test('non-NCS cannot pin', async () => {
    const m = await localChat.sendMessage({ npid, user: mockMember(), text: 'x' });
    await expect(localChat.pinMessage({
      npid, messageId: m.id,
      moderator: { callSign: 'KD5SPR', userProfile: userId, userProfileId: userId }
    })).rejects.toThrow(/only NCS|permission/i);
  });

  test('pinMessage broadcasts chat-pin with the message payload', async () => {
    const m = await localChat.sendMessage({ npid, user: mockMember(), text: 'pin me' });
    const spy = jest.spyOn(chatBroadcaster, 'broadcastPin').mockImplementation(() => {});
    try {
      await localChat.pinMessage({ npid, messageId: m.id, moderator: ncsMod() });
      expect(spy).toHaveBeenCalledTimes(1);
      const [, payload] = spy.mock.calls[0];
      expect(payload.id).toBe(m.id);
    } finally { spy.mockRestore(); }
  });

  test('unpinMessage clears the pin and broadcasts chat-unpin', async () => {
    const m = await localChat.sendMessage({ npid, user: mockMember(), text: 'pin me' });
    await localChat.pinMessage({ npid, messageId: m.id, moderator: ncsMod() });
    const spy = jest.spyOn(chatBroadcaster, 'broadcastUnpin').mockImplementation(() => {});
    try {
      await localChat.unpinMessage({ npid, messageId: m.id, moderator: ncsMod() });
      const pinned = await mockChatMessage.find({ pinned: true });
      expect(pinned).toHaveLength(0);
      expect(spy).toHaveBeenCalledTimes(1);
      const [, data] = spy.mock.calls[0];
      expect(data.messageId).toBe(m.id);
    } finally { spy.mockRestore(); }
  });
});

describe('pinned message: session + delete', () => {
  const ncsMod = () => ({ callSign: 'NCS001', userProfile: ncsId, userProfileId: ncsId });

  test('getChatSession returns the current pinned message (or null)', async () => {
    const none = await localChat.getChatSession({ npid, user: mockNcs() });
    expect(none.pinnedMessage).toBeNull();
    const m = await localChat.sendMessage({ npid, user: mockMember(), text: 'announce' });
    await localChat.pinMessage({ npid, messageId: m.id, moderator: ncsMod() });
    const session = await localChat.getChatSession({ npid, user: mockNcs() });
    expect(session.pinnedMessage).not.toBeNull();
    expect(session.pinnedMessage.id).toBe(m.id);
  });

  test('deleting a pinned message broadcasts chat-unpin', async () => {
    const m = await localChat.sendMessage({ npid, user: mockNcs(), text: 'pinned then deleted' });
    await localChat.pinMessage({ npid, messageId: m.id, moderator: ncsMod() });
    const spy = jest.spyOn(chatBroadcaster, 'broadcastUnpin').mockImplementation(() => {});
    try {
      await localChat.deleteMessage({ npid, messageId: m.id, moderatorCallsign: 'NCS001', userProfileId: ncsId });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  test('author self-deleting their own pinned message triggers unpin broadcast', async () => {
    // Send as the member (userId is the author), pin as NCS, then delete as the author
    const m = await localChat.sendMessage({ npid, user: mockMember(), text: 'my pinned message' });
    await localChat.pinMessage({ npid, messageId: m.id, moderator: ncsMod() });
    const spy = jest.spyOn(chatBroadcaster, 'broadcastUnpin').mockImplementation(() => {});
    try {
      const result = await localChat.deleteMessage({
        npid, messageId: m.id, moderatorCallsign: 'KD5SPR', userProfileId: userId
      });
      expect(result.success).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      const [, data] = spy.mock.calls[0];
      expect(data.messageId).toBe(m.id);
    } finally { spy.mockRestore(); }
  });
});