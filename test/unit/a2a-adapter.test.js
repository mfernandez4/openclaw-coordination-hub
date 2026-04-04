/**
 * Unit tests for A2AAdapter.
 *
 * Focus on routing behavior, subscription wiring, and message semantics.
 */
const { A2AAdapter } = require('../../src/a2a-adapter');

class MockPubSub {
  constructor() {
    this.channels = new Map(); // channel -> Set<handler>
    this.published = [];       // record all published messages
    this.subscribedChannels = [];
  }

  async publish(channel, data) {
    this.published.push({ channel, data });
    const handlers = this.channels.get(channel);
    if (handlers) {
      for (const h of handlers) h(data);
    }
    return 1;
  }

  async subscribe(channel, handler) {
    this.subscribedChannels.push(channel);
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel).add(handler);
    return 1;
  }

  emit(channel, data) {
    const handlers = this.channels.get(channel);
    if (handlers) {
      for (const h of handlers) h(data);
    }
  }
}

describe('A2AAdapter', () => {
  let adapter;
  let mockPubSub;

  beforeEach(() => {
    mockPubSub = new MockPubSub();
    adapter = new A2AAdapter({ agentId: 'hub-test', pubsub: mockPubSub });
  });

  test('initialize() subscribes required channels and registers self', async () => {
    await adapter.initialize(mockPubSub);

    expect(mockPubSub.subscribedChannels).toContain('a2a:agents');
    expect(mockPubSub.subscribedChannels).toContain('a2a:coordination');
    expect(mockPubSub.subscribedChannels).toContain('a2a:inbox:hub-test');

    const self = adapter.getAgent('hub-test');
    expect(self).toBeDefined();
    expect(self.status).toBe('online');
    expect(self.capabilities).toEqual([]);
  });

  test('registerAgent() adds agent to local registry', () => {
    adapter.registerAgent('worker-1', { capabilities: ['coding'] });
    const agent = adapter.getAgent('worker-1');

    expect(agent).not.toBeNull();
    expect(agent.capabilities).toContain('coding');
    expect(agent.status).toBe('online');
  });

  test('getOnlineAgents() excludes stale agents (heartbeat > 60s)', () => {
    const now = Date.now();

    adapter.registry.set('fresh-agent', {
      id: 'fresh-agent',
      status: 'online',
      lastSeen: now - 10_000,
      capabilities: []
    });

    adapter.registry.set('stale-agent', {
      id: 'stale-agent',
      status: 'online',
      lastSeen: now - 90_000,
      capabilities: []
    });

    const onlineIds = adapter.getOnlineAgents().map((a) => a.id);
    expect(onlineIds).toContain('fresh-agent');
    expect(onlineIds).not.toContain('stale-agent');
  });

  test('sendTo() publishes directed message to target inbox channel', async () => {
    await adapter.sendTo('worker-1', 'task', { description: 'do work' });

    expect(mockPubSub.published).toHaveLength(1);
    const [pub] = mockPubSub.published;

    expect(pub.channel).toBe('a2a:inbox:worker-1');
    expect(pub.data.to).toBe('worker-1');
    expect(pub.data.from).toBe('hub-test');
    expect(pub.data.type).toBe('task');
    expect(pub.data.payload.description).toBe('do work');
  });

  test('broadcast() publishes to a2a:agents with to="*"', async () => {
    await adapter.broadcast('task', { msg: 'hello all' });

    expect(mockPubSub.published).toHaveLength(1);
    const [pub] = mockPubSub.published;

    expect(pub.channel).toBe('a2a:agents');
    expect(pub.data.to).toBe('*');
    expect(pub.data.type).toBe('task');
  });

  test('handleBroadcast() routes wildcard messages to handleMessage()', () => {
    const handleSpy = vi.spyOn(adapter, 'handleMessage').mockImplementation(() => {});

    adapter.handleBroadcast({ type: 'task', from: 'x', to: '*', payload: {} });

    expect(handleSpy).toHaveBeenCalledTimes(1);
  });

  test('handleBroadcast() ignores messages targeted to another agent', () => {
    const handleSpy = vi.spyOn(adapter, 'handleMessage').mockImplementation(() => {});

    adapter.handleBroadcast({ type: 'task', from: 'x', to: 'other-agent', payload: {} });

    expect(handleSpy).not.toHaveBeenCalled();
  });

  test('handleInbox() only routes messages targeted to this adapter agentId', () => {
    const handleSpy = vi.spyOn(adapter, 'handleMessage').mockImplementation(() => {});

    adapter.handleInbox({ type: 'task', from: 'x', to: 'hub-test', payload: {} });
    adapter.handleInbox({ type: 'task', from: 'x', to: 'someone-else', payload: {} });

    expect(handleSpy).toHaveBeenCalledTimes(1);
  });

  test('handleMessage() routes known types to their handlers', () => {
    const taskSpy = vi.spyOn(adapter, 'handleTask').mockImplementation(() => {});
    const ackSpy = vi.spyOn(adapter, 'handleAck').mockImplementation(() => {});

    adapter.handleMessage({ type: 'task', from: 'a', to: 'hub-test', payload: { x: 1 } });
    adapter.handleMessage({ type: 'ack', from: 'b', to: 'hub-test', payload: { ok: true } });

    expect(taskSpy).toHaveBeenCalledTimes(1);
    expect(ackSpy).toHaveBeenCalledTimes(1);
  });

  test('handleMessage() warns and ignores unknown message types', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    adapter.handleMessage({ type: 'unknown-type', from: 'x', to: 'y', payload: {} });

    // logger.warn emits JSON via console.log — verify a warn entry was emitted
    const output = consoleSpy.mock.calls.flat().join('');
    expect(output).toContain('Unknown message type');
    consoleSpy.mockRestore();
  });

  test('handleHeartbeat() updates lastSeen for registered agents', () => {
    adapter.registerAgent('worker-1', {
      status: 'online',
      lastSeen: Date.now() - 100_000
    });

    adapter.handleHeartbeat('worker-1', { status: 'busy' });

    const agent = adapter.getAgent('worker-1');
    expect(agent.status).toBe('busy');
    expect(agent.lastSeen).toBeGreaterThan(Date.now() - 1000);
  });

  test('getStatus() reports filtered online count and total registered count', () => {
    const now = Date.now();

    adapter.registry.set('online-agent', {
      id: 'online-agent',
      status: 'online',
      lastSeen: now,
      capabilities: []
    });

    adapter.registry.set('stale-agent', {
      id: 'stale-agent',
      status: 'online',
      lastSeen: now - 90_000,
      capabilities: []
    });

    const status = adapter.getStatus();
    expect(status.agentId).toBe('hub-test');
    expect(status.inbox).toBe('a2a:inbox:hub-test');
    expect(status.onlineAgents).toBe(1);
    expect(status.registeredAgents).toBe(2);
  });
});

