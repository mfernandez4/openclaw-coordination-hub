/**
 * Health Server
 * Minimal HTTP server exposing /health for Docker Compose healthchecks
 * and external monitoring.
 */

const http = require('http');
const { logger } = require('./logger');

const DEFAULT_PORT = 3001;
const PORT = parseInt(process.env.HEALTH_PORT) || DEFAULT_PORT;

class HealthServer {
  constructor(components = {}) {
    this.server = null;
    this.port = PORT;
    this.components = components; // { redis, dispatcher, taskQueue, ... }
  }

  /**
   * Get current health status
   */
  getStatus() {
    const redis = this.components.redis;
    const redisConnected = redis && redis.status === 'ready';

    return {
      status: redisConnected ? 'ok' : 'degraded',
      redis: redisConnected ? 'connected' : 'disconnected',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Handle incoming HTTP requests
   */
  handleRequest(req, res) {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    const status = this.getStatus();
    const httpStatus = status.status === 'ok' ? 200 : 503;

    res.writeHead(httpStatus, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    });
    res.end(JSON.stringify(status));
  }

  /**
   * Start the HTTP server
   */
  start() {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    this.server.listen(this.port, () => {
      logger.info('health-server', `Listening on port ${this.port}`, { port: this.port });
    });

    this.server.on('error', (err) => {
      logger.error('health-server', `Error: ${err.message}`, { error: err.message });
    });
  }

  /**
   * Stop the server
   */
  stop() {
    if (this.server) {
      this.server.close();
      logger.info('health-server', 'Stopped');
    }
  }
}

module.exports = { HealthServer };
