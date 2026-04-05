const { EventEmitter } = require('events');
const { RedisPubSub } = require('../../src/redis-pubsub');

function createFakeRedisFactory() {
  const clients = [];

  class FakeRedis extends EventEmitter {
    constructor() {
      super();
      this.publish = vi.fn(async () => 1);
      this.subscribe = vi.fn(async () => 1);
      this.quit = vi.fn(async () => {});
      this.disconnect = vi.fn(() => {});
      clients.push(this);
    }
  }

  return { FakeRedis, clients };
}

async function waitForClients(clients, expectedCount, timeoutMs = 200) {
  const started = Date.now();

  while (clients.length < expectedCount) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Expected ${expectedCount} clients, got ${clients.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('RedisPubSub lifecycle behavior', () => {
  test('connect() waits until both pub/sub clients emit ready', async () => {
    const { FakeRedis, clients } = createFakeRedisFactory();
    const pubsub = new RedisPubSub({ redisClientClass: FakeRedis, host: '127.0.0.1', port: 6379 });

    const connectPromise = pubsub.connect();
    await waitForClients(clients, 2);

    clients[0].emit('connect');
    clients[0].emit('ready');

    const firstStage = await Promise.race([
      connectPromise.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 20))
    ]);

    expect(firstStage).toBe('pending');
    expect(pubsub.client).toBeTruthy();
    expect(pubsub.subscriber).toBeNull();

    clients[1].emit('connect');
    clients[1].emit('ready');

    await expect(connectPromise).resolves.toBe(pubsub);
    expect(pubsub.client).toBeTruthy();
    expect(pubsub.subscriber).toBeTruthy();
  });

  test('disconnect() prefers quit() and falls back to disconnect() when quit fails', async () => {
    const { FakeRedis, clients } = createFakeRedisFactory();
    const pubsub = new RedisPubSub({ redisClientClass: FakeRedis, host: '127.0.0.1', port: 6379 });

    const connectPromise = pubsub.connect();
    await waitForClients(clients, 2);

    clients.forEach((c) => {
      c.emit('connect');
      c.emit('ready');
    });

    await connectPromise;

    clients[0].quit.mockResolvedValueOnce(undefined);
    clients[1].quit.mockRejectedValueOnce(new Error('quit failed'));

    await pubsub.disconnect();

    expect(clients[0].quit).toHaveBeenCalledTimes(1);
    expect(clients[0].disconnect).not.toHaveBeenCalled();

    expect(clients[1].quit).toHaveBeenCalledTimes(1);
    expect(clients[1].disconnect).toHaveBeenCalledTimes(1);
  });

  test('end event does not trigger process.exit during intentional shutdown', async () => {
    const { FakeRedis, clients } = createFakeRedisFactory();
    const pubsub = new RedisPubSub({ redisClientClass: FakeRedis, host: '127.0.0.1', port: 6379 });

    const connectPromise = pubsub.connect();
    await waitForClients(clients, 2);

    clients.forEach((c) => {
      c.emit('connect');
      c.emit('ready');
    });

    await connectPromise;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);

    pubsub.shuttingDown = true;
    clients[0].emit('end');

    expect(pubsub.reconnectFailures).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  test('end event exits process after max reconnect failures', async () => {
    const { FakeRedis, clients } = createFakeRedisFactory();
    const pubsub = new RedisPubSub({ redisClientClass: FakeRedis, host: '127.0.0.1', port: 6379 });

    const connectPromise = pubsub.connect();
    await waitForClients(clients, 2);

    clients.forEach((c) => {
      c.emit('connect');
      c.emit('ready');
    });

    await connectPromise;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    vi.useFakeTimers();

    for (let i = 0; i < 5; i++) {
      clients[0].emit('end');
    }

    expect(pubsub.reconnectFailures).toBe(5);
    expect(process.exitCode).toBe(1);

    // Advance past the 100ms flush delay and confirm exit is called
    await vi.runAllTimersAsync();
    expect(exitSpy).toHaveBeenCalledWith(1);

    vi.useRealTimers();
    exitSpy.mockRestore();
  });

  // ─── event: error ─────────────────────────────────────────────────────────

  test('error event sets status to "error"', async () => {
    const { FakeRedis, clients } = createFakeRedisFactory();
    const pubsub = new RedisPubSub({ redisClientClass: FakeRedis });

    const connectPromise = pubsub.connect();
    await waitForClients(clients, 2);
    clients.forEach(c => { c.emit('connect'); c.emit('ready'); });
    await connectPromise;

    expect(pubsub.status).toBe('connected');
    clients[0].emit('error', new Error('redis gone'));
    expect(pubsub.status).toBe('error');
  });

  // ─── event: close ─────────────────────────────────────────────────────────

  test('close event sets status to "disconnected" when not shutting down', async () => {
    const { FakeRedis, clients } = createFakeRedisFactory();
    const pubsub = new RedisPubSub({ redisClientClass: FakeRedis });

    const connectPromise = pubsub.connect();
    await waitForClients(clients, 2);
    clients.forEach(c => { c.emit('connect'); c.emit('ready'); });
    await connectPromise;

    clients[0].emit('close');
    expect(pubsub.status).toBe('disconnected');
  });

  test('close event sets status to "disconnected" even during intentional shutdown', async () => {
    const { FakeRedis, clients } = createFakeRedisFactory();
    const pubsub = new RedisPubSub({ redisClientClass: FakeRedis });

    const connectPromise = pubsub.connect();
    await waitForClients(clients, 2);
    clients.forEach(c => { c.emit('connect'); c.emit('ready'); });
    await connectPromise;

    pubsub.shuttingDown = true;
    clients[0].emit('close');
    expect(pubsub.status).toBe('disconnected');
  });

  // ─── event: reconnecting ──────────────────────────────────────────────────

  test('reconnecting event logs when not shutting down', async () => {
    const { FakeRedis, clients } = createFakeRedisFactory();
    const pubsub = new RedisPubSub({ redisClientClass: FakeRedis });

    const connectPromise = pubsub.connect();
    await waitForClients(clients, 2);
    clients.forEach(c => { c.emit('connect'); c.emit('ready'); });
    await connectPromise;

    // Should not throw — coverage hit for the logger.info path
    expect(() => clients[0].emit('reconnecting')).not.toThrow();
  });

  test('reconnecting event is silent during intentional shutdown', async () => {
    const { FakeRedis, clients } = createFakeRedisFactory();
    const pubsub = new RedisPubSub({ redisClientClass: FakeRedis });

    const connectPromise = pubsub.connect();
    await waitForClients(clients, 2);
    clients.forEach(c => { c.emit('connect'); c.emit('ready'); });
    await connectPromise;

    pubsub.shuttingDown = true;
    expect(() => clients[0].emit('reconnecting')).not.toThrow();
  });

  // ─── getStatus() ──────────────────────────────────────────────────────────

  test('getStatus() returns current status string', async () => {
    const { FakeRedis, clients } = createFakeRedisFactory();
    const pubsub = new RedisPubSub({ redisClientClass: FakeRedis });

    expect(pubsub.getStatus()).toBe('disconnected');

    const connectPromise = pubsub.connect();
    await waitForClients(clients, 2);
    clients.forEach(c => { c.emit('connect'); c.emit('ready'); });
    await connectPromise;

    expect(pubsub.getStatus()).toBe('connected');
  });

  // ─── constructor guard ────────────────────────────────────────────────────

  test('constructor throws when redisClientClass is not a function', () => {
    expect(() => new RedisPubSub({ redisClientClass: 'not-a-fn' }))
      .toThrow('options.redisClientClass must be a constructor function');
  });
});