// ─── syncRegistryFromRedis() ─────────────────────────────────────────────────

describe('A2AAdapter.syncRegistryFromRedis()', () => {
  // Use a short staleAgentMs so tests don't depend on the 90s default.
  // This also validates that the threshold is actually configurable.
  const STALE_MS = 5000;

  function makeAdapterWithClient(clientOverrides = {}, adapterOptions = {}) {
    const mockClient = {
      hgetall: vi.fn().mockResolvedValue(null),
      mget:    vi.fn().mockResolvedValue([]),
      hdel:    vi.fn().mockResolvedValue(1),
      hset:    vi.fn().mockResolvedValue(1),
      ...clientOverrides
    };
    const pubsub = { client: mockClient };
    const adapter = new A2AAdapter({ agentId: 'hub', pubsub, staleAgentMs: STALE_MS, ...adapterOptions });
    return { adapter, mockClient };
  }

  test('does nothing when hgetall returns null (empty registry)', async () => {
    const { adapter, mockClient } = makeAdapterWithClient({
      hgetall: vi.fn().mockResolvedValue(null)
    });
    await adapter.syncRegistryFromRedis();
    expect(adapter.getAllAgents()).toHaveLength(0);
    expect(mockClient.hdel).not.toHaveBeenCalled();
  });

  test('populates in-memory registry from Redis entries with live sentinels', async () => {
    const { adapter, mockClient } = makeAdapterWithClient({
      hgetall: vi.fn().mockResolvedValue({
        'worker-a': JSON.stringify({ status: 'online', lastSeen: Date.now(), capabilities: [] })
      }),
      mget: vi.fn().mockResolvedValue(['1']) // sentinel exists
    });
    await adapter.syncRegistryFromRedis();
    expect(adapter.getAgent('worker-a')).toBeDefined();
    expect(mockClient.hdel).not.toHaveBeenCalled();
  });

  test('uses lastSeen=0 fallback (not Date.now()) for entries missing lastSeen', async () => {
    const { adapter, mockClient } = makeAdapterWithClient({
      hgetall: vi.fn().mockResolvedValue({
        'worker-a': JSON.stringify({ status: 'online', capabilities: [] }) // no lastSeen
      }),
      mget: vi.fn().mockResolvedValue(['1']) // sentinel exists — don't prune
    });
    await adapter.syncRegistryFromRedis();
    const entry = adapter.getAgent('worker-a');
    expect(entry.lastSeen).toBe(0); // must not fall back to Date.now()
  });

  test('prunes entry when sentinel is expired and lastSeen is stale (>staleAgentMs)', async () => {
    const staleLastSeen = Date.now() - (STALE_MS + 5000); // well beyond the threshold
    const { adapter, mockClient } = makeAdapterWithClient({
      hgetall: vi.fn().mockResolvedValue({
        'crashed-worker': JSON.stringify({ status: 'online', lastSeen: staleLastSeen, capabilities: [] })
      }),
      mget: vi.fn().mockResolvedValue([null]) // sentinel expired
    });
    await adapter.syncRegistryFromRedis();
    expect(mockClient.hdel).toHaveBeenCalledWith('a2a:registry', 'crashed-worker');
    expect(adapter.getAgent('crashed-worker')).toBeUndefined();
  });

  test('does NOT prune entry when sentinel expired but lastSeen is recent (<staleAgentMs)', async () => {
    const recentLastSeen = Date.now() - 1000; // 1s ago — within the 5s threshold
    const { adapter, mockClient } = makeAdapterWithClient({
      hgetall: vi.fn().mockResolvedValue({
        'slow-worker': JSON.stringify({ status: 'online', lastSeen: recentLastSeen, capabilities: [] })
      }),
      mget: vi.fn().mockResolvedValue([null]) // sentinel expired but lastSeen is fresh
    });
    await adapter.syncRegistryFromRedis();
    expect(mockClient.hdel).not.toHaveBeenCalled();
    expect(adapter.getAgent('slow-worker')).toBeDefined();
  });

  test('never prunes self (hub has no sentinel)', async () => {
    const staleLastSeen = Date.now() - (STALE_MS + 5000);
    const { adapter, mockClient } = makeAdapterWithClient({
      hgetall: vi.fn().mockResolvedValue({
        'hub': JSON.stringify({ status: 'online', lastSeen: staleLastSeen, capabilities: [] })
      }),
      mget: vi.fn().mockResolvedValue([null]) // no sentinel for hub
    });
    await adapter.syncRegistryFromRedis();
    expect(mockClient.hdel).not.toHaveBeenCalled(); // must not prune self
    expect(adapter.getAgent('hub')).toBeDefined();
  });
});
