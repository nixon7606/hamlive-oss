/**
 * Tests for chat API routes.
 * Uses supertest to test Express routes with mocked auth + models.
 */
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');

const MONGO_URI = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test') + '-routes';
const TEST_UPLOAD_DIR = require('path').join(__dirname, '../../.test-uploads/chat');
process.env.CHAT_UPLOAD_DIR = TEST_UPLOAD_DIR;

const mockUserId = new mongoose.Types.ObjectId();

// Mock auth and models BEFORE requiring the module
jest.mock('../../../server/dist/lib/serverUtils', () => ({
  authCheck: () => (req, res, next) => {
    req.user = {
      _id: mockUserId,
      callSign: 'N0AD',
      displayName: 'Wayne Nixon'
    };
    next();
  },
  REQ_CALLSIGN: 'callsign'
}));

jest.mock('../../../server/dist/lib/responseUtils', () => ({
  handleRequest: (res, fn) => {
    fn().then(result => res.json(result)).catch(err => {
      res.status(400).json({ error: err.message });
    });
  }
}));

// Mock models to prevent OverwriteModelError
const { Schema } = mongoose;
const mockNetProfileSchema = new Schema({ title: String });
const mockLiveNetSchema = new Schema({
  netProfile: { type: Schema.Types.ObjectId, ref: 'MockNetProfile' },
  closing: { type: Boolean, default: false }
});
const mockChatMessageSchema = new Schema({
  netProfile: { type: Schema.Types.ObjectId, ref: 'MockNetProfile', required: true },
  liveNet: { type: Schema.Types.ObjectId, ref: 'MockLiveNet', required: true },
  userProfile: { type: Schema.Types.ObjectId, ref: 'MockUserProfile', required: true },
  callSign: { type: String, required: true },
  displayName: { type: String, default: '' },
  text: { type: String, default: '' },
  imageUrl: { type: String, default: null },
  deleted: { type: Boolean, default: false },
  edited: { type: Boolean, default: false },
  parentMessage: { type: Schema.Types.ObjectId, ref: 'MockChatMessage', default: null },
  replyCount: { type: Number, default: 0 }
}, { timestamps: true });
const mockChatBanSchema = new Schema({
  netProfile: { type: Schema.Types.ObjectId, ref: 'MockNetProfile', required: true },
  userProfile: { type: Schema.Types.ObjectId, ref: 'MockUserProfile', required: true },
  callSign: { type: String, required: true },
  reason: { type: String, default: 'No reason' },
  unbannedAt: { type: Date, default: null }
}, { timestamps: true });
const mockStationInteractionSchema = new Schema({
  liveNet: { type: Schema.Types.ObjectId, ref: 'MockLiveNet' },
  userProfile: { type: Schema.Types.ObjectId, ref: 'MockUserProfile' },
  role: { type: String, default: 'netcontrol' }
});

const mockNetProfile = mongoose.model('MockNetProfile', mockNetProfileSchema);
const mockLiveNet = mongoose.model('MockLiveNet', mockLiveNetSchema);
mongoose.model('MockChatMessage', mockChatMessageSchema);
mongoose.model('MockChatBan', mockChatBanSchema);
mongoose.model('MockStationInteraction', mockStationInteractionSchema);

jest.mock('../../../server/dist/models/netProfile', () => ({ getNetProfile: () => mockNetProfile }));
jest.mock('../../../server/dist/models/liveNet', () => ({ getLiveNet: () => mockLiveNet }));

// Silence logger
jest.mock('../../../server/dist/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const chatRoutes = require('../../../server/dist/routes/chatRoutes');

let app, npid;

beforeAll(async () => {
  await mongoose.connect(MONGO_URI);
  app = express();
  app.use(express.json());
  app.use('/api/chat', chatRoutes);
});

afterAll(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    try { await collections[key].deleteMany({}); } catch (_) {}
  }
  await mongoose.disconnect();
});

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    try { await collections[key].deleteMany({}); } catch (_) {}
  }

  const net = await mockNetProfile.create({ title: 'Test Net' });
  npid = net._id.toString();

  await mockLiveNet.create({ netProfile: net._id, closing: false });
});

describe('GET /api/chat/:id/session', () => {
  test('returns chat session for valid net', async () => {
    const res = await request(app).get(`/api/chat/${npid}/session`);
    expect(res.status).toBe(200);
    expect(res.body.message.enabled).toBe(true);
    expect(res.body.message.callSign).toBe('N0AD');
  });

  test('returns error for invalid NPID format', async () => {
    const res = await request(app).get('/api/chat/not-an-objectid/session');
    expect(res.status).toBe(400);
  });

  test('returns 400 for non-existent net', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app).get(`/api/chat/${fakeId}/session`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Net profile not found');
  });
});

describe('POST /api/chat/:id/send', () => {
  test('sends a message', async () => {
    const res = await request(app)
      .post(`/api/chat/${npid}/send`)
      .send({ text: 'Hello from test' });
    expect(res.status).toBe(200);
    expect(res.body.message.text).toBe('Hello from test');
    expect(res.body.message.callSign).toBe('N0AD');
  });
});

describe('GET /api/chat/:id/messages', () => {
  test('returns empty list when no messages', async () => {
    const res = await request(app).get(`/api/chat/${npid}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.message.messages).toEqual([]);
  });

  test('returns messages after sending', async () => {
    await request(app).post(`/api/chat/${npid}/send`).send({ text: 'Msg 1' });
    await request(app).post(`/api/chat/${npid}/send`).send({ text: 'Msg 2' });

    const res = await request(app).get(`/api/chat/${npid}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.message.messages.length).toBe(2);
  });
});

describe('POST /api/chat/:id/message/:messageId/react', () => {
  test('toggles reaction', async () => {
    const sendRes = await request(app)
      .post(`/api/chat/${npid}/send`)
      .send({ text: 'React to me' });

    const reactRes = await request(app)
      .post(`/api/chat/${npid}/message/${sendRes.body.message.id}/react`)
      .send({ reactionType: 'like' });

    expect(reactRes.status).toBe(200);
    expect(reactRes.body.message.action).toBe('added');
  });
});

describe('PUT /api/chat/:id/message/:messageId', () => {
  test('edits own message', async () => {
    const sendRes = await request(app)
      .post(`/api/chat/${npid}/send`)
      .send({ text: 'Original' });

    const editRes = await request(app)
      .put(`/api/chat/${npid}/message/${sendRes.body.message.id}`)
      .send({ text: 'Edited' });

    expect(editRes.status).toBe(200);
    expect(editRes.body.message.text).toBe('Edited');
    expect(editRes.body.message.edited).toBe(true);
  });
});