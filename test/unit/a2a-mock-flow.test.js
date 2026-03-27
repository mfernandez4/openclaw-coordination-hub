/**
 * Redis-mock flow tests for A2A channels.
 *
 * These are fast queue/pubsub flow checks that run as part of unit tests.
 * Live Redis behavior is covered in test/integration/a2a.test.js.
 */
const RedisMock = require('ioredis-mock');
const { createMockPubSub } = require('../helpers/redis');

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('A2A mock Redis flow', () => {
  let publisher;
  let subscriber;

  beforeEach(async () => {
    const pair = createMockPubSub();
    publisher = pair.publisher;
    subscriber = pair.subscriber;
    await publisher.flushall();
  });

  afterEach(async () => {
    await publisher.quit();
    await subscriber.quit();
  });

  test('directed handoff event reaches coding-agent inbox channel', async () => {
    const inboxChannel = 'a2a:inbox:coding-agent';
    const received = [];

    await subscriber.subscribe(inboxChannel);
    subscriber.on('message', (channel, message) => {
      if (channel === inboxChannel) received.push(JSON.parse(message));
    });

    await publisher.publish(inboxChannel, JSON.stringify({
      type: 'handoff',
      from: 'design-agent',
      to: 'coding-agent',
      payload: { task: 'Implement user authentication' },
      id: 'h1'
    }));

    await waitFor(() => received.length === 1);

    expect(received[0].type).toBe('handoff');
    expect(received[0].payload.task).toBe('Implement user authentication');
  });

  test('ack round-trip across inbox channels works', async () => {
    const codingInbox = 'a2a:inbox:coding-agent';
    const designInbox = 'a2a:inbox:design-agent';
    const handoffs = [];
    const acks = [];

    await subscriber.subscribe(codingInbox);
    await subscriber.subscribe(designInbox);

    subscriber.on('message', (channel, message) => {
      const parsed = JSON.parse(message);
      if (channel === codingInbox) handoffs.push(parsed);
      if (channel === designInbox) acks.push(parsed);
    });

    await publisher.publish(codingInbox, JSON.stringify({
      type: 'handoff', from: 'design-agent', to: 'coding-agent',
      payload: { task: 'build login' }, id: 'h1'
    }));

    await publisher.publish(designInbox, JSON.stringify({
      type: 'ack', from: 'coding-agent', to: 'design-agent',
      payload: { status: 'received' }, id: 'a1'
    }));

    await waitFor(() => handoffs.length === 1 && acks.length === 1);

    expect(handoffs[0].payload.task).toBe('build login');
    expect(acks[0].payload.status).toBe('received');
  });

  test('broadcast on a2a:agents reaches multiple subscribers', async () => {
    const channel = 'a2a:agents';
    const db = 5000 + Math.floor(Math.random() * 1000);
    const sub1 = new RedisMock({ host: '127.0.0.1', port: 6379, db });
    const sub2 = new RedisMock({ host: '127.0.0.1', port: 6379, db });
    const pub = new RedisMock({ host: '127.0.0.1', port: 6379, db });
    const received = { one: 0, two: 0 };

    sub1.on('message', (ch) => { if (ch === channel) received.one += 1; });
    sub2.on('message', (ch) => { if (ch === channel) received.two += 1; });

    await sub1.subscribe(channel);
    await sub2.subscribe(channel);

    await pub.publish(channel, JSON.stringify({ type: 'task', to: '*' }));

    await waitFor(() => received.one === 1 && received.two === 1);

    await sub1.quit();
    await sub2.quit();
    await pub.quit();
  });

  test('coordination channel carries negotiate payload', async () => {
    const channel = 'a2a:coordination';
    const received = [];

    await subscriber.subscribe(channel);
    subscriber.on('message', (ch, msg) => {
      if (ch === channel) received.push(JSON.parse(msg));
    });

    await publisher.publish(channel, JSON.stringify({
      type: 'negotiate',
      payload: { coordinationType: 'resource-lock', resource: 'database' }
    }));

    await waitFor(() => received.length === 1);

    expect(received[0].type).toBe('negotiate');
    expect(received[0].payload.coordinationType).toBe('resource-lock');
  });

  test('results list persistence is retrievable from Redis', async () => {
    const resultsKey = 'a2a:results:main:list';

    await publisher.lpush(resultsKey, JSON.stringify({
      raw: { taskId: 'r1', agent: 'coder', status: 'completed' },
      formatted: '✅ coder: build'
    }));

    const stored = await subscriber.lrange(resultsKey, 0, -1);

    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]).raw.taskId).toBe('r1');
  });
});
