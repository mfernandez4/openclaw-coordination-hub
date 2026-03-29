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
