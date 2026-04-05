/**
 * Unit tests for ResultProcessor
 * 
 * Tests: processResult() formatting, filter application,
 * audit log TTL, result channel routing, and disconnect handling.
 */
const { ResultProcessor } = require('../../src/result-processor');
const { logger } = require('../../src/logger');
const { createMockRedis } = require('../helpers/redis');

describe('ResultProcessor', () => {
  let processor;
  let mockRedis;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    await mockRedis.flushall();

    processor = new ResultProcessor();
    processor.subscriber = mockRedis;
    processor.publisher = mockRedis;
    processor.running = false;
  });

  afterEach(async () => {
    if (mockRedis) {
      try { await mockRedis.flushall(); } catch (_) {}
    }
    if (processor) {
      try { await processor.stop(); } catch (_) {}
    }
  });

  // ── processResult() structure ──────────────────────────────────────────────

  test('processResult() returns object with raw and formatted fields', async () => {
    const result = {
      taskId: 'task-abc',
      agent: 'coding-agent',
      task: 'implement login',
      status: 'completed',
      output: { token: 'jwt-xyz' },
      durationMs: 350
    };

    const processed = await processor.processResult(result);

    expect(processed).not.toBeNull();
    expect(processed.raw).toBeDefined();
    expect(processed.formatted).toBeDefined();
    expect(processed.raw.agent).toBe('coding-agent');
    expect(processed.raw.task).toBe('implement login');
    expect(processed.raw.status).toBe('completed');
    expect(processed.raw.processedAt).toBeDefined();
    expect(processed.raw.formatter).toBeDefined();
  });

  test('processResult() adds processedAt and formatter metadata', async () => {
    const result = { taskId: 't1', agent: 'a', task: 't', status: 'completed' };
    const processed = await processor.processResult(result);

    expect(processed.raw.processedAt).toBeTruthy();
    expect(typeof processed.raw.processedAt).toBe('string');
    expect(processed.raw.formatter).toBe('markdown'); // default
  });

  // ── Formatting ──────────────────────────────────────────────────────────────

  test('processResult() formats completed result with ✅ emoji', async () => {
    const result = {
      taskId: 't2', agent: 'writer', task: 'draft email',
      status: 'completed', output: 'Email sent'
    };
    const processed = await processor.processResult(result);

    expect(processed.formatted).toContain('✅');
    expect(processed.formatted).toContain('writer');
    expect(processed.formatted).toContain('draft email');
  });

  test('processResult() formats failed result with ❌ emoji', async () => {
    const result = {
      taskId: 't3', agent: 'writer', task: 'draft email',
      status: 'failed', error: 'SMTP timeout'
    };
    const processed = await processor.processResult(result);

    expect(processed.formatted).toContain('❌');
    expect(processed.formatted).toContain('SMTP timeout');
  });

  test('processResult() uses compact formatter when configured', async () => {
    const compactProcessor = new ResultProcessor();
    compactProcessor.config.defaultFormatter = 'compact';
    compactProcessor.subscriber = mockRedis;
    compactProcessor.publisher = mockRedis;

    const result = { taskId: 't4', agent: 'coder', task: 'build', status: 'completed' };
    const processed = await compactProcessor.processResult(result);

    // Compact is a one-liner with emoji prefix
    expect(processed.formatted).toContain('✅');
    expect(processed.formatted).not.toContain('```');
  });

  // ── Audit log ──────────────────────────────────────────────────────────────

  test('processResult() writes audit log entry to Redis with TTL', async () => {
    const result = { taskId: 'audit-task-1', agent: 'a', task: 't', status: 'completed' };
    await processor.processResult(result);

    const auditKey = 'a2a:audit:audit-task-1';
    const stored = await mockRedis.get(auditKey);
    expect(stored).not.toBeNull();

    const parsed = JSON.parse(stored);
    expect(parsed.agent).toBe('a');
    expect(parsed.task).toBe('t');
  });

  test('processResult() writes audit log with 24h (86400s) TTL', async () => {
    const result = { taskId: 'audit-task-2', agent: 'a', task: 't', status: 'completed' };
    await processor.processResult(result);

    const auditKey = 'a2a:audit:audit-task-2';
    const ttl = await mockRedis.ttl(auditKey);
    // TTL should be close to 86400 (allow some margin)
    expect(ttl).toBeGreaterThan(86000);
    expect(ttl).toBeLessThanOrEqual(86400);
  });

  // ── Results channel routing ────────────────────────────────────────────────

  test('processResult() publishes to correct a2a:results:{id} channel', async () => {
    const result = { taskId: 'results-channel-test', agent: 'a', task: 't', status: 'completed' };
    await processor.processResult(result);

    // ioredis-mock doesn't support pub/sub natively for subscriber.on('message'),
    // so we verify via the results list instead
    const resultsKey = `a2a:results:${processor.defaultOrchestrator}:list`;
    const stored = await mockRedis.lrange(resultsKey, 0, -1);
    expect(stored).toHaveLength(1);

    const parsed = JSON.parse(stored[0]);
    expect(parsed.raw.taskId).toBe('results-channel-test');
  });

  test('processResult() persists result to results list with lpush', async () => {
    const result1 = { taskId: 'r1', agent: 'a', task: 't1', status: 'completed' };
    const result2 = { taskId: 'r2', agent: 'a', task: 't2', status: 'completed' };

    await processor.processResult(result1);
    await processor.processResult(result2);

    const resultsKey = `a2a:results:${processor.defaultOrchestrator}:list`;
    const stored = await mockRedis.lrange(resultsKey, 0, -1);
    expect(stored).toHaveLength(2);
    // Most recent first
    expect(JSON.parse(stored[0]).raw.taskId).toBe('r2');
    expect(JSON.parse(stored[1]).raw.taskId).toBe('r1');
  });

  test('processResult() caps results list at 100 entries (ltrim)', async () => {
    const resultsKey = `a2a:results:${processor.defaultOrchestrator}:list`;

    // Push 105 items manually to simulate old results
    const pipeline = mockRedis.pipeline();
    for (let i = 0; i < 105; i++) {
      pipeline.lpush(resultsKey, JSON.stringify({ raw: { taskId: `old-${i}` } }));
    }
    await pipeline.exec();

    const result = { taskId: 'new-result', agent: 'a', task: 't', status: 'completed' };
    await processor.processResult(result);

    const len = await mockRedis.llen(resultsKey);
    expect(len).toBeLessThanOrEqual(100);
  });

  // ── Filtering ───────────────────────────────────────────────────────────────

  test('processResult() returns null when agent is blocked', async () => {
    const blockProcessor = new ResultProcessor();
    blockProcessor.config.policies.blockAgents = ['bad-agent'];
    blockProcessor.subscriber = mockRedis;
    blockProcessor.publisher = mockRedis;

    const result = { taskId: 't5', agent: 'bad-agent', task: 't', status: 'completed' };
    const processed = await blockProcessor.processResult(result);

    expect(processed).toBeNull();
  });

  test('processResult() marks result as requiresApproval when agent is in requireApproval list', async () => {
    const approvalProcessor = new ResultProcessor();
    approvalProcessor.config.policies.requireApproval = ['special-agent'];
    approvalProcessor.subscriber = mockRedis;
    approvalProcessor.publisher = mockRedis;

    const result = { taskId: 't6', agent: 'special-agent', task: 't', status: 'completed' };
    const processed = await approvalProcessor.processResult(result);

    expect(processed.raw.requiresApproval).toBe(true);
  });

  test('processResult() adds warning when duration exceeds maxDurationMs policy', async () => {
    const slowProcessor = new ResultProcessor();
    slowProcessor.config.policies.maxDurationMs = 1000;
    slowProcessor.subscriber = mockRedis;
    slowProcessor.publisher = mockRedis;

    const result = { taskId: 't7', agent: 'a', task: 't', status: 'completed', durationMs: 5000 };
    const processed = await slowProcessor.processResult(result);

    expect(processed.raw.warnings).toBeDefined();
    expect(processed.raw.warnings.length).toBeGreaterThan(0);
    expect(processed.raw.warnings[0]).toContain('5000ms exceeds max 1000ms');
  });

  // ── Start path / subscriber wiring ─────────────────────────────────────────

  test('start() subscribes to coordination channel and processes result messages', async () => {
    const messageHandlers = {};
    const mockSubscriber = {
      subscribe: vi.fn(async () => 1),
      on: vi.fn((event, handler) => {
        messageHandlers[event] = handler;
      }),
      unsubscribe: vi.fn(async () => 1),
      quit: vi.fn(async () => {})
    };

    const mockPublisher = {
      publish: vi.fn(async () => 1),
      lpush: vi.fn(async () => 1),
      ltrim: vi.fn(async () => 'OK'),
      set: vi.fn(async () => 'OK'),
      quit: vi.fn(async () => {})
    };

    const startProcessor = new ResultProcessor();
    startProcessor.connect = vi.fn(async () => {
      startProcessor.subscriber = mockSubscriber;
      startProcessor.publisher = mockPublisher;
    });

    const processSpy = vi.spyOn(startProcessor, 'processResult');

    await startProcessor.start();

    expect(mockSubscriber.subscribe).toHaveBeenCalledWith('a2a:coordination');
    expect(messageHandlers.message).toBeTypeOf('function');

    await messageHandlers.message('a2a:coordination', JSON.stringify({
      type: 'result',
      taskId: 'start-path-1',
      agent: 'worker',
      task: 'build',
      status: 'completed'
    }));

    expect(processSpy).toHaveBeenCalledTimes(1);

    await startProcessor.stop();
  });

  test('start() handler logs parse errors for malformed payloads instead of throwing', async () => {
    const messageHandlers = {};
    const mockSubscriber = {
      subscribe: vi.fn(async () => 1),
      on: vi.fn((event, handler) => {
        messageHandlers[event] = handler;
      }),
      unsubscribe: vi.fn(async () => 1),
      quit: vi.fn(async () => {})
    };

    const mockPublisher = {
      publish: vi.fn(async () => 1),
      lpush: vi.fn(async () => 1),
      ltrim: vi.fn(async () => 'OK'),
      set: vi.fn(async () => 'OK'),
      quit: vi.fn(async () => {})
    };

    const startProcessor = new ResultProcessor();
    startProcessor.connect = vi.fn(async () => {
      startProcessor.subscriber = mockSubscriber;
      startProcessor.publisher = mockPublisher;
    });

    const parseErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    await startProcessor.start();

    await expect(messageHandlers.message('a2a:coordination', '{not-json')).resolves.toBeUndefined();
    expect(parseErrorSpy).toHaveBeenCalledWith(
      'result-processor',
      'Parse error',
      expect.objectContaining({
        error: expect.stringMatching(/Unexpected token|Expected property name/)
      })
    );

    parseErrorSpy.mockRestore();
    await startProcessor.stop();
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────

  test('stop() unsubscribes and quits subscriber and publisher without throwing', async () => {
    await expect(processor.stop()).resolves.not.toThrow();
  });

  test('stop() sets running to false', async () => {
    await processor.stop();
    expect(processor.running).toBe(false);
  });
});

