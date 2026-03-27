/**
 * Unit tests for Redis disconnect/reconnect error handling (Issue #18)
 *
 * Tests: TaskQueue, RedisPubSub, and ResultProcessor error handling
 * when Redis disconnects.
 */
const { TaskQueue } = require('../../src/task-queue');
const { RedisPubSub } = require('../../src/redis-pubsub');
const ResultProcessor = require('../../src/result-processor');
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

    test('operations after explicit disconnect throw "Not connected"', async () => {
      const mockRedis = createMockRedis();
      const tq = new TaskQueue();
      tq.client = mockRedis;

      await tq.disconnect();
      // disconnect() sets client = null

      await expect(tq.enqueue({ type: 'x' })).rejects.toThrow('Not connected');
      await expect(tq.dequeue(0)).rejects.toThrow('Not connected');
    });

    test('disconnect() is idempotent (calling twice does not throw)', async () => {
      const mockRedis = createMockRedis();
      const tq = new TaskQueue();
      tq.client = mockRedis;

      await tq.disconnect();
      await expect(tq.disconnect()).resolves.not.toThrow();
    });

    test('disconnect() sets client to null', async () => {
      const mockRedis = createMockRedis();
      const tq = new TaskQueue();
      tq.client = mockRedis;
      expect(tq.client).not.toBeNull();

      await tq.disconnect();
      expect(tq.client).toBeNull();
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

    test('disconnect() closes both client and subscriber and nulls them', async () => {
      const mock = createMockPubSub();
      const ps = new RedisPubSub();
      ps.client = mock.publisher;
      ps.subscriber = mock.subscriber;

      await ps.disconnect();
      expect(ps.client).toBeNull();
      expect(ps.subscriber).toBeNull();
    });

    test('publish after disconnect throws "Not connected" when client is nulled', async () => {
      const mock = createMockPubSub();
      const ps = new RedisPubSub();
      ps.client = mock.publisher;
      ps.subscriber = mock.subscriber;

      await ps.disconnect();
      // disconnect() sets client = null
      await expect(ps.publish('ch', {})).rejects.toThrow('Not connected');
    });

    test('subscribe after disconnect throws "Not connected" when subscriber is nulled', async () => {
      const mock = createMockPubSub();
      const ps = new RedisPubSub();
      ps.client = mock.publisher;
      ps.subscriber = mock.subscriber;

      await ps.disconnect();
      // disconnect() sets subscriber = null
      expect(() => ps.subscribe('ch', () => {})).toThrow('Not connected');
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
