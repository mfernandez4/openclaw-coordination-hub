/**
 * Unit tests for TaskQueue
 */
const { TaskQueue } = require('../../src/task-queue');
const { createMockRedis } = require('../helpers/redis');

// Simulates priority-ordered BRPOP: tries each key in order, returns from first non-empty
function mockBrpopWithRpop(redis) {
  return vi.fn(async (...args) => {
    const keys = args.slice(0, -1); // last arg is timeout
    for (const key of keys) {
      const item = await redis.rpop(key);
      if (item !== null) return [key, item];
    }
    return null;
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

  test('enqueue() adds task to Redis list (normal priority by default)', async () => {
    const task = { type: 'coding', task: 'list-files', context: { path: '/tmp' } };
    const id = await tq.enqueue(task);
    expect(id).toMatch(/^task:\d+:/);

    // No priority → goes to :normal queue
    const list = await mockRedis.lrange(`${tq.queueName}:normal`, 0, -1);
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

  test('dequeue() removes and returns the oldest entry (FIFO within same priority)', async () => {
    await tq.enqueue({ type: 'first', priority: 'normal' });
    await tq.enqueue({ type: 'second', priority: 'normal' });

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
    await tq.enqueue({ type: 'task-a', priority: 'normal' });
    await tq.enqueue({ type: 'task-b', priority: 'normal' });

    tq.client.brpop = mockBrpopWithRpop(mockRedis);

    const normalQueue = `${tq.queueName}:normal`;
    const lenBefore = await mockRedis.llen(normalQueue);
    expect(lenBefore).toBe(2);

    await tq.dequeue(1);

    const lenAfter = await mockRedis.llen(normalQueue);
    expect(lenAfter).toBe(1);
  });

  test('disconnect() closes client without throwing', async () => {
    const tq2 = new TaskQueue();
    tq2.client = mockRedis;
    await expect(tq2.disconnect()).resolves.not.toThrow();
  });

  test('disconnect() calls client.quit()', async () => {
    const tq2 = new TaskQueue();
    tq2.client = mockRedis;
    const quitSpy = vi.spyOn(mockRedis, 'quit');

    await tq2.disconnect();

    expect(quitSpy).toHaveBeenCalledTimes(1);
  });

  // ── Priority queue routing ──────────────────────────────────────────────────

  test('enqueue() with priority:high writes to coordination:tasks:high', async () => {
    await tq.enqueue({ type: 'coding', priority: 'high' });
    const len = await mockRedis.llen('coordination:tasks:high');
    expect(len).toBe(1);
    // other queues untouched
    expect(await mockRedis.llen('coordination:tasks:normal')).toBe(0);
    expect(await mockRedis.llen('coordination:tasks:low')).toBe(0);
  });

  test('enqueue() with priority:low writes to coordination:tasks:low', async () => {
    await tq.enqueue({ type: 'research', priority: 'low' });
    expect(await mockRedis.llen('coordination:tasks:low')).toBe(1);
    expect(await mockRedis.llen('coordination:tasks:high')).toBe(0);
  });

  test('enqueue() with no priority defaults to coordination:tasks:normal', async () => {
    await tq.enqueue({ type: 'github-ops' });
    expect(await mockRedis.llen('coordination:tasks:normal')).toBe(1);
    const item = JSON.parse(await mockRedis.rpop('coordination:tasks:normal'));
    expect(item.priority).toBe('normal');
  });

  test('enqueue() with unknown priority falls back to normal', async () => {
    await tq.enqueue({ type: 'x', priority: 'urgent' });
    expect(await mockRedis.llen('coordination:tasks:normal')).toBe(1);
  });

  test('dequeue() drains high before normal before low', async () => {
    // Seed all three queues
    await tq.enqueue({ type: 'low-task', priority: 'low' });
    await tq.enqueue({ type: 'normal-task', priority: 'normal' });
    await tq.enqueue({ type: 'high-task', priority: 'high' });

    // Mock brpop to simulate priority ordering (returns first non-empty key)
    const origBrpop = mockRedis.brpop.bind(mockRedis);
    tq.client.brpop = vi.fn(async (...args) => {
      const timeout = args[args.length - 1];
      const keys = args.slice(0, -1);
      for (const key of keys) {
        const item = await mockRedis.rpop(key);
        if (item !== null) return [key, item];
      }
      return null;
    });

    const first = await tq.dequeue(1);
    const second = await tq.dequeue(1);
    const third = await tq.dequeue(1);

    expect(first.type).toBe('high-task');
    expect(second.type).toBe('normal-task');
    expect(third.type).toBe('low-task');
  });
});
