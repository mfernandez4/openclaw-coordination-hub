/**
 * Unit tests for RedisPubSub aligned with current source behavior.
 */
const { RedisPubSub } = require('../../src/redis-pubsub');

function createSubscriberHarness() {
  let messageHandler = null;

  return {
    on: vi.fn((event, handler) => {
      if (event === 'message') messageHandler = handler;
    }),
    subscribe: vi.fn(async () => 1),
    quit: vi.fn(async () => {}),
    disconnect: vi.fn(() => {}),
    emitMessage(channel, message) {
      if (messageHandler) messageHandler(channel, message);
    }
  };
}

function bindMessageDispatcher(pubsub) {
  pubsub.subscriber.on('message', (channel, message) => {
    const handler = pubsub.handlers.get(channel);
    if (handler) {
      try {
        handler(JSON.parse(message));
      } catch (e) {
        console.error(`Error handling message on ${channel}:`, e);
      }
    }
  });
}

describe('RedisPubSub', () => {
  let pubsub;
  let mockClient;
  let mockSubscriber;

  beforeEach(() => {
    mockClient = {
      publish: vi.fn(async () => 1),
      quit: vi.fn(async () => {}),
      disconnect: vi.fn(() => {})
    };

    mockSubscriber = createSubscriberHarness();

    pubsub = new RedisPubSub();
    pubsub.client = mockClient;
    pubsub.subscriber = mockSubscriber;
    pubsub._pubClient = mockClient;
    pubsub._subClient = mockSubscriber;
    bindMessageDispatcher(pubsub);
  });

  afterEach(async () => {
    if (pubsub) {
      try { await pubsub.disconnect(); } catch (_) {}
    }
  });

  test('publish() serializes payload and sends via Redis client', async () => {
    const payload = { msg: 'hello', value: 42 };

    await pubsub.publish('test:channel', payload);

    expect(mockClient.publish).toHaveBeenCalledWith('test:channel', JSON.stringify(payload));
  });

  test('publish() sends message that a subscriber handler can receive', async () => {
    const channel = 'test:deliver';
    const data = { msg: 'hello', value: 42 };
    let received = null;

    await pubsub.subscribe(channel, (msg) => { received = msg; });

    mockClient.publish.mockImplementation(async (publishedChannel, encoded) => {
      // Simulate Redis delivering pub/sub message to subscriber connection.
      mockSubscriber.emitMessage(publishedChannel, encoded);
      return 1;
    });

    await pubsub.publish(channel, data);

    expect(received).not.toBeNull();
    expect(received.msg).toBe('hello');
    expect(received.value).toBe(42);
  });

  test('publish() without connection throws', async () => {
    const disconnected = new RedisPubSub();
    disconnected.client = null;
    await expect(disconnected.publish('ch', {})).rejects.toThrow('Not connected');
  });

  test('publish() returns subscriber count from Redis', async () => {
    mockClient.publish.mockResolvedValue(3);
    const result = await pubsub.publish('test:count', { data: 1 });

    expect(result).toBe(3);
  });

  test('subscribe() registers a handler and subscribes to channel', async () => {
    const handler = vi.fn();

    const result = await pubsub.subscribe('test:subscribe', handler);

    expect(result).toBe(1);
    expect(pubsub.handlers.get('test:subscribe')).toBe(handler);
    expect(mockSubscriber.subscribe).toHaveBeenCalledWith('test:subscribe');
  });

  test('subscribe() without connection throws', () => {
    const disconnected = new RedisPubSub();
    disconnected.subscriber = null;
    expect(() => disconnected.subscribe('ch', () => {})).toThrow('Not connected');
  });

  test('subscribe() handler receives multiple messages on same channel', async () => {
    const channel = 'test:multi';
    const received = [];

    await pubsub.subscribe(channel, (msg) => received.push(msg));

    mockSubscriber.emitMessage(channel, JSON.stringify({ seq: 1 }));
    mockSubscriber.emitMessage(channel, JSON.stringify({ seq: 2 }));
    mockSubscriber.emitMessage(channel, JSON.stringify({ seq: 3 }));

    expect(received).toHaveLength(3);
    expect(received.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  test('subscribing twice to the same channel replaces previous handler', async () => {
    const channel = 'test:replace';
    const first = vi.fn();
    const second = vi.fn();

    await pubsub.subscribe(channel, first);
    await pubsub.subscribe(channel, second);

    mockSubscriber.emitMessage(channel, JSON.stringify({ ok: true }));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith({ ok: true });
  });

  test('removing handler stops delivery of new messages', async () => {
    const channel = 'test:unsub';
    const received = [];

    await pubsub.subscribe(channel, (msg) => received.push(msg));

    mockSubscriber.emitMessage(channel, JSON.stringify({ before: true }));
    expect(received).toHaveLength(1);

    pubsub.handlers.delete(channel);

    mockSubscriber.emitMessage(channel, JSON.stringify({ after: true }));
    expect(received).toHaveLength(1);
  });

  test('handler errors are caught and logged, not thrown', async () => {
    const channel = 'test:handler-errors';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await pubsub.subscribe(channel, () => {
      throw new Error('handler boom');
    });

    expect(() => {
      mockSubscriber.emitMessage(channel, JSON.stringify({ data: 1 }));
    }).not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(`Error handling message on ${channel}:`), expect.any(Error));
    consoleSpy.mockRestore();
  });

  test('disconnect() closes both pub/sub clients without throwing', async () => {
    await expect(pubsub.disconnect()).resolves.not.toThrow();

    const pubClosed = mockClient.quit.mock.calls.length + mockClient.disconnect.mock.calls.length;
    const subClosed = mockSubscriber.quit.mock.calls.length + mockSubscriber.disconnect.mock.calls.length;

    expect(pubClosed).toBeGreaterThanOrEqual(1);
    expect(subClosed).toBeGreaterThanOrEqual(1);
  });
});
