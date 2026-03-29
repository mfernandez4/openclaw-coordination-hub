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

    test('sets EXPIRE on registry hash key', async () => {
      await worker.register();
      expect(mockRedis.expire).toHaveBeenCalledWith('a2a:registry', DEFAULT_TTL);
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
      expect(mockRedis.expire).toHaveBeenCalledWith('a2a:registry', 30);
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
      await worker.sendHeartbeat();
      expect(mockRedis.hset).toHaveBeenCalledWith(
        'a2a:registry',
        'test-agent',
        expect.stringContaining('"lastSeen"')
      );
    });

    test('renews hash-level EXPIRE on every heartbeat so key never silently expires', async () => {
      await worker.sendHeartbeat();
      expect(mockRedis.expire).toHaveBeenCalledWith('a2a:registry', DEFAULT_TTL);
    });

    test('renews per-agent TTL sentinel key on every heartbeat (issue #24 fix)', async () => {
      await worker.sendHeartbeat();
      expect(mockRedis.set).toHaveBeenCalledWith(
        'a2a:registry:test-agent:ttl', '1', 'EX', DEFAULT_TTL
      );
    });

    test('preserves startedAt in registry entry after register()', async () => {
      await worker.register();
      await worker.sendHeartbeat();
      const hsetCalls = mockRedis.hset.mock.calls;
      // Second HSET is the heartbeat one
      const heartbeatEntry = JSON.parse(hsetCalls[hsetCalls.length - 1][2]);
      expect(heartbeatEntry.startedAt).toBeDefined();
      expect(heartbeatEntry.startedAt).toBe(worker.startedAt);
    });
  });

  // ─── pollTask() ─────────────────────────────────────────────────────────────

  describe('pollTask()', () => {
    test('returns null when blpop times out', async () => {
      mockRedis.blpop = vi.fn().mockResolvedValue(null);
      const result = await worker.pollTask();
      expect(result).toBeNull();
    });

    test('returns parsed task when blpop returns a message', async () => {
      const task = { task: 'list-files', taskId: 'task:1', context: { path: '/tmp' } };
      mockRedis.blpop = vi.fn().mockResolvedValue([
        'a2a:inbox:test-agent',
        JSON.stringify(task)
      ]);
      const result = await worker.pollTask();
      expect(result).toEqual(task);
    });

    test('polls the correct inbox key', async () => {
      await worker.pollTask();
      expect(mockRedis.blpop).toHaveBeenCalledWith(
        'a2a:inbox:test-agent',
        expect.any(Number)
      );
    });

    test('returns null on blpop error', async () => {
      mockRedis.blpop = vi.fn().mockRejectedValue(new Error('connection lost'));
      const result = await worker.pollTask();
      expect(result).toBeNull();
    });
  });
});
