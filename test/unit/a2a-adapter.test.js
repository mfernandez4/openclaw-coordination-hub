/**
 * Unit tests for A2AAdapter
 *
 * Tests: getOnlineAgents, broadcast, sendTo, handoff,
 * agent registration, and message handling.
 */
const { A2AAdapter } = require('../../src/a2a-adapter');
const { createMockPubSub } = require('../helpers/redis');

// Minimal in-memory pub/sub stand-in that A2AAdapter can use
class MockPubSub {
  constructor() {
    this.channels = new Map(); // channel -> Set<handler>
    this.published = [];       // record all published messages
  }

  async publish(channel, data) {
    this.published.push({ channel, data });
    const handlers = this.channels.get(channel);
    if (handlers) {
      for (const h of handlers) h(data);
    }
    return 0;
  }

  async subscribe(channel, handler) {
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel).add(handler);
  }

  async unsubscribe(channel) {
    this.channels.delete(channel);
  }
}

describe('A2AAdapter', () => {
  let adapter;
  let mockPubSub;

  beforeEach(() => {
    mockPubSub = new MockPubSub();
    adapter = new A2AAdapter({ agentId: 'hub-test', pubsub: mockPubSub });
  });

  // ── Agent registry ─────────────────────────────────────────────────────────

  test('registerAgent() adds agent to local registry', () => {
    adapter.registerAgent('worker-1', { capabilities: ['coding'] });
    const agent = adapter.getAgent('worker-1');
    expect(agent).not.toBeNull();
    expect(agent.capabilities).toContain('coding');
    expect(agent.status).toBe('online');
  });

  test('getAgent() returns undefined for unknown agent', () => {
    expect(adapter.getAgent('nobody')).toBeUndefined();
  });

  test('getAllAgents() returns all registered agents', () => {
    adapter.registerAgent('a1', {});
    adapter.registerAgent('a2', {});
    const all = adapter.getAllAgents();
    expect(all).toHaveLength(2);
    expect(all.map(a => a.id).sort()).toEqual(['a1', 'a2']);
  });

  // ── getOnlineAgents / stale exclusion ──────────────────────────────────────

  test('getOnlineAgents() excludes stale agents (heartbeat > 60s)', () => {
    const now = Date.now();
    adapter.registry.set('fresh-agent', {
      id: 'fresh-agent', status: 'online', lastSeen: now - 10_000, capabilities: []
    });
    adapter.registry.set('stale-agent', {
      id: 'stale-agent', status: 'online', lastSeen: now - 90_000, capabilities: []
    });

    const online = adapter.getOnlineAgents();
    expect(online.map(a => a.id)).toContain('fresh-agent');
    expect(online.map(a => a.id)).not.toContain('stale-agent');
  });

  test('getOnlineAgents() returns only agents seen within 60s', () => {
    const now = Date.now();
    adapter.registry.set('agent-recent', {
      id: 'agent-recent', status: 'online', lastSeen: now - 30_000, capabilities: []
    });
    adapter.registry.set('agent-expired', {
      id: 'agent-expired', status: 'online', lastSeen: now - 61_000, capabilities: []
    });

    const online = adapter.getOnlineAgents();
    expect(online).toHaveLength(1);
    expect(online[0].id).toBe('agent-recent');
  });

  // ── sendTo ─────────────────────────────────────────────────────────────────

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

  test('sendTo() returns a message id', async () => {
    const id = await adapter.sendTo('worker-1', 'task', {});
    expect(id).toMatch(/^msg:/);
  });

  test('sendTo() includes timestamp in the published message', async () => {
    await adapter.sendTo('worker-1', 'task', {});
    const [pub] = mockPubSub.published;
    expect(pub.data.timestamp).toBeDefined();
    expect(typeof pub.data.timestamp).toBe('number');
  });

  // ── broadcast ──────────────────────────────────────────────────────────────

  test('broadcast() publishes to a2a:agents with to="*"', async () => {
    await adapter.broadcast('task', { msg: 'hello all' });

    expect(mockPubSub.published).toHaveLength(1);
    const [pub] = mockPubSub.published;
    expect(pub.channel).toBe('a2a:agents');
    expect(pub.data.to).toBe('*');
    expect(pub.data.type).toBe('task');
  });

  // ── handoffTo ──────────────────────────────────────────────────────────────

  test('handoffTo() sends a handoff message with task, context, and handedOffBy', async () => {
    await adapter.handoffTo('worker-1', 'implement auth', { priority: 5 });

    const [pub] = mockPubSub.published;
    expect(pub.channel).toBe('a2a:inbox:worker-1');
    expect(pub.data.type).toBe('handoff');
    expect(pub.data.payload.task).toBe('implement auth');
    expect(pub.data.payload.priority).toBe(5);
    expect(pub.data.payload.handedOffBy).toBe('hub-test');
  });

  // ── coordinate ─────────────────────────────────────────────────────────────

  test('coordinate() publishes to a2a:coordination channel with type negotiate', async () => {
    await adapter.coordinate('resource-lock', { resource: 'db' });

    const [pub] = mockPubSub.published;
    expect(pub.channel).toBe('a2a:coordination');
    expect(pub.data.type).toBe('negotiate');
    expect(pub.data.payload.coordinationType).toBe('resource-lock');
    expect(pub.data.payload.resource).toBe('db');
  });

  // ── heartbeat ─────────────────────────────────────────────────────────────

  test('handleHeartbeat() updates lastSeen timestamp', () => {
    adapter.registerAgent('worker-1', { status: 'online', lastSeen: Date.now() - 100_000 });
    adapter.handleHeartbeat('worker-1', { status: 'online' });

    const agent = adapter.getAgent('worker-1');
    expect(agent.lastSeen).toBeGreaterThan(Date.now() - 1000);
  });

  test('handleHeartbeat() on unknown agent is silently ignored (no throw)', () => {
    expect(() => adapter.handleHeartbeat('unknown-agent', { status: 'online' })).not.toThrow();
  });

  // ── getStatus ──────────────────────────────────────────────────────────────

  test('getStatus() returns correct structure', () => {
    adapter.registerAgent('online-agent', { status: 'online', lastSeen: Date.now(), capabilities: [] });
    adapter.registerAgent('stale-agent', { status: 'online', lastSeen: Date.now() - 90_000, capabilities: [] });

    const status = adapter.getStatus();
    expect(status.agentId).toBe('hub-test');
    expect(status.inbox).toBe('a2a:inbox:hub-test');
    expect(status.onlineAgents).toBe(2); // getOnlineAgents filters
    expect(status.registeredAgents).toBe(2);
  });

  // ── Message type guard ─────────────────────────────────────────────────────

  test('handleMessage() silently ignores unknown message types', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Should not throw
    adapter.handleMessage({ type: 'unknown-type', from: 'x', to: 'y', payload: {} });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown message type'));
    consoleSpy.mockRestore();
  });
});
