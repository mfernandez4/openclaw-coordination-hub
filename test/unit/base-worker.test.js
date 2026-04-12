/**
 * Unit tests for BaseWorker
 *
 * Redis and ArtifactStore are injected via constructor options to keep
 * tests fast and free of filesystem/network I/O.
 */
const BaseWorker = require('../../workers/base-worker');

const DEFAULT_HEARTBEAT_INTERVAL = 30000; // ms — BaseWorker default
const DEFAULT_TTL = Math.floor((DEFAULT_HEARTBEAT_INTERVAL * 3) / 1000); // 90s

function makeMockRedis() {
  return {
    hset:    vi.fn().mockResolvedValue(1),
    expire:  vi.fn().mockResolvedValue(1),
    set:     vi.fn().mockResolvedValue('OK'),
    hdel:    vi.fn().mockResolvedValue(1),
    del:     vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
    blpop:   vi.fn().mockResolvedValue(null),
    brpoplpush: vi.fn().mockResolvedValue(null),
    quit:    vi.fn().mockResolvedValue('OK'),
  };
}

function makeMockArtifactStore() {
  return { writeArtifact: vi.fn(), readArtifact: vi.fn() };
}

describe('BaseWorker', () => {
  let worker;
  let mockRedis;

  beforeEach(() => {
    mockRedis = makeMockRedis();
    worker = new BaseWorker('test-agent', {
      redis: mockRedis,
      artifactStore: makeMockArtifactStore()
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── register() ─────────────────────────────────────────────────────────────

  describe('register()', () => {
    test('writes agent entry to registry hash with online status', async () => {
      await worker.register();
      expect(mockRedis.hset).toHaveBeenCalledWith(
        'a2a:registry',
        'test-agent',
        expect.stringContaining('"status":"online"')
      );
    });

    test('includes lastSeen in register() entry so syncRegistryFromRedis() never falls back to epoch', async () => {
      const before = Date.now();
      await worker.register();
      const [,, rawEntry] = mockRedis.hset.mock.calls[0];
      const entry = JSON.parse(rawEntry);
      expect(typeof entry.lastSeen).toBe('number');
      expect(entry.lastSeen).toBeGreaterThanOrEqual(before);
    });

    test('sets EXPIRE on registry hash key using fixed large TTL (not per-worker TTL)', async () => {
      await worker.register();
      expect(mockRedis.expire).toHaveBeenCalledWith('a2a:registry', 3600);
    });

    test('sets per-agent TTL sentinel key', async () => {
      await worker.register();
      expect(mockRedis.set).toHaveBeenCalledWith(
        'a2a:registry:test-agent:ttl', '1', 'EX', DEFAULT_TTL
      );
    });

    test('uses custom heartbeatInterval for TTL calculation', async () => {
      const customWorker = new BaseWorker('agent-x', {
        redis: mockRedis,
        artifactStore: makeMockArtifactStore(),
        heartbeatInterval: 10000 // 10s → TTL = 30s
      });
      await customWorker.register();
      // Hash EXPIRE always uses fixed large TTL regardless of heartbeatInterval
      expect(mockRedis.expire).toHaveBeenCalledWith('a2a:registry', 3600);
      // Per-agent sentinel key still uses the heartbeat-derived TTL
      expect(mockRedis.set).toHaveBeenCalledWith('a2a:registry:agent-x:ttl', '1', 'EX', 30);
    });
  });

  // ─── deregister() ───────────────────────────────────────────────────────────

  describe('deregister()', () => {
    test('removes agent entry from registry hash', async () => {
      await worker.deregister();
      expect(mockRedis.hdel).toHaveBeenCalledWith('a2a:registry', 'test-agent');
    });

    test('deletes per-agent TTL sentinel key', async () => {
      await worker.deregister();
      expect(mockRedis.del).toHaveBeenCalledWith('a2a:registry:test-agent:ttl');
    });
  });

  // ─── formatResult() ─────────────────────────────────────────────────────────

  describe('formatResult()', () => {
    test('returns correct result shape', () => {
      const result = worker.formatResult(
        { task: 'list-files', taskId: 'task:123' },
        { files: [] },
        'completed'
      );
      expect(result).toMatchObject({
        type: 'result',
        taskId: 'task:123',
        agent: 'test-agent',
        task: 'list-files',
        status: 'completed',
        output: { files: [] },
        artifacts: [],
        error: null
      });
      expect(typeof result.durationMs).toBe('number');
      expect(typeof result.timestamp).toBe('string');
    });

    test('falls back to generated taskId when not provided', () => {
      const result = worker.formatResult({ task: 'do-thing' }, null, 'completed');
      expect(result.taskId).toMatch(/^task:\d+/);
    });

    test('includes provided artifacts array', () => {
      const result = worker.formatResult(
        { task: 't', taskId: 'x' },
        null,
        'completed',
        null,
        ['artifact-abc', 'artifact-xyz']
      );
      expect(result.artifacts).toEqual(['artifact-abc', 'artifact-xyz']);
    });

    test('captures error message on failure', () => {
      const result = worker.formatResult(
        { task: 't', taskId: 'x' },
        null,
        'failed',
        'Something went wrong'
      );
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Something went wrong');
    });
  });

  // ─── sendHeartbeat() ────────────────────────────────────────────────────────

  describe('sendHeartbeat()', () => {
    test('publishes heartbeat to a2a:heartbeats channel', async () => {
      await worker.sendHeartbeat();
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'a2a:heartbeats',
        expect.stringContaining('"type":"heartbeat"')
      );
    });

    test('heartbeat payload includes agent id and status', async () => {
      worker.running = true;
      await worker.sendHeartbeat();
      const [, payload] = mockRedis.publish.mock.calls[0];
      const hb = JSON.parse(payload);
      expect(hb.agent).toBe('test-agent');
      expect(hb.status).toBe('running');
    });

    test('refreshes registry hash entry with fresh lastSeen (issue #24 fix)', async () => {
      worker.running = true;
      await worker.sendHeartbeat();
      expect(mockRedis.hset).toHaveBeenCalledWith(
        'a2a:registry',
        'test-agent',
        expect.stringContaining('"lastSeen"')
      );
    });

    test('renews hash-level EXPIRE with a fixed large TTL to prevent fast workers shrinking it', async () => {
      worker.running = true;
      await worker.sendHeartbeat();
      // Must use a fixed constant (3600), not the per-worker TTL, so a short-interval
      // worker cannot shrink the shared hash key below a slow worker's heartbeat period.
      expect(mockRedis.expire).toHaveBeenCalledWith('a2a:registry', 3600);
    });

    test('renews per-agent TTL sentinel key on every heartbeat (issue #24 fix)', async () => {
      worker.running = true;
      await worker.sendHeartbeat();
      expect(mockRedis.set).toHaveBeenCalledWith(
        'a2a:registry:test-agent:ttl', '1', 'EX', DEFAULT_TTL
      );
    });

    test('skips registry writes when running=false (shutdown race guard)', async () => {
      worker.running = false;
      await worker.sendHeartbeat();
      // publish still fires (so the channel gets a final status), but HSET/SET must not
      expect(mockRedis.publish).toHaveBeenCalled();
      expect(mockRedis.hset).not.toHaveBeenCalled();
      expect(mockRedis.expire).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    test('preserves startedAt in registry entry after register()', async () => {
      await worker.register();
      worker.running = true; // required: guard skips HSET when running=false
      await worker.sendHeartbeat();
      const hsetCalls = mockRedis.hset.mock.calls;
      // Second HSET is the heartbeat one
      expect(hsetCalls.length).toBeGreaterThanOrEqual(2);
      const heartbeatEntry = JSON.parse(hsetCalls[hsetCalls.length - 1][2]);
      expect(heartbeatEntry.startedAt).toBeDefined();
      expect(heartbeatEntry.startedAt).toBe(worker.startedAt);
    });
  });

  // ─── pollTask() ─────────────────────────────────────────────────────────────

  describe('pollTask()', () => {
    test('returns null when brpoplpush times out', async () => {
      mockRedis.brpoplpush = vi.fn().mockResolvedValue(null);
      const result = await worker.pollTask();
      expect(result).toBeNull();
    });

    test('returns parsed task when brpoplpush returns a message', async () => {
      const task = { task: 'list-files', taskId: 'task:1', context: { path: '/tmp' } };
      mockRedis.brpoplpush = vi.fn().mockResolvedValue(JSON.stringify(task));
      mockRedis.expire = vi.fn().mockResolvedValue(1);
      const result = await worker.pollTask();
      expect(result).toEqual(task);
    });

    test('polls the correct inbox key with brpoplpush and sets pending TTL', async () => {
      mockRedis.brpoplpush = vi.fn().mockResolvedValue(JSON.stringify({ task: 'list-files', taskId: 'task:1' }));
      mockRedis.expire = vi.fn().mockResolvedValue(1);
      await worker.pollTask();
      expect(mockRedis.brpoplpush).toHaveBeenCalledWith(
        'a2a:inbox:test-agent',
        expect.stringMatching(/^a2a:pending:test-agent:/),
        expect.any(Number)
      );
      expect(mockRedis.expire).toHaveBeenCalledWith(
        expect.stringMatching(/^a2a:pending:test-agent:/),
        60
      );
    });

    test('returns null on brpoplpush error', async () => {
      mockRedis.brpoplpush = vi.fn().mockRejectedValue(new Error('connection lost'));
      const result = await worker.pollTask();
      expect(result).toBeNull();
    });
  });
});
