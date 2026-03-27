/**
 * Unit tests for TaskQueue
 */
const { TaskQueue } = require('../../src/task-queue');
const { createMockRedis } = require('../helpers/redis');

function mockBrpopWithRpop(redis) {
  return vi.fn(async (queueName) => {
    const item = await redis.rpop(queueName);
    return item === null ? null : [queueName, item];
  });
}

describe('TaskQueue', () => {
  let tq;
  let mockRedis;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    await mockRedis.flushall();

    tq = new TaskQueue();
    tq.client = mockRedis;
  });

  afterEach(async () => {
    if (mockRedis) {
      try { await mockRedis.flushall(); } catch (_) {}
    }
    if (tq) {
      try { await tq.disconnect(); } catch (_) {}
    }
  });

  test('enqueue() adds task to Redis list', async () => {
    const task = { type: 'coding', task: 'list-files', context: { path: '/tmp' } };
    const id = await tq.enqueue(task);
    expect(id).toMatch(/^task:\d+:/);

    const list = await mockRedis.lrange(tq.queueName, 0, -1);
    expect(list).toHaveLength(1);
    const stored = JSON.parse(list[0]);
    expect(stored.id).toBe(id);
    expect(stored.type).toBe('coding');
    expect(stored.task).toBe('list-files');
    expect(stored.context.path).toBe('/tmp');
  });

  test('enqueue() generates unique ids', async () => {
    const id1 = await tq.enqueue({ type: 'a' });
    const id2 = await tq.enqueue({ type: 'b' });
    expect(id1).not.toBe(id2);
  });

  test('enqueue() without connection throws', async () => {
    const disconnectedQueue = new TaskQueue();
    disconnectedQueue.client = null;
    await expect(disconnectedQueue.enqueue({ type: 'x' })).rejects.toThrow('Not connected');
  });

  test('dequeue() removes and returns the oldest entry (FIFO)', async () => {
    await tq.enqueue({ type: 'first' });
    await tq.enqueue({ type: 'second' });

    tq.client.brpop = mockBrpopWithRpop(mockRedis);

    const first = await tq.dequeue(1);
    const second = await tq.dequeue(1);

    expect(tq.client.brpop).toHaveBeenCalled();
    // LPUSH + BRPOP => FIFO behavior
    expect(first.type).toBe('first');
    expect(second.type).toBe('second');
  });

  test('dequeue() returns null when queue is empty (no throw)', async () => {
    tq.client.brpop = vi.fn(async () => null);

    const result = await tq.dequeue(1);
    expect(result).toBeNull();
  });

  test('dequeue() without connection throws', async () => {
    const disconnectedQueue = new TaskQueue();
    disconnectedQueue.client = null;
    await expect(disconnectedQueue.dequeue(0)).rejects.toThrow('Not connected');
  });

  test('dequeue() consumes tasks (queue shrinks)', async () => {
    await tq.enqueue({ type: 'task-a' });
    await tq.enqueue({ type: 'task-b' });

    tq.client.brpop = mockBrpopWithRpop(mockRedis);

    const lenBefore = await mockRedis.llen(tq.queueName);
    expect(lenBefore).toBe(2);

    await tq.dequeue(1);

    const lenAfter = await mockRedis.llen(tq.queueName);
    expect(lenAfter).toBe(1);
  });

  test('disconnect() closes client without throwing', async () => {
    const tq2 = new TaskQueue();
    tq2.client = mockRedis;
    await expect(tq2.disconnect()).resolves.not.toThrow();
  });

  test('operations after disconnect throw "Not connected" when client is null', async () => {
    const tq2 = new TaskQueue();
    tq2.client = mockRedis;
    await tq2.disconnect();

    await expect(tq2.enqueue({ type: 'x' })).rejects.toThrow('Not connected');
    await expect(tq2.dequeue(0)).rejects.toThrow('Not connected');
  });
});
