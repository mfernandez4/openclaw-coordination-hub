/**
 * Redis Pub/Sub client for real-time agent messaging
 *
 * Includes error event handlers for disconnect detection.
 * On disconnect: logs structured error, updates status, exits after
 * max reconnect attempts so Docker can restart the container.
 */
const Redis = require('ioredis');
const { logger } = require('./logger');

const MAX_RECONNECT_FAILURES = 5;

class RedisPubSub {
  constructor(options = {}) {
    this.host = options.host || process.env.REDIS_HOST || 'redis';
    this.port = options.port || process.env.REDIS_PORT || 6379;
    const RedisClientClass = options.redisClientClass || Redis;
    if (typeof RedisClientClass === 'function') {
      this.RedisClient = RedisClientClass;
    } else {
      throw new Error('options.redisClientClass must be a constructor function');
    }
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
              logger.error('redis-pubsub', `Message handler error on ${channel}`, { error: e.message });
            }
          }
        });
      })
    ]);

    return this;
  }

  _setupClient(role, onReady) {
    return new Promise((resolve) => {
      const redis = new this.RedisClient({ host: this.host, port: this.port });

      redis.on('connect', () => {
        logger.info('redis-pubsub', `Connected to ${this.host}:${this.port}`, { role });
        this.reconnectFailures = 0;
        this.status = 'connected';
      });

      redis.on('ready', () => {
        this.status = 'connected';
        onReady(redis);
        resolve(redis);
      });

      redis.on('error', (err) => {
        logger.error('redis-pubsub', `Error: ${err.message}`, { role, error: err.message });
        this.status = 'error';
      });

      redis.on('close', () => {
        if (!this.shuttingDown) {
          logger.error('redis-pubsub', 'Connection closed', { role });
        }
        this.status = 'disconnected';
      });

      redis.on('reconnecting', () => {
        if (!this.shuttingDown) {
          logger.info('redis-pubsub', `Reconnecting... (attempt ${this.reconnectFailures + 1})`, { role });
        }
      });

      redis.on('end', () => {
        if (this.shuttingDown) return;

        this.reconnectFailures++;
        logger.error('redis-pubsub', `Reconnect failed (${this.reconnectFailures}/${MAX_RECONNECT_FAILURES})`, { role });
        if (this.reconnectFailures >= MAX_RECONNECT_FAILURES) {
          logger.fatal('redis-pubsub', 'Max reconnect failures reached. Exiting.', { role, reconnectFailures: this.reconnectFailures, host: this.host, port: this.port });
          process.exitCode = 1;
          setTimeout(() => process.exit(1), 100);
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
