/**
 * Priority task queue using Redis lists
 *
 * Tasks are routed to one of three priority queues:
 *   coordination:tasks:high   — drained first
 *   coordination:tasks:normal — drained second
 *   coordination:tasks:low    — drained last
 *
 * Enqueue with { priority: 'high' | 'normal' | 'low' }.
 * Unknown or missing priority defaults to 'normal'.
 */
const Redis = require('ioredis');

const VALID_PRIORITIES = ['high', 'normal', 'low'];

class TaskQueue {
  constructor(options = {}) {
    this.host = options.host || process.env.REDIS_HOST || 'redis';
    this.port = options.port || process.env.REDIS_PORT || 6379;
    this.client = null;
    this.baseQueue = options.baseQueue || options.queueName || 'coordination:tasks';
  }

  // Backward-compat alias
  get queueName() {
    return this.baseQueue;
  }

  async connect() {
    this.client = new Redis({ host: this.host, port: this.port });
    return this;
  }

  async enqueue(task) {
    if (!this.client) throw new Error('Not connected');
    const id = `task:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    const priority = VALID_PRIORITIES.includes(task.priority) ? task.priority : 'normal';
    const queueKey = `${this.baseQueue}:${priority}`;
    await this.client.lpush(queueKey, JSON.stringify({ id, ...task, priority }));
    return id;
  }

  async dequeue(timeout = 0) {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.brpop(
      `${this.baseQueue}:high`,
      `${this.baseQueue}:normal`,
      `${this.baseQueue}:low`,
      timeout
    );
    if (!result) return null;
    return JSON.parse(result[1]);
  }

  async disconnect() {
    if (this.client) await this.client.quit();
  }
}

module.exports = { TaskQueue };
