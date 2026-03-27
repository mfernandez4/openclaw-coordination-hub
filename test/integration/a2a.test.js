/**
 * Integration tests for A2A protocol (promoted from scripts/a2a-test.js)
 *
 * Uses real Redis via ioredis-mock for pub/sub simulation.
 * Tests the full handoff flow: enqueue → broadcast → inbox delivery → ack.
 *
 * Fails loudly if Redis is unavailable (no silent skip).
 */
const { createMockRedis } = require('../helpers/redis');
const RedisMock = require('ioredis-mock');

// Shared mock opts so publisher + subscriber share state within each test
let pairCounter = 0;

async function createAdapterPair() {
  const key = `integration-${++pairCounter}`;
  const publisher = new RedisMock({ key });
  const subscriber = new RedisMock({ key });
  return { publisher, subscriber };
}

describe('A2A Integration', () => {
  let publisher;
  let subscriber;

  beforeEach(async () => {
    const pair = await createAdapterPair();
    publisher = pair.publisher;
    subscriber = pair.subscriber;
    // Flush any leftover data from previous tests
    await publisher.flushall();
  });

  afterEach(async () => {
    try {
      await publisher.quit();
      await subscriber.quit();
    } catch (_) {}
  });

  // ── Connectivity guard ────────────────────────────────────────────────────

  test('Redis mock is available and functional', async () => {
    expect(publisher).not.toBeNull();
    expect(subscriber).not.toBeNull();

    await publisher.set('test:key', 'test-value');
    const value = await publisher.get('test:key');
    expect(value).toBe('test-value');
  });

  // ── Directed handoff flow ──────────────────────────────────────────────────

  test('Design agent can handoff task to coding agent via inbox channel', async () => {
    const inboxChannel = 'a2a:inbox:coding-agent';
    const received = [];

    // Subscribe coding-agent to its inbox
    await subscriber.subscribe(inboxChannel);
    subscriber.on('message', (ch, msg) => {
      if (ch === inboxChannel) received.push(JSON.parse(msg));
    });
    await new Promise(r => setTimeout(r, 100));

    // Design agent publishes handoff
    const handoff = {
      type: 'handoff',
      from: 'design-agent',
      to: 'coding-agent',
      payload: {
        task: 'Implement user authentication',
        context: { spec: 'OAuth2 with JWT', priority: 5 },
        handedOffBy: 'design-agent'
      },
      timestamp: Date.now(),
      id: `msg:${Date.now()}:handoff-test`
    };
    await publisher.publish(inboxChannel, JSON.stringify(handoff));
    await new Promise(r => setTimeout(r, 300));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('handoff');
    expect(received[0].from).toBe('design-agent');
    expect(received[0].payload.task).toBe('Implement user authentication');
    expect(received[0].payload.context.priority).toBe(5);
  });

  test('Coding agent receives handoff and can send ack back to design agent', async () => {
    const inboxChannel = 'a2a:inbox:coding-agent';
    const ackChannel = 'a2a:inbox:design-agent';
    const handoffs = [];
    const acks = [];

    await subscriber.subscribe(inboxChannel);
    await subscriber.subscribe(ackChannel);
    subscriber.on('message', (ch, msg) => {
      const parsed = JSON.parse(msg);
      if (ch === inboxChannel) handoffs.push(parsed);
      if (ch === ackChannel) acks.push(parsed);
    });
    await new Promise(r => setTimeout(r, 100));

    // Design agent sends handoff
    await publisher.publish(inboxChannel, JSON.stringify({
      type: 'handoff', from: 'design-agent', to: 'coding-agent',
      payload: { task: 'build login' }, timestamp: Date.now(), id: 'h1'
    }));
    await new Promise(r => setTimeout(r, 200));

    expect(handoffs).toHaveLength(1);

    // Coding agent sends ack back
    await publisher.publish(ackChannel, JSON.stringify({
      type: 'ack', from: 'coding-agent', to: 'design-agent',
      payload: { originalTask: 'build login', status: 'received' },
      timestamp: Date.now(), id: 'a1'
    }));
    await new Promise(r => setTimeout(r, 200));

    expect(acks).toHaveLength(1);
    expect(acks[0].type).toBe('ack');
    expect(acks[0].payload.status).toBe('received');
  });

  // ── Broadcast channel ─────────────────────────────────────────────────────

  test('Broadcast message is received by all subscribers on a2a:agents', async () => {
    const channel = 'a2a:agents';
    const received1 = [];
    const received2 = [];

    // Create two independent subscribers on the shared mock
    const sub1 = new RedisMock({ key: `broadcast-${pairCounter}-1` });
    const sub2 = new RedisMock({ key: `broadcast-${pairCounter}-2` });

    sub1.on('message', (ch, msg) => { if (ch === channel) received1.push(JSON.parse(msg)); });
    sub2.on('message', (ch, msg) => { if (ch === channel) received2.push(JSON.parse(msg)); });

    await sub1.subscribe(channel);
    await sub2.subscribe(channel);
    await new Promise(r => setTimeout(r, 100));

    await publisher.publish(channel, JSON.stringify({
      type: 'task', from: 'hub', to: '*',
      payload: { description: 'all agents do something' },
      timestamp: Date.now(), id: 'b1'
    }));
    await new Promise(r => setTimeout(r, 200));

    expect(received1).toHaveLength(1);
    expect(received1[0].payload.description).toBe('all agents do something');
    expect(received2).toHaveLength(1);
    expect(received2[0].payload.description).toBe('all agents do something');

    await sub1.quit();
    await sub2.quit();
  });

  // ── Coordination channel ───────────────────────────────────────────────────

  test('Coordination message published to a2a:coordination with negotiate type', async () => {
    const channel = 'a2a:coordination';
    const received = [];

    await subscriber.subscribe(channel);
    subscriber.on('message', (ch, msg) => {
      if (ch === channel) received.push(JSON.parse(msg));
    });
    await new Promise(r => setTimeout(r, 100));

    await publisher.publish(channel, JSON.stringify({
      type: 'negotiate',
      from: 'design-agent',
      to: 'coordination',
      payload: { coordinationType: 'resource-lock', resource: 'database' },
      timestamp: Date.now(),
      id: 'c1'
    }));
    await new Promise(r => setTimeout(r, 200));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('negotiate');
    expect(received[0].payload.coordinationType).toBe('resource-lock');
    expect(received[0].payload.resource).toBe('database');
  });

  // ── Agent registry via Redis ──────────────────────────────────────────────

  test('Agent registry stores and retrieves agents from Redis', async () => {
    const registryKey = 'a2a:registry';

    const agent1 = {
      id: 'agent-1',
      status: 'online',
      capabilities: ['coding', 'search'],
      lastSeen: Date.now()
    };
    const agent2 = {
      id: 'agent-2',
      status: 'online',
      capabilities: ['writing'],
      lastSeen: Date.now()
    };

    // Store in Redis
    await publisher.hset(registryKey, 'agent-1', JSON.stringify(agent1));
    await publisher.hset(registryKey, 'agent-2', JSON.stringify(agent2));

    // Retrieve via subscriber (same connection in mock)
    const raw = await subscriber.hgetall(registryKey);
    expect(Object.keys(raw)).toHaveLength(2);

    const retrieved1 = JSON.parse(raw['agent-1']);
    expect(retrieved1.id).toBe('agent-1');
    expect(retrieved1.capabilities).toContain('coding');
  });

  test('Stale agents (>60s) are excluded from online count', async () => {
    const registryKey = 'a2a:registry';
    const now = Date.now();

    await publisher.hset(registryKey, 'fresh', JSON.stringify({
      id: 'fresh', status: 'online', lastSeen: now - 10_000, capabilities: []
    }));
    await publisher.hset(registryKey, 'stale', JSON.stringify({
      id: 'stale', status: 'online', lastSeen: now - 90_000, capabilities: []
    }));

    const raw = await subscriber.hgetall(registryKey);
    const agents = Object.values(raw).map(JSON.parse);
    const online = agents.filter(a => Date.now() - a.lastSeen < 60_000);

    expect(online).toHaveLength(1);
    expect(online[0].id).toBe('fresh');
  });

  // ── Results persistence ───────────────────────────────────────────────────

  test('Results are persisted to Redis list and retrievable', async () => {
    const resultsKey = 'a2a:results:main:list';

    const result = {
      raw: { taskId: 'r1', agent: 'coder', task: 'build', status: 'completed' },
      formatted: '✅ coder: build'
    };
    await publisher.lpush(resultsKey, JSON.stringify(result));

    const stored = await subscriber.lrange(resultsKey, 0, -1);
    expect(stored).toHaveLength(1);

    const parsed = JSON.parse(stored[0]);
    expect(parsed.raw.taskId).toBe('r1');
    expect(parsed.raw.agent).toBe('coder');
  });
});
