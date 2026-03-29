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
    const pubsub = new RedisPubSub({ redisFactory: FakeRedis, host: '127.0.0.1', port: 6379 });

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
    const pubsub = new RedisPubSub({ redisFactory: FakeRedis, host: '127.0.0.1', port: 6379 });

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
    const pubsub = new RedisPubSub({ redisFactory: FakeRedis, host: '127.0.0.1', port: 6379 });

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
    const pubsub = new RedisPubSub({ redisFactory: FakeRedis, host: '127.0.0.1', port: 6379 });

    const connectPromise = pubsub.connect();
    await waitForClients(clients, 2);

    clients.forEach((c) => {
      c.emit('connect');
      c.emit('ready');
    });

    await connectPromise;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);

    for (let i = 0; i < 5; i++) {
      clients[0].emit('end');
    }

    expect(pubsub.reconnectFailures).toBe(5);
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});