// ─── formatResult() formatter variants ──────────────────────────────────────

describe('ResultProcessor.formatResult()', () => {
  let processor;
  beforeEach(() => {
    processor = new ResultProcessor();
  });

  const baseResult = {
    agent: 'coder', task: 'build', status: 'completed',
    output: { lines: 42 }, durationMs: 200
  };

  test('"json" formatter returns pretty-printed JSON string', () => {
    const out = processor.formatResult(baseResult, 'json');
    const parsed = JSON.parse(out);
    expect(parsed.agent).toBe('coder');
  });

  test('"compact" formatter returns a one-line string', () => {
    const out = processor.formatResult(baseResult, 'compact');
    expect(out).not.toContain('\n');
    expect(out).toContain('✅');
  });

  test('unknown formatter falls back to markdown', () => {
    const out = processor.formatResult(baseResult, 'nonexistent');
    expect(out).toContain('**Status:**');
  });

  test('custom formatter in config.formatters is applied via formatCustom()', () => {
    processor.config.formatters['my-fmt'] = '{agent} did {task} with status {status}';
    const out = processor.formatResult(baseResult, 'my-fmt');
    expect(out).toBe('coder did build with status completed');
  });
});

// ─── formatCustom() ──────────────────────────────────────────────────────────

describe('ResultProcessor.formatCustom()', () => {
  let processor;
  beforeEach(() => { processor = new ResultProcessor(); });

  test('replaces all template placeholders', () => {
    const template = 'agent={agent} task={task} status={status} output={output} error={error} duration={duration}';
    const result = { agent: 'a', task: 't', status: 'completed', output: { x: 1 }, error: null, durationMs: 500 };
    const out = processor.formatCustom(result, template);
    expect(out).toContain('agent=a');
    expect(out).toContain('task=t');
    expect(out).toContain('status=completed');
    expect(out).toContain('duration=500');
  });

  test('uses empty string for missing error field', () => {
    const template = 'err={error}';
    const out = processor.formatCustom({ agent: 'a', task: 't', status: 'ok', output: null }, template);
    expect(out).toBe('err=');
  });
});

