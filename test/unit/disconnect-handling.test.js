/**
 * Unit tests for Redis disconnect/reconnect error handling (Issue #18)
 *
 * Tests: TaskQueue, RedisPubSub, and ResultProcessor error handling
 * when Redis disconnects.
 */
const { TaskQueue } = require('../../src/task-queue');
const { RedisPubSub } = require('../../src/redis-pubsub');
const { ResultProcessor } = require('../../src/result-processor');
const { createMockRedis, createMockPubSub } = require('../helpers/redis');

describe('Redis Disconnect/Reconnect Error Handling (Issue #18)', () => {

  describe('TaskQueue', () => {
    test('enqueue() throws "Not connected" when client is null', async () => {
      const tq = new TaskQueue();
      tq.client = null;
      await expect(tq.enqueue({ type: 'x' })).rejects.toThrow('Not connected');
    });

    test('dequeue() throws "Not connected" when client is null', async () => {
      const tq = new TaskQueue();
      tq.client = null;
      await expect(tq.dequeue(0)).rejects.toThrow('Not connected');
    });

    test('disconnect() calls quit on the Redis client', async () => {
      const mockRedis = createMockRedis();
      const tq = new TaskQueue();
      tq.client = mockRedis;
      const quitSpy = vi.spyOn(mockRedis, 'quit');

      await tq.disconnect();

      expect(quitSpy).toHaveBeenCalledTimes(1);
    });

    test('disconnect() is idempotent (calling twice does not throw)', async () => {
      const mockRedis = createMockRedis();
      const tq = new TaskQueue();
      tq.client = mockRedis;

      await tq.disconnect();
      await expect(tq.disconnect()).resolves.not.toThrow();
    });

    test('disconnect() resolves without throwing', async () => {
      const mockRedis = createMockRedis();
      const tq = new TaskQueue();
      tq.client = mockRedis;

      await expect(tq.disconnect()).resolves.not.toThrow();
    });
  });

  describe('RedisPubSub', () => {
    test('publish() throws "Not connected" when client is null', async () => {
      const ps = new RedisPubSub();
      ps.client = null;
      await expect(ps.publish('ch', {})).rejects.toThrow('Not connected');
    });

    test('subscribe() throws "Not connected" when subscriber is null', () => {
      const ps = new RedisPubSub();
      ps.subscriber = null;
      expect(() => ps.subscribe('ch', () => {})).toThrow('Not connected');
    });

    test('disconnect() closes both low-level pub/sub clients', async () => {
      const mock = createMockPubSub();
      const ps = new RedisPubSub();
      ps.client = mock.publisher;
      ps.subscriber = mock.subscriber;
      ps._pubClient = mock.publisher;
      ps._subClient = mock.subscriber;

      const clientDisconnectSpy = vi.spyOn(mock.publisher, 'disconnect');
      const subscriberDisconnectSpy = vi.spyOn(mock.subscriber, 'disconnect');
      const clientQuitSpy = vi.spyOn(mock.publisher, 'quit');
      const subscriberQuitSpy = vi.spyOn(mock.subscriber, 'quit');

      await ps.disconnect();

      expect(clientDisconnectSpy.mock.calls.length + clientQuitSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(subscriberDisconnectSpy.mock.calls.length + subscriberQuitSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('ResultProcessor', () => {
    test('processResult() does not throw when Redis is available (happy path)', async () => {
      const mockRedis = createMockRedis();
      const rp = new ResultProcessor();
      rp.subscriber = mockRedis;
      rp.publisher = mockRedis;

      const result = { taskId: 't1', agent: 'a', task: 't', status: 'completed' };
      await expect(rp.processResult(result)).resolves.not.toThrow();
    });

    test('stop() is idempotent (calling twice does not throw)', async () => {
      const mockRedis = createMockRedis();
      const rp = new ResultProcessor();
      rp.subscriber = mockRedis;
      rp.publisher = mockRedis;

      await rp.stop();
      await expect(rp.stop()).resolves.not.toThrow();
    });

    test('stop() sets running flag to false', async () => {
      const mockRedis = createMockRedis();
      const rp = new ResultProcessor();
      rp.subscriber = mockRedis;
      rp.publisher = mockRedis;
      rp.running = true;

      await rp.stop();
      expect(rp.running).toBe(false);
    });
  });
});
