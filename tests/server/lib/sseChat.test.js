/**
 * Tests for the custom SSE broadcaster (sseChat.js).
 */
function createMockRes() {
  return {
    writeHead: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(),
    on: jest.fn()
  };
}

const { EventEmitter } = require('events');

function createMockReq() {
  const ee = new EventEmitter();
  return { on: ee.on.bind(ee), emit: ee.emit.bind(ee) };
}

const { ChatSSEBroadcaster } = require('../../../server/dist/lib/sseChat');

// Track all mock reqs created during tests so we can clean up timers
const allReqs = [];

describe('ChatSSEBroadcaster', () => {
  let broadcaster;

  beforeEach(() => {
    jest.useFakeTimers();
    broadcaster = new ChatSSEBroadcaster();
  });

  afterEach(() => {
    // Clean up all SSE instances and their timers
    for (const [, instance] of broadcaster.streams) {
      if (instance._pruneTimer) {
        clearInterval(instance._pruneTimer);
        instance._pruneTimer = null;
      }
      instance.clients = [];
    }
    broadcaster.streams.clear();
    jest.useRealTimers();
  });

  function connectClient(npid) {
    const req = createMockReq();
    const res = createMockRes();
    allReqs.push(req);
    broadcaster.middleware(npid)(req, res);
    return { req, res };
  }

  test('creates SSE stream for a net via middleware', () => {
    const { res } = connectClient('test-net');
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    }));
    expect(res.write).toHaveBeenCalledWith('retry: 5000\n\n');
  });

  test('broadcast sends data to connected clients', () => {
    const { res } = connectClient('test-net');
    res.write.mockClear();

    broadcaster.broadcast('test-net', { id: 'msg-1', text: 'Hello' });

    const allWrites = res.write.mock.calls.map(c => c[0]).join('');
    expect(allWrites).toContain('event: chat-message');
    expect(allWrites).toContain('"id":"msg-1"');
  });

  test('broadcastCustom sends with custom event name', () => {
    const { res } = connectClient('test-net');
    res.write.mockClear();

    broadcaster.broadcastCustom('test-net', { callSign: 'N0AD' }, 'chat-typing');

    const allWrites = res.write.mock.calls.map(c => c[0]).join('');
    expect(allWrites).toContain('event: chat-typing');
  });

  test('broadcast is no-op when no stream exists', () => {
    expect(() => broadcaster.broadcast('non-existent-net', {})).not.toThrow();
  });

  test('broadcastCustom is no-op when no stream exists', () => {
    expect(() => broadcaster.broadcastCustom('non-existent-net', {}, 'chat-typing')).not.toThrow();
  });

  test('broadcastUpdate sends chat-update event', () => {
    const { res } = connectClient('test-net');
    res.write.mockClear();

    broadcaster.broadcastUpdate('test-net', { id: 'msg-1' });

    const allWrites = res.write.mock.calls.map(c => c[0]).join('');
    expect(allWrites).toContain('event: chat-update');
  });

  test('broadcastReaction sends chat-reaction event', () => {
    const { res } = connectClient('test-net');
    res.write.mockClear();

    broadcaster.broadcastReaction('test-net', { messageId: 'msg-1' });

    const allWrites = res.write.mock.calls.map(c => c[0]).join('');
    expect(allWrites).toContain('event: chat-reaction');
  });

  test('broadcastDelete sends chat-delete event', () => {
    const { res } = connectClient('test-net');
    res.write.mockClear();

    broadcaster.broadcastDelete('test-net', 'msg-1');

    const allWrites = res.write.mock.calls.map(c => c[0]).join('');
    expect(allWrites).toContain('event: chat-delete');
    expect(allWrites).toContain('"messageId":"msg-1"');
  });

  test('close ends all client connections', () => {
    const { res } = connectClient('test-net');

    broadcaster.close('test-net');

    expect(res.end).toHaveBeenCalled();
  });

  test('multiple clients receive broadcasts independently', () => {
    const { res: res1 } = connectClient('test-net');
    const { res: res2 } = connectClient('test-net');
    res1.write.mockClear();
    res2.write.mockClear();

    broadcaster.broadcast('test-net', { text: 'To all' });

    expect(res1.write).toHaveBeenCalled();
    expect(res2.write).toHaveBeenCalled();
  });

  test('client write failure does not throw from broadcast', () => {
    const { res } = connectClient('test-net');
    // Replace res.write with throwing mock for broadcast
    res.write = jest.fn(() => { throw new Error('Client gone'); });

    expect(() => broadcaster.broadcast('test-net', { text: 'Test' })).not.toThrow();
  });

  test('close is no-op for non-existent net', () => {
    expect(() => broadcaster.close('non-existent-net')).not.toThrow();
  });

  test('broadcaster preserves separate streams per net', () => {
    const { res: resA } = connectClient('net-a');
    const { res: resB } = connectClient('net-b');
    resA.write.mockClear();
    resB.write.mockClear();

    broadcaster.broadcast('net-a', { text: 'Only A' });

    expect(resA.write).toHaveBeenCalled();
    expect(resB.write).not.toHaveBeenCalled();
  });
});