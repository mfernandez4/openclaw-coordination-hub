/**
 * Redis Pub/Sub client for real-time agent messaging
 * 
 * Includes error event handlers for disconnect detection.
 * On disconnect: logs structured error, updates status, exits after
 * max reconnect attempts so Docker can restart the container.
 */
const Redis = require('ioredis');

const MAX_RECONNECT_FAILURES = 5;

class RedisPubSub {
  constructor(options = {}) {
    this.host = options.host || process.env.REDIS_HOST || 'redis';
    this.port = options.port || process.env.REDIS_PORT || 6379;
    this.client = null;
    this.subscriber = null;
    this.handlers = new Map();
    this.status = 'disconnected';
    this.reconnectFailures = 0;
    this.shuttingDown = false;
  }

  async connect() {
    this.shuttingDown = false;
    await Promise.all([
      this._setupClient('pub', (client) => {
        this.client = client;
      }),
      this._setupClient('sub', (client) => {
        this.subscriber = client;
        this.subscriber.on('message', (channel, message) => {
          const handler = this.handlers.get(channel);
          if (handler) {
            try {
              handler(JSON.parse(message));
            } catch (e) {
              console.error(`[redis-pubsub] Message handler error on ${channel}:`, e.message);
            }
          }
        });
      })
    ]);

    return this;
  }

  _setupClient(role, onReady) {
    return new Promise((resolve) => {
      const redis = new Redis({ host: this.host, port: this.port });

    redis.on('connect', () => {
      console.log(`[redis-pubsub:${role}] Connected to ${this.host}:${this.port}`);
      this.reconnectFailures = 0;
      this.status = 'connected';
    });

    redis.on('ready', () => {
      this.status = 'connected';
      onReady(redis);
      resolve(redis);
    });

    redis.on('error', (err) => {
      console.error(`[redis-pubsub:${role}] Error: ${err.message}`);
      this.status = 'error';
    });

    redis.on('close', () => {
      if (!this.shuttingDown) {
        console.error(`[redis-pubsub:${role}] Connection closed`);
      }
      this.status = 'disconnected';
    });

    redis.on('reconnecting', () => {
      if (!this.shuttingDown) {
        console.log(`[redis-pubsub:${role}] Reconnecting... (attempt ${this.reconnectFailures + 1})`);
      }
    });

    redis.on('end', () => {
      if (this.shuttingDown) return;

      this.reconnectFailures++;
      console.error(`[redis-pubsub:${role}] Reconnect failed (${this.reconnectFailures}/${MAX_RECONNECT_FAILURES})`);
      if (this.reconnectFailures >= MAX_RECONNECT_FAILURES) {
        console.error(`[redis-pubsub:${role}] Max reconnect failures reached. Exiting.`);
        process.exit(1);
      }
    });

      // Store reference for cleanup
      if (role === 'pub') {
        this._pubClient = redis;
      } else {
        this._subClient = redis;
      }
    });
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
    this.shuttingDown = true;

    if (this._pubClient) {
      try {
        await this._pubClient.quit();
      } catch {
        this._pubClient.disconnect();
      }
    }

    if (this._subClient) {
      try {
        await this._subClient.quit();
      } catch {
        this._subClient.disconnect();
      }
    }

    this.status = 'disconnected';
  }

  getStatus() {
    return this.status;
  }
}

module.exports = { RedisPubSub };