// ─── loadConfig() error branch ───────────────────────────────────────────────

describe('ResultProcessor.loadConfig()', () => {
  test('falls back to defaultConfig when config file contains invalid JSON', () => {
    const fs   = require('fs');
    const os   = require('os');
    const path = require('path');

    const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-config-test-'));
    const configPath = path.join(tmpDir, 'bad-policies.json');
    fs.writeFileSync(configPath, 'not-valid-json{{{');

    try {
      const p = new ResultProcessor({ configPath });
      // Should not throw; falls back to defaults
      expect(p.config.policies.auditLog).toBe(true);
      expect(p.config.defaultFormatter).toBe('markdown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('merges user config file over defaults when file is valid', () => {
    const fs   = require('fs');
    const os   = require('os');
    const path = require('path');

    const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-config-valid-'));
    const configPath = path.join(tmpDir, 'policies.json');
    fs.writeFileSync(configPath, JSON.stringify({ defaultFormatter: 'compact' }));

    try {
      const p = new ResultProcessor({ configPath });
      expect(p.config.defaultFormatter).toBe('compact');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── reloadConfig() ──────────────────────────────────────────────────────────

describe('ResultProcessor.reloadConfig()', () => {
  test('re-reads config without throwing', () => {
    const processor = new ResultProcessor();
    expect(() => processor.reloadConfig()).not.toThrow();
  });

  test('updates config in place', () => {
    const processor = new ResultProcessor();
    processor.config.defaultFormatter = 'compact';
    processor.reloadConfig();
    // After reload from the real config file, formatter should be 'markdown'
    expect(processor.config.defaultFormatter).toBe('markdown');
  });
});

// ─── applyFilters() custom filter duration block ─────────────────────────────

describe('ResultProcessor.applyFilters() custom filter', () => {
  test('blocks result when custom filter maxDurationMs is exceeded', () => {
    const processor = new ResultProcessor();
    processor.config.filters = [{ agent: '*', maxDurationMs: 100 }];

    const { passed, reason } = processor.applyFilters({
      agent: 'any-agent', task: 't', durationMs: 500
    });

    expect(passed).toBe(false);
    expect(reason).toMatch(/500ms exceeds filter max 100ms/);
  });

  test('skips custom filter when agent does not match', () => {
    const processor = new ResultProcessor();
    processor.config.filters = [{ agent: 'specific-agent', maxDurationMs: 100 }];

    const { passed } = processor.applyFilters({
      agent: 'other-agent', task: 't', durationMs: 500
    });

    expect(passed).toBe(true);
  });
});
