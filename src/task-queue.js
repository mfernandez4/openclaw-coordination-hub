/**
 * Simple task queue using Redis lists
 */
const Redis = require('ioredis');

class TaskQueue {
  constructor(options = {}) {
    this.host = options.host || process.env.REDIS_HOST || 'redis';
    this.port = options.port || process.env.REDIS_PORT || 6379;
    this.client = null;
    this.queueName = options.queueName || 'coordination:tasks';
  }

  async connect() {
    this.client = new Redis({ host: this.host, port: this.port });
    return this;
  }

  async enqueue(task) {
    if (!this.client) throw new Error('Not connected');
    const id = `task:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    await this.client.lpush(this.queueName, JSON.stringify({ id, ...task }));
    return id;
  }

  async dequeue(timeout = 0) {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.brpop(this.queueName, timeout);
    if (!result) return null;
    return JSON.parse(result[1]);
  }

  async disconnect() {
    if (this.client) await this.client.quit();
  }
}

module.exports = { TaskQueue };
