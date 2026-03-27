/**
 * Redis Pub/Sub client for real-time agent messaging
 */
const Redis = require('ioredis');

class RedisPubSub {
  constructor(options = {}) {
    this.host = options.host || process.env.REDIS_HOST || 'redis';
    this.port = options.port || process.env.REDIS_PORT || 6379;
    this.client = null;
    this.subscriber = null;
    this.handlers = new Map();
  }

  async connect() {
    this.client = new Redis({ host: this.host, port: this.port });
    this.subscriber = new Redis({ host: this.host, port: this.port });
    
    this.subscriber.on('message', (channel, message) => {
      const handler = this.handlers.get(channel);
      if (handler) {
        try {
          handler(JSON.parse(message));
        } catch (e) {
          console.error(`Error handling message on ${channel}:`, e);
        }
      }
    });
    
    return this;
  }

  async publish(channel, data) {
    if (!this.client) throw new Error('Not connected');
    return this.client.publish(channel, JSON.stringify(data));
  }

  subscribe(channel, handler) {
    if (!this.subscriber) throw new Error('Not connected');
    this.handlers.set(channel, handler);
    return this.subscriber.subscribe(channel);
  }

  async disconnect() {
    if (this.client) await this.client.quit();
    if (this.subscriber) await this.subscriber.quit();
    this.client = null;
    this.subscriber = null;
  }
}

module.exports = { RedisPubSub };
