/**
 * Task Dispatcher
 * 
 * Polls the coordination:tasks queue and routes tasks to typed queues
 * based on the task's `type` field. Unroutable tasks are dead-lettered.
 * 
 * Routing map: task.type → typed queue name
 * Dead-letter channel: a2a:results:main (with status: 'dead_lettered')
 */

const Redis = require('ioredis');

// Known worker queues by task type
// Workers poll a2a:inbox:{agentId} — so routing must use inbox queues
const TYPE_TO_QUEUE = {
  coding: 'a2a:inbox:coding',
  'github-ops': 'a2a:inbox:github-ops',
  research: 'a2a:inbox:research',
  'dev-ops': 'a2a:inbox:dev-ops'
};

const COORDINATION_QUEUE = 'coordination:tasks';
const RESULTS_CHANNEL = 'a2a:results:main';
const DLQ_SUFFIX = ':dlq';

class TaskDispatcher {
  constructor(options = {}) {
    this.host = options.host || process.env.REDIS_HOST || 'redis';
    this.port = options.port || process.env.REDIS_PORT || 6379;
    this.pollTimeout = options.pollTimeout || 5; // seconds
    this.client = null;
    this.publisher = null;
    this.running = false;
  }

  /**
   * Connect to Redis
   */
  async connect() {
    this.client = new Redis({ host: this.host, port: this.port });
    this.publisher = new Redis({ host: this.host, port: this.port });
    return this;
  }

  /**
   * Get the typed queue name for a given task type
   */
  getTypedQueue(type) {
    if (!type) return null;
    return TYPE_TO_QUEUE[type] || null;
  }

  /**
   * Dead-letter an unroutable task
   */
  async deadLetter(task, reason) {
    const dlqKey = `${COORDINATION_QUEUE}${DLQ_SUFFIX}`;
    const deadLettered = {
      ...task,
      _deadLettered: true,
      _deadLetterReason: reason,
      _deadLetterTimestamp: new Date().toISOString()
    };

    // Store in DLQ list
    await this.client.lpush(dlqKey, JSON.stringify(deadLettered));

    // Also publish to results channel so listeners know
    await this.publisher.publish(RESULTS_CHANNEL, JSON.stringify({
      type: 'result',
      taskId: task.id,
      agent: 'dispatcher',
      task: task.type || 'unknown',
      status: 'dead_lettered',
      output: null,
      error: reason,
      timestamp: new Date().toISOString()
    }));

    console.log(`[dispatcher] Dead-lettered task ${task.id}: ${reason}`);
  }

  /**
   * Route a task to its typed queue
   */
  async routeTask(task) {
    const type = task.type || task.task;
    const typedQueue = this.getTypedQueue(type);

    if (!typedQueue) {
      await this.deadLetter(task, `No routing destination for task type: ${type}`);
      return;
    }

    // Enrich task with routing metadata
    const routed = {
      ...task,
      _routedTo: typedQueue,
      _routeTimestamp: new Date().toISOString()
    };

    await this.client.lpush(typedQueue, JSON.stringify(routed));
    console.log(`[dispatcher] Routed task ${task.id} (${type}) → ${typedQueue}`);
  }

  /**
   * Poll and route loop
   */
  async run() {
    console.log('[dispatcher] Starting poll loop on', COORDINATION_QUEUE);

    while (this.running) {
      try {
        const result = await this.client.brpop(COORDINATION_QUEUE, this.pollTimeout);

        if (!result) {
          continue; // Timeout, keep polling
        }

        const [, raw] = result;
        let task;

        try {
          task = JSON.parse(raw);
        } catch (parseErr) {
          console.error('[dispatcher] Failed to parse task JSON:', parseErr.message);
          continue;
        }

        await this.routeTask(task);
      } catch (err) {
        if (this.running) {
          console.error('[dispatcher] Poll error:', err.message);
          // Brief backoff before retrying
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    console.log('[dispatcher] Poll loop stopped');
  }

  /**
   * Start the dispatcher
   */
  async start() {
    await this.connect();
    this.running = true;
    this.run(); // fire and forget — runs in background
    console.log('[dispatcher] Started');
  }

  /**
   * Stop gracefully
   */
  async stop() {
    this.running = false;
    if (this.client) await this.client.quit();
    if (this.publisher) await this.publisher.quit();
    console.log('[dispatcher] Stopped');
  }
}

module.exports = { TaskDispatcher };
