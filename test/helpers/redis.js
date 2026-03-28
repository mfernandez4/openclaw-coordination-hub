/**
 * Redis test helper — swaps in ioredis-mock for unit tests.
 *
 * Notes:
 * - ioredis-mock shares state between clients when host/port/db are the same.
 * - The custom `{ key }` option is ignored by ioredis-mock.
 * - We isolate tests by assigning a unique DB per helper call.
 */
const RedisMock = require('ioredis-mock');

let _counter = 0;

function nextIsolatedDb() {
  // Keep DB id in a reasonable range (Redis supports 0..15 by default,
  // but ioredis-mock does not enforce that strictly).
  _counter += 1;
  return 1000 + _counter;
}

function createMockRedis() {
  return new RedisMock({
    host: '127.0.0.1',
    port: 6379,
    db: nextIsolatedDb()
  });
}

/**
 * Create two mock Redis instances that share the same in-memory store.
 * Required for pub/sub tests (publisher/subscriber pair).
 */
function createMockPubSub() {
  const sharedDb = nextIsolatedDb();
  const options = {
    host: '127.0.0.1',
    port: 6379,
    db: sharedDb
  };

  return {
    publisher: new RedisMock(options),
    subscriber: new RedisMock(options)
  };
}

module.exports = { createMockRedis, createMockPubSub };
