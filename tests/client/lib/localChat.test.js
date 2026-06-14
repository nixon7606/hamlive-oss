/**
 * Tests for LocalChatConnection client transport layer.
 * Tests the fetch-based API wrapper and SSE connection handling.
 */
const mongoose = require('mongoose');

// Mock global fetch before loading modules
global.fetch = jest.fn();

// Mock EventSource for SSE tests
class MockEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.listeners = {};
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.dispatchEvent({ type: 'open' });
    }, 10);
  }
  addEventListener(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }
  dispatchEvent(event) {
    const handlers = this.listeners[event.type] || [];
    handlers.forEach(fn => fn(event));
  }
  close() {
    this.readyState = 2; // CLOSED
  }
}
global.EventSource = MockEventSource;

// Clear all mocks between tests
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch.mockReset();
});

describe('LocalChatConnection', () => {
  // We can't import TypeScript directly in jest without ts-jest configured,
  // so we test the compiled JS output
  let LocalChatConnection;

  beforeAll(async () => {
    // The compiled JS is in client/dist/public/js/lib/localChat.js
    const mod = require('../../client/dist/public/js/lib/localChat');
    LocalChatConnection = mod.LocalChatConnection;
  });

  test('constructor creates instance with default npid', () => {
    const conn = new LocalChatConnection();
    expect(conn).toBeDefined();
    expect(conn.npid).toBeDefined();
  });

  test('constructor accepts custom npid', () => {
    const conn = new LocalChatConnection('custom-npid');
    expect(conn.npid).toBe('custom-npid');
  });

  test('getSession() calls /api/chat/{npid}/session', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { enabled: true, userId: 'u1', callSign: 'N0AD', roomId: 'net-x' } })
    });

    const conn = new LocalChatConnection('test-net');
    const session = await conn.getSession();

    expect(global.fetch).toHaveBeenCalledWith('/api/chat/test-net/session');
    expect(session.enabled).toBe(true);
    expect(session.callSign).toBe('N0AD');
  });

  test('getSession() returns null on error', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Not found' })
    });

    const conn = new LocalChatConnection('test-net');
    const session = await conn.getSession();
    expect(session).toBeNull();
  });

  test('getSession() returns null on network error', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network error'));

    const conn = new LocalChatConnection('test-net');
    const session = await conn.getSession();
    expect(session).toBeNull();
  });

  test('connect() creates EventSource', () => {
    const conn = new LocalChatConnection('test-net');
    conn._session = { userId: 'u1', callSign: 'N0AD' };

    conn.connect();

    expect(conn.eventSource).toBeDefined();
    expect(conn.eventSource.url).toContain('/api/chat/test-net/sse');
  });

  test('connect() is no-op when no session', () => {
    const conn = new LocalChatConnection('test-net');
    conn.connect();
    expect(conn.eventSource).toBeUndefined();
  });

  test('sendMessage() POSTs to /api/chat/{npid}/send', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { id: 'm1', text: 'Hello', callSign: 'N0AD' } })
    });

    const conn = new LocalChatConnection('test-net');
    const result = await conn.sendMessage('Hello');

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/test-net/send',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello', imageUrl: null, parentMessageId: null })
      })
    );
    expect(result.text).toBe('Hello');
  });

  test('sendMessage() sends with parentMessageId', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { id: 'm2', text: 'Reply' } })
    });

    const conn = new LocalChatConnection('test-net');
    await conn.sendMessage('Reply', 'parent-123');

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.parentMessageId).toBe('parent-123');
  });

  test('sendMessage() returns null on error', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Banned' })
    });

    const conn = new LocalChatConnection('test-net');
    const result = await conn.sendMessage('Hello');
    expect(result).toBeNull();
  });

  test('getMessages() fetches and returns messages', async () => {
    const msgs = [{ id: 'm1', text: 'Hi' }, { id: 'm2', text: 'There' }];
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { messages: msgs } })
    });

    const conn = new LocalChatConnection('test-net');
    const result = await conn.getMessages();
    expect(result).toEqual(msgs);
  });

  test('getMessages() returns empty array on error', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Failed'));

    const conn = new LocalChatConnection('test-net');
    const result = await conn.getMessages();
    expect(result).toEqual([]);
  });

  test('editMessage() PUTs to endpoint', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({})
    });

    const conn = new LocalChatConnection('test-net');
    const result = await conn.editMessage('m1', 'Updated');
    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/test-net/message/m1',
      expect.objectContaining({ method: 'PUT' })
    );
  });

  test('toggleReaction() POSTs to react endpoint', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { action: 'added' } })
    });

    const conn = new LocalChatConnection('test-net');
    await conn.toggleReaction('m1', 'like');

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/test-net/message/m1/react',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reactionType: 'like' })
      })
    );
  });

  test('deleteMessage() DELETEs message', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { success: true } })
    });

    const conn = new LocalChatConnection('test-net');
    const result = await conn.deleteMessage('m1');
    expect(result).toBe(true);
  });

  test('sendTyping() POSTs typing endpoint', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const conn = new LocalChatConnection('test-net');
    await conn.sendTyping(true);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/test-net/typing',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ isTyping: true })
      })
    );
  });

  test('sendImage() uploads via FormData', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { id: 'img1', imageUrl: '/uploads/chat/test.jpg' } })
    });

    const conn = new LocalChatConnection('test-net');
    const file = new Blob(['fake-image'], { type: 'image/jpeg' });
    file.name = 'test.jpg';
    const result = await conn.sendImage(file);

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/test-net/upload',
      expect.objectContaining({ method: 'POST' })
    );
    // Should use FormData
    const callBody = global.fetch.mock.calls[0][1].body;
    expect(callBody instanceof FormData).toBe(true);
    expect(result.imageUrl).toBe('/uploads/chat/test.jpg');
  });

  test('getReplies() fetches thread replies', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { messages: [{ id: 'r1', text: 'Reply' }] } })
    });

    const conn = new LocalChatConnection('test-net');
    const result = await conn.getReplies('parent-1');
    expect(result).toEqual([{ id: 'r1', text: 'Reply' }]);
  });

  test('getSession() stores session and callSign', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { enabled: true, userId: 'u1', callSign: 'N0AD' } })
    });

    const conn = new LocalChatConnection('test-net');
    await conn.getSession();
    expect(conn._session.callSign).toBe('N0AD');
    expect(conn._session.userId).toBe('u1');
  });

  test('on() registers event handlers', () => {
    const conn = new LocalChatConnection('test-net');
    const handler = jest.fn();
    conn.on('message.new', handler);
    expect(conn._handlers.message.new).toContain(handler);
  });

  test('disconnect() cleans up EventSource', () => {
    const conn = new LocalChatConnection('test-net');
    conn._session = { userId: 'u1' };
    conn.connect();
    conn.disconnect();
    expect(conn.eventSource.readyState).toBe(2); // CLOSED
    expect(conn.eventSource).toBeNull();
  });
});