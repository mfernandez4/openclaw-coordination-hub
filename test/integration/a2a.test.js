/**
 * Live Redis integration tests for A2A protocol.
 *
 * These tests intentionally exercise real Redis connections and the production
 * adapters (A2AAdapter + RedisPubSub) end-to-end.
 */
const Redis = require('ioredis');
const { A2AAdapter } = require('../../src/a2a-adapter');
const { RedisPubSub } = require('../../src/redis-pubsub');

const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);

async function assertRedisReachable() {
  const client = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true
  });

  // Prevent noisy unhandled error logs during connectivity probes.
  client.on('error', () => {});

  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    throw new Error(
      `Live integration tests require Redis at ${REDIS_HOST}:${REDIS_PORT}. ` +
      `Start Redis and rerun \`npm run test:integration\`. Root cause: ${error.message}`
    );
  } finally {
    try {
      await client.quit();
    } catch (_) {
      client.disconnect();
    }
  }
}

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('A2A integration (live Redis)', () => {
  let pubsubA;
  let pubsubB;
  let agentA;
  let agentB;

  beforeAll(async () => {
    await assertRedisReachable();
  });

  beforeEach(async () => {
    pubsubA = new RedisPubSub({ host: REDIS_HOST, port: REDIS_PORT });
    pubsubB = new RedisPubSub({ host: REDIS_HOST, port: REDIS_PORT });

    await pubsubA.connect();
    await pubsubB.connect();

    agentA = new A2AAdapter({ agentId: 'design-agent' });
    agentB = new A2AAdapter({ agentId: 'coding-agent' });

    await agentA.initialize(pubsubA);
    await agentB.initialize(pubsubB);
  });

  afterEach(async () => {
    if (pubsubA) await pubsubA.disconnect();
    if (pubsubB) await pubsubB.disconnect();
  });

  test('directed handoff: design-agent -> coding-agent with ack back', async () => {
    const observed = {
      handoffTask: null,
      ackStatus: null
    };

    agentB.handleTask = async (from, _to, payload) => {
      observed.handoffTask = payload.task;
      await agentB.sendTo(from, 'ack', {
        originalTask: payload.task,
        status: 'received'
      });
    };

    agentA.handleAck = (_from, _to, payload) => {
      observed.ackStatus = payload.status;
    };

    await agentA.handoffTo('coding-agent', 'Implement user authentication', {
      priority: 5,
      spec: 'OAuth2 with JWT'
    });

    await waitFor(() => observed.handoffTask !== null && observed.ackStatus !== null);

    expect(observed.handoffTask).toBe('Implement user authentication');
    expect(observed.ackStatus).toBe('received');
  });

  test('broadcast task reaches all subscribed agents', async () => {
    const receivedBy = [];

    agentA.handleTask = () => {
      receivedBy.push('design-agent');
    };

    agentB.handleTask = () => {
      receivedBy.push('coding-agent');
    };

    await agentA.broadcast('task', { description: 'all agents do something' });

    await waitFor(() => receivedBy.includes('design-agent') && receivedBy.includes('coding-agent'));

    expect(receivedBy).toContain('design-agent');
    expect(receivedBy).toContain('coding-agent');
  });

  test('coordination message is routed to negotiation handler', async () => {
    let coordinationPayload = null;

    agentB.handleNegotiation = (message) => {
      coordinationPayload = message.payload;
    };

    await agentA.coordinate('resource-lock', {
      resource: 'database',
      requestedBy: 'design-agent'
    });

    await waitFor(() => coordinationPayload !== null);

    expect(coordinationPayload.coordinationType).toBe('resource-lock');
    expect(coordinationPayload.resource).toBe('database');
    expect(coordinationPayload.requestedBy).toBe('design-agent');
  });
});
