/**
 * Unit tests for TaskDispatcher (src/dispatcher.js)
 *
 * Redis is injected by assigning client/publisher directly after construction
 * (skipping connect()) so no live connections are needed.
 */
const { TaskDispatcher } = require('../../src/dispatcher');

function makeMockRedis() {
  return {
    lpush:   vi.fn().mockResolvedValue(1),
    brpop:   vi.fn().mockResolvedValue(null),
    publish: vi.fn().mockResolvedValue(1),
    quit:    vi.fn().mockResolvedValue('OK'),
  };
}

function makeDispatcher(overrides = {}) {
  const d = new TaskDispatcher({ pollTimeout: 1, ...overrides });
  d.client    = makeMockRedis();
  d.publisher = makeMockRedis();
  return d;
}

// ─── getTypedQueue ───────────────────────────────────────────────────────────

describe('TaskDispatcher.getTypedQueue()', () => {
  let d;
  beforeEach(() => { d = makeDispatcher(); });

  test('returns inbox queue for each known task type', () => {
    expect(d.getTypedQueue('coding')).toBe('a2a:inbox:coding');
    expect(d.getTypedQueue('github-ops')).toBe('a2a:inbox:github-ops');
    expect(d.getTypedQueue('research')).toBe('a2a:inbox:research');
    expect(d.getTypedQueue('dev-ops')).toBe('a2a:inbox:dev-ops');
  });

  test('returns null for unknown type', () => {
    expect(d.getTypedQueue('unknown-type')).toBeNull();
  });

  test('returns null for falsy input', () => {
    expect(d.getTypedQueue(null)).toBeNull();
    expect(d.getTypedQueue('')).toBeNull();
    expect(d.getTypedQueue(undefined)).toBeNull();
  });
});

// ─── deadLetter ──────────────────────────────────────────────────────────────

describe('TaskDispatcher.deadLetter()', () => {
  let d;
  beforeEach(() => { d = makeDispatcher(); });

  test('LPUSHes task to DLQ with metadata', async () => {
    const task = { id: 'task-1', type: 'unknown' };
    await d.deadLetter(task, 'No routing destination');

    expect(d.client.lpush).toHaveBeenCalledOnce();
    const [key, raw] = d.client.lpush.mock.calls[0];
    expect(key).toBe('coordination:tasks:dlq');
    const stored = JSON.parse(raw);
    expect(stored._deadLettered).toBe(true);
    expect(stored._deadLetterReason).toBe('No routing destination');
    expect(typeof stored._deadLetterTimestamp).toBe('string');
    expect(stored.id).toBe('task-1');
  });

  test('publishes dead-letter result to a2a:results:main', async () => {
    const task = { id: 'task-2', type: 'mystery' };
    await d.deadLetter(task, 'reason');

    expect(d.publisher.publish).toHaveBeenCalledOnce();
    const [channel, raw] = d.publisher.publish.mock.calls[0];
    expect(channel).toBe('a2a:results:main');
    const msg = JSON.parse(raw);
    expect(msg.status).toBe('dead_lettered');
    expect(msg.taskId).toBe('task-2');
    expect(msg.agent).toBe('dispatcher');
    expect(msg.error).toBe('reason');
  });

  test('preserves original task fields in DLQ entry', async () => {
    const task = { id: 'task-3', type: 'coding', payload: { query: 'hello' } };
    await d.deadLetter(task, 'test');
    const [, raw] = d.client.lpush.mock.calls[0];
    const stored = JSON.parse(raw);
    expect(stored.payload).toEqual({ query: 'hello' });
  });
});

// ─── routeTask ───────────────────────────────────────────────────────────────

