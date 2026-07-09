/**
 * Unit tests for ExecutionLedger
 */
const {
  create,
  start,
  complete,
  block,
  invalidate,
  get,
  allLanes
} = require('../../src/execution-ledger');

describe('ExecutionLedger', () => {
  // Fresh mock for each test — no shared state
  let redis;
  beforeEach(() => {
    const store = new Map();
    redis = {
      hget: vi.fn((key, field) => store.get(key)?.get(field)),
      // ioredis hset supports both hset(key, field, value, ...) and hset(key, object)
      // When called with hset(key, obj), spread the object into flat k/v pairs
      hset: vi.fn((key, ...args) => {
        let fields;
        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
          fields = Object.entries(args[0]);
        } else {
          fields = [];
          for (let i = 0; i < args.length; i += 2) fields.push([args[i], args[i + 1]]);
        }
        const isNew = !store.has(key);
        if (isNew) store.set(key, new Map());
        const m = store.get(key);
        for (const [k, v] of fields) m.set(k, v);
        return isNew ? fields.length : 0;
      }),
      del: vi.fn((key) => { store.delete(key); return 1; }),
      hgetall: vi.fn((key) => {
        const m = store.get(key);
        if (!m) return {};
        const obj = {};
        for (const [k, v] of m) obj[k] = v;
        return obj;
      }),
      keys: vi.fn((pattern) => {
        const prefix = pattern.replace(/\*$/, '');
        return Array.from(store.keys()).filter(k => k.startsWith(prefix));
      }),
      pipeline: vi.fn(() => ({
        hgetall: vi.fn().mockReturnThis(),
        exec: vi.fn(async () => [])
      })),
      _store: store
    };
  });

  // ─── create() ──────────────────────────────────────────────────────────────

  describe('create()', () => {
    test('writes a ledger hash with state=pending and taskId', async () => {
      const result = await create(redis, 'lane-1', 'task-abc');
      expect(result.state).toBe('pending');
      expect(result.taskId).toBe('task-abc');
      expect(result.startedAt).toBeTruthy();
      expect(result.updatedAt).toBeTruthy();
      expect(result.commitHash).toBe('');
      expect(result.retryCount).toBe(0);
    });

    test('is idempotent — re-creating overwrites with fresh pending state', async () => {
      await create(redis, 'lane-1', 'task-1');
      const result = await create(redis, 'lane-1', 'task-2');
      expect(result.state).toBe('pending');
      expect(result.taskId).toBe('task-2');
      expect(redis.del).toHaveBeenCalled(); // old key deleted before re-create
    });

    test('stored hash key format is ledger:{laneId}', async () => {
      await create(redis, 'my-lane', 'task-x');
      expect(redis.hset.mock.calls[0][0]).toBe('ledger:my-lane');
    });
  });

  // ─── start() ──────────────────────────────────────────────────────────────

  describe('start()', () => {
    test('transitions pending → running', async () => {
      await create(redis, 'lane-1', 'task-abc');
      const result = await start(redis, 'lane-1');
      expect(result.state).toBe('running');
    });

    test('throws on invalid transition from running → running', async () => {
      await create(redis, 'lane-1', 'task-abc');
      await start(redis, 'lane-1');
      await expect(start(redis, 'lane-1')).rejects.toThrow('Invalid transition');
    });

    test('throws on start of unknown lane', async () => {
      await expect(start(redis, 'unknown-lane')).rejects.toThrow();
    });
  });

  // ─── complete() ──────────────────────────────────────────────────────────

  describe('complete()', () => {
    beforeEach(async () => {
      await create(redis, 'lane-1', 'task-abc');
      await start(redis, 'lane-1');
    });

    test('transitions running → done with valid commitHash and changedFiles', async () => {
      const result = await complete(redis, 'lane-1', {
        commitHash: 'a3f9c2d',
        changedFiles: ['src/foo.js', 'test/foo.test.js'],
        verification: { tests: 'pass', lint: 'pass' }
      });
      expect(result.state).toBe('done');
      expect(result.commitHash).toBe('a3f9c2d');
      expect(result.changedFiles).toEqual(['src/foo.js', 'test/foo.test.js']);
    });

    test('accepts full-length commit hash (40 hex chars)', async () => {
      const hash = 'a'.repeat(40);
      const result = await complete(redis, 'lane-1', {
        commitHash: hash,
        changedFiles: ['README.md'],
        verification: { tests: 'pass' }
      });
      expect(result.state).toBe('done');
      expect(result.commitHash).toBe(hash);
    });

    test('rejects missing commitHash', async () => {
      await expect(complete(redis, 'lane-1', {
        changedFiles: ['x.js'],
        verification: { tests: 'pass' }
      })).rejects.toThrow('commitHash must be 7–40 hex chars');
    });

    test('rejects commitHash shorter than 7 chars', async () => {
      await expect(complete(redis, 'lane-1', {
        commitHash: 'abc',
        changedFiles: ['x.js'],
        verification: { tests: 'pass' }
      })).rejects.toThrow('commitHash must be 7–40 hex chars');
    });

    test('rejects commitHash longer than 40 chars', async () => {
      await expect(complete(redis, 'lane-1', {
        commitHash: 'a'.repeat(41),
        changedFiles: ['x.js'],
        verification: { tests: 'pass' }
      })).rejects.toThrow('commitHash must be 7–40 hex chars');
    });

    test('rejects non-hex commitHash', async () => {
      await expect(complete(redis, 'lane-1', {
        commitHash: 'xyz12345',
        changedFiles: ['x.js'],
        verification: { tests: 'pass' }
      })).rejects.toThrow('commitHash must be 7–40 hex chars');
    });

    test('rejects empty changedFiles array', async () => {
      await expect(complete(redis, 'lane-1', {
        commitHash: 'a3f9c2d',
        changedFiles: [],
        verification: { tests: 'pass' }
      })).rejects.toThrow('non-empty array');
    });

    test('rejects changedFiles that is not an array', async () => {
      await expect(complete(redis, 'lane-1', {
        commitHash: 'a3f9c2d',
        changedFiles: 'README.md',
        verification: { tests: 'pass' }
      })).rejects.toThrow('must be a non-empty array');
    });

    test('rejects changedFiles entries that are empty strings', async () => {
      await expect(complete(redis, 'lane-1', {
        commitHash: 'a3f9c2d',
        changedFiles: ['file.js', ''],
        verification: { tests: 'pass' }
      })).rejects.toThrow('non-empty string');
    });

    test('rejects missing verification', async () => {
      await expect(complete(redis, 'lane-1', {
        commitHash: 'a3f9c2d',
        changedFiles: ['x.js']
      })).rejects.toThrow('Missing required field: verification');
    });

    test('rejects empty verification object', async () => {
      await expect(complete(redis, 'lane-1', {
        commitHash: 'a3f9c2d',
        changedFiles: ['x.js'],
        verification: {}
      })).rejects.toThrow('at least one key');
    });

    test('rejects verification with no passing checks (all falsy)', async () => {
      await expect(complete(redis, 'lane-1', {
        commitHash: 'a3f9c2d',
        changedFiles: ['x.js'],
        verification: { tests: false, lint: null }
      })).rejects.toThrow('at least one passing check');
    });

    test('accepts verification with at least one truthy value', async () => {
      const result = await complete(redis, 'lane-1', {
        commitHash: 'a3f9c2d',
        changedFiles: ['x.js'],
        verification: { tests: false, lint: 'pass' }
      });
      expect(result.state).toBe('done');
    });
  });

  // ─── block() ──────────────────────────────────────────────────────────────

  describe('block()', () => {
    test('transitions pending → blocked', async () => {
      await create(redis, 'lane-1', 'task-abc');
      const result = await block(redis, 'lane-1', { reason: 'repo not found' });
      expect(result.state).toBe('blocked');
      expect(result.blocker).toBe('repo not found');
    });

    test('transitions running → blocked', async () => {
      await create(redis, 'lane-1', 'task-abc');
      await start(redis, 'lane-1');
      const result = await block(redis, 'lane-1', { reason: 'write access denied' });
      expect(result.state).toBe('blocked');
    });

    test('includes mitigation when provided', async () => {
      await create(redis, 'lane-1', 'task-abc');
      const result = await block(redis, 'lane-1', {
        reason: 'preflight failed',
        mitigation: 'Grant write access and retry'
      });
      expect(result.mitigation).toBe('Grant write access and retry');
    });

    test('throws on block from done state', async () => {
      await create(redis, 'lane-1', 'task-abc');
      await start(redis, 'lane-1');
      await complete(redis, 'lane-1', {
        commitHash: 'a3f9c2d',
        changedFiles: ['x.js'],
        verification: { tests: 'pass' }
      });
      await expect(block(redis, 'lane-1', { reason: 'oops' })).rejects.toThrow();
    });
  });

  // ─── invalidate() ────────────────────────────────────────────────────────

  describe('invalidate()', () => {
    test('transitions running → invalid on first failure', async () => {
      await create(redis, 'lane-1', 'task-abc');
      await start(redis, 'lane-1');
      const { record, shouldEscalate } = await invalidate(redis, 'lane-1', {
        reason: 'completion schema check failed'
      });
      expect(record.state).toBe('invalid');
      expect(record.retryCount).toBe(1);
      expect(shouldEscalate).toBe(false);
    });

    test('sets blocker on invalid state', async () => {
      await create(redis, 'lane-1', 'task-abc');
      await start(redis, 'lane-1');
      const { record } = await invalidate(redis, 'lane-1', {
        reason: 'missing verification output'
      });
      expect(record.blocker).toBe('missing verification output');
    });

    test('increments retryCount on subsequent invalidations', async () => {
      await create(redis, 'lane-1', 'task-abc');
      await start(redis, 'lane-1');
      await invalidate(redis, 'lane-1', { reason: 'fail 1' });
      const { record, shouldEscalate } = await invalidate(redis, 'lane-1', { reason: 'fail 2' });
      expect(record.retryCount).toBe(2);
      expect(shouldEscalate).toBe(true);
    });

    test('appends to errors array on each invalidation', async () => {
      await create(redis, 'lane-1', 'task-abc');
      await start(redis, 'lane-1');
      await invalidate(redis, 'lane-1', { reason: 'fail 1' });
      const { record } = await invalidate(redis, 'lane-1', { reason: 'fail 2' });
      expect(record.errors).toHaveLength(2);
      expect(record.errors[0].reason).toBe('fail 1');
      expect(record.errors[1].reason).toBe('fail 2');
    });

    test('throws on invalidate from pending state', async () => {
      await create(redis, 'lane-2', 'task-xyz');
      await expect(invalidate(redis, 'lane-2', { reason: 'oops' })).rejects.toThrow();
    });
  });

  // ─── get() ────────────────────────────────────────────────────────────────

  describe('get()', () => {
    test('returns null for unknown lane', async () => {
      const result = await get(redis, 'does-not-exist');
      expect(result).toBeNull();
    });

    test('returns parsed lane record with correct field types', async () => {
      await create(redis, 'lane-1', 'task-abc');
      await start(redis, 'lane-1');
      const result = await get(redis, 'lane-1');
      expect(result.state).toBe('running');
      expect(result.taskId).toBe('task-abc');
      expect(result.retryCount).toBe(0);
      expect(result.changedFiles).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  // ─── allLanes() ──────────────────────────────────────────────────────────

  describe('allLanes()', () => {
    test('returns empty array when no lanes exist', async () => {
      const result = await allLanes(redis);
      expect(result).toEqual([]);
    });
  });
});
