/**
 * Unit tests for Mem0Adapter
 *
 * Tests: fallback behavior, initialization failure handling,
 * and runtime search/addMemory delegation to MemoryBridge.
 */
const { Mem0Adapter } = require('../../src/mem0-adapter');

// Minimal MemoryBridge stub for dependency injection
function makeStubBridge() {
  return {
    getRecentSessions: vi.fn(async () => [{ stub: true }]),
    recordAgentEvent: vi.fn(async () => ({ stub: true }))
  };
}

describe('Mem0Adapter', () => {

  beforeEach(() => {
    // Ensure env vars don't leak between tests
    delete process.env.MEM0_ENABLED;
    delete process.env.MEM0_API_KEY;
    delete process.env.MEM0_BASE_URL;
    // Reset global fetch mock if set
    if (global.fetch && global.fetch.mockRestore) global.fetch.mockRestore();
  });

  // ── Disabled by default ─────────────────────────────────────────────────────

  test('isEnabled() returns false when MEM0_ENABLED is not set', () => {
    const adapter = new Mem0Adapter({ fallbackBridge: makeStubBridge() });
    expect(adapter.isEnabled()).toBe(false);
  });

  test('initialize() returns false and logs when disabled', async () => {
    const adapter = new Mem0Adapter({ fallbackBridge: makeStubBridge() });
    const result = await adapter.initialize();
    expect(result).toBe(false);
    expect(adapter.isEnabled()).toBe(false);
  });

  // ── Missing API key fallback ────────────────────────────────────────────────

  test('constructor disables and does not throw when MEM0_ENABLED=true but no API key', () => {
    process.env.MEM0_ENABLED = 'true';
    expect(() => new Mem0Adapter({ fallbackBridge: makeStubBridge() })).not.toThrow();
    const adapter = new Mem0Adapter({ fallbackBridge: makeStubBridge() });
    expect(adapter.isEnabled()).toBe(false);
  });

  test('search() delegates to MemoryBridge when disabled (no API key)', async () => {
    process.env.MEM0_ENABLED = 'true';
    const bridge = makeStubBridge();
    const adapter = new Mem0Adapter({ fallbackBridge: bridge });

    const results = await adapter.search('test query');

    expect(bridge.getRecentSessions).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ stub: true }]);
  });

  test('addMemory() delegates to MemoryBridge when disabled (no API key)', async () => {
    process.env.MEM0_ENABLED = 'true';
    const bridge = makeStubBridge();
    const adapter = new Mem0Adapter({ fallbackBridge: bridge });

    await adapter.addMemory('some content', { agentId: 'test-agent' });

    expect(bridge.recordAgentEvent).toHaveBeenCalledWith('test-agent', 'memory', { content: 'some content' });
  });

  // ── Connection failure fallback ─────────────────────────────────────────────

  test('initialize() disables and does not throw when fetch fails (unreachable URL)', async () => {
    const bridge = makeStubBridge();
    const adapter = new Mem0Adapter({
      enabled: true,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:19999', // nothing listening here
      fallbackBridge: bridge
    });

    // Mock fetch to simulate network failure
    global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const result = await adapter.initialize();

    expect(result).toBe(false);
    expect(adapter.isEnabled()).toBe(false);

    global.fetch = undefined;
  });

  test('initialize() disables when health check returns non-OK status', async () => {
    const bridge = makeStubBridge();
    const adapter = new Mem0Adapter({
      enabled: true,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8000',
      fallbackBridge: bridge
    });

    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const result = await adapter.initialize();

    expect(result).toBe(false);
    expect(adapter.isEnabled()).toBe(false);

    global.fetch = undefined;
  });

  // ── Runtime fallback on search/addMemory failure ────────────────────────────

  test('search() falls back to MemoryBridge when fetch throws at runtime', async () => {
    const bridge = makeStubBridge();
    const adapter = new Mem0Adapter({
      enabled: true,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8000',
      fallbackBridge: bridge
    });
    // Skip initialize — manually set enabled
    adapter.enabled = true;

    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const results = await adapter.search('query');

    expect(bridge.getRecentSessions).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ stub: true }]);

    global.fetch = undefined;
  });

  test('addMemory() falls back to MemoryBridge when fetch throws at runtime', async () => {
    const bridge = makeStubBridge();
    const adapter = new Mem0Adapter({
      enabled: true,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8000',
      fallbackBridge: bridge
    });
    adapter.enabled = true;

    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    await adapter.addMemory('content', { agentId: 'worker-1' });

    expect(bridge.recordAgentEvent).toHaveBeenCalledWith('worker-1', 'memory', { content: 'content' });

    global.fetch = undefined;
  });

  // ── Disabled path (MEM0_ENABLED not set) ────────────────────────────────────

  test('search() with disabled adapter returns MemoryBridge sessions', async () => {
    const bridge = makeStubBridge();
    const adapter = new Mem0Adapter({ fallbackBridge: bridge });

    const results = await adapter.search('anything');
    expect(bridge.getRecentSessions).toHaveBeenCalled();
    expect(results).toEqual([{ stub: true }]);
  });

  test('addMemory() with disabled adapter delegates to MemoryBridge recordAgentEvent', async () => {
    const bridge = makeStubBridge();
    const adapter = new Mem0Adapter({ fallbackBridge: bridge });

    await adapter.addMemory('log this', { agentId: 'hub' });
    expect(bridge.recordAgentEvent).toHaveBeenCalledWith('hub', 'memory', { content: 'log this' });
  });

  // ── Happy paths when Mem0 is enabled and reachable ─────────────────────────

  test('initialize() returns true when health check succeeds', async () => {
    const adapter = new Mem0Adapter({
      enabled: true, apiKey: 'key', baseUrl: 'http://mem0.local',
      fallbackBridge: makeStubBridge()
    });

    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const result = await adapter.initialize();

    expect(result).toBe(true);
    expect(adapter.isEnabled()).toBe(true);
    global.fetch = undefined;
  });

  test('search() returns results from Mem0 when enabled and fetch succeeds', async () => {
    const adapter = new Mem0Adapter({
      enabled: true, apiKey: 'key', baseUrl: 'http://mem0.local',
      fallbackBridge: makeStubBridge()
    });
    adapter.enabled = true;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ memory: 'past event' }] })
    });

    const results = await adapter.search('query', { userId: 'u1', agentId: 'a1', limit: 5 });
    expect(results).toEqual([{ memory: 'past event' }]);
    global.fetch = undefined;
  });

  test('search() returns empty array when Mem0 response has no results field', async () => {
    const adapter = new Mem0Adapter({
      enabled: true, apiKey: 'key', baseUrl: 'http://mem0.local',
      fallbackBridge: makeStubBridge()
    });
    adapter.enabled = true;

    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    const results = await adapter.search('query');
    expect(results).toEqual([]);
    global.fetch = undefined;
  });

  test('addMemory() returns Mem0 response when enabled and fetch succeeds', async () => {
    const adapter = new Mem0Adapter({
      enabled: true, apiKey: 'key', baseUrl: 'http://mem0.local',
      fallbackBridge: makeStubBridge()
    });
    adapter.enabled = true;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'mem-123', status: 'created' })
    });

    const result = await adapter.addMemory('learned something', { agentId: 'hub', userId: 'u1' });
    expect(result.id).toBe('mem-123');
    global.fetch = undefined;
  });
});