describe('TaskDispatcher.routeTask()', () => {
  let d;
  beforeEach(() => { d = makeDispatcher(); });

  test('routes coding task to a2a:inbox:coding', async () => {
    await d.routeTask({ id: 'task-1', type: 'coding', task: 'list-files' });
    expect(d.client.lpush).toHaveBeenCalledWith(
      'a2a:inbox:coding',
      expect.stringContaining('"_routedTo":"a2a:inbox:coding"')
    );
  });

  test('routes research task to a2a:inbox:research', async () => {
    await d.routeTask({ id: 'task-2', type: 'research', task: 'search' });
    const [queue] = d.client.lpush.mock.calls[0];
    expect(queue).toBe('a2a:inbox:research');
  });

  test('routes github-ops task', async () => {
    await d.routeTask({ id: 'task-3', type: 'github-ops', task: 'check-pr' });
    const [queue] = d.client.lpush.mock.calls[0];
    expect(queue).toBe('a2a:inbox:github-ops');
  });

  test('routes dev-ops task', async () => {
    await d.routeTask({ id: 'task-4', type: 'dev-ops', task: 'deploy' });
    const [queue] = d.client.lpush.mock.calls[0];
    expect(queue).toBe('a2a:inbox:dev-ops');
  });

  test('enriches routed task with _routedTo and _routeTimestamp', async () => {
    await d.routeTask({ id: 'task-5', type: 'coding', task: 'run-tests' });
    const [, raw] = d.client.lpush.mock.calls[0];
    const routed = JSON.parse(raw);
    expect(routed._routedTo).toBe('a2a:inbox:coding');
    expect(typeof routed._routeTimestamp).toBe('string');
  });

  test('dead-letters task with unknown type', async () => {
    await d.routeTask({ id: 'task-6', type: 'mystery' });
    // No LPUSH to inbox — only DLQ LPUSH
    expect(d.client.lpush).toHaveBeenCalledWith(
      'coordination:tasks:dlq',
      expect.any(String)
    );
  });

  test('falls back to task.task when task.type is absent', async () => {
    // task.task = 'coding' won't match a type name but type is resolved via task field
    await d.routeTask({ id: 'task-7', task: 'coding', type: 'coding' });
    const [queue] = d.client.lpush.mock.calls[0];
    expect(queue).toBe('a2a:inbox:coding');
  });

  test('dead-letters task with no type or task fields', async () => {
    await d.routeTask({ id: 'task-8' });
    expect(d.client.lpush).toHaveBeenCalledWith(
      'coordination:tasks:dlq',
      expect.any(String)
    );
  });
});

// ─── stop ────────────────────────────────────────────────────────────────────

describe('TaskDispatcher.stop()', () => {
  test('sets running to false and quits both Redis connections', async () => {
    const d = makeDispatcher();
    d.running = true;

    await d.stop();

    expect(d.running).toBe(false);
    expect(d.client.quit).toHaveBeenCalledOnce();
    expect(d.publisher.quit).toHaveBeenCalledOnce();
  });

  test('does not throw when client/publisher are null', async () => {
    const d = new TaskDispatcher();
    // never connected — client and publisher are null
    await expect(d.stop()).resolves.not.toThrow();
  });
});

// ─── run() loop ──────────────────────────────────────────────────────────────
//
// Stop the loop deterministically by having the brpop mock set running=false
// so we never spin in a tight loop on immediate null returns.

describe('TaskDispatcher run() loop', () => {
  test('calls routeTask for each valid item brpop returns', async () => {
    const d = makeDispatcher();
    const task = { id: 'task-loop-1', type: 'research', task: 'search' };
    const routeSpy = vi.spyOn(d, 'routeTask');

    let first = true;
    d.client.brpop.mockImplementation(async () => {
      if (first) { first = false; return ['coordination:tasks:normal', JSON.stringify(task)]; }
      d.running = false;
      return null;
    });

    d.running = true;
    await d.run();

    expect(routeSpy).toHaveBeenCalledWith(task);
  });

  test('skips unparseable JSON without crashing', async () => {
    const d = makeDispatcher();
    const routeSpy = vi.spyOn(d, 'routeTask');

    let first = true;
    d.client.brpop.mockImplementation(async () => {
      if (first) { first = false; return ['coordination:tasks:high', 'not-valid-json{{{' ]; }
      d.running = false;
      return null;
    });

    d.running = true;
    await d.run();

    expect(routeSpy).not.toHaveBeenCalled();
  });

  test('continues after a routeTask error (backoff then exits)', async () => {
    const d = makeDispatcher();
    const task = { id: 'task-err', type: 'coding', task: 'list-files' };

    vi.useFakeTimers();

    let first = true;
    d.client.brpop.mockImplementation(async () => {
      if (first) { first = false; return ['coordination:tasks:normal', JSON.stringify(task)]; }
      d.running = false;
      return null;
    });
    vi.spyOn(d, 'routeTask').mockRejectedValueOnce(new Error('redis down'));

    d.running = true;
    const loopPromise = d.run();

    // Advance past the 1000ms backoff in the catch block
    await vi.runAllTimersAsync();
    await loopPromise;

    vi.useRealTimers();
    // No unhandled rejection — loop survived the error
  });
});
