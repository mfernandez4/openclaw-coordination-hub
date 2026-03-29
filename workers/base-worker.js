/**
 * Base Worker Framework
 * Reusable worker logic for all specialist agents
 */

const EventEmitter = require('events');
const { ArtifactStore } = require('../src/artifact-store');
const { logger } = require('../src/logger');

class BaseWorker extends EventEmitter {
  constructor(agentId, options = {}) {
    super();
    this.agentId = agentId;
    this.inboxKey = `a2a:inbox:${agentId}`;
    this.coordinationChannel = 'a2a:coordination';
    this.heartbeatChannel = 'a2a:heartbeats';
    this.registryKey = 'a2a:registry';

    this.redis = options.redis || null;
    this.pollTimeout = options.pollTimeout || 5; // seconds
    this.heartbeatInterval = options.heartbeatInterval || 30000; // ms
    this.running = false;
    this.currentTask = null;
    this.startTime = null;

    this.artifacts = options.artifactStore || new ArtifactStore();
  }

  /**
   * Connect to Redis
   */
  async connect() {
    const Redis = require('ioredis');
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'redis',
      port: process.env.REDIS_PORT || 6379
    });
    logger.info(this.agentId, 'Connecting to Redis');
  }

  /**
   * Register as online in registry
   * Sets TTL = 3× heartbeat interval so stale agents auto-evict.
   */
  async register() {
    const ttl = Math.floor((this.heartbeatInterval * 3) / 1000); // seconds
    const entry = JSON.stringify({
      status: 'online',
      startedAt: new Date().toISOString(),
      capabilities: this.getCapabilities()
    });
    await this.redis.hset(this.registryKey, this.agentId, entry);
    await this.redis.expire(this.registryKey, ttl); // expire key if all agents vanish
    // Also set TTL on the specific field via a separate TTL key
    await this.redis.set(`${this.registryKey}:${this.agentId}:ttl`, '1', 'EX', ttl);
    logger.info(this.agentId, `Registered as online (TTL: ${ttl}s)`, { ttl });
  }

  /**
   * Deregister from registry
   */
  async deregister() {
    await this.redis.hdel(this.registryKey, this.agentId);
    await this.redis.del(`${this.registryKey}:${this.agentId}:ttl`);
    logger.info(this.agentId, 'Deregistered');
  }

  /**
   * Get worker capabilities (override in subclass)
   */
  getCapabilities() {
    return [];
  }

  /**
   * Process a task (override in subclass)
   */
  async processTask(taskPayload) {
    throw new Error('processTask() must be implemented by subclass');
  }

  /**
   * Format result for output.
   *
   * @param {object} taskPayload
   * @param {*} result
   * @param {string} status
   * @param {string|null} error
   * @param {string[]} artifacts - Optional artifact IDs produced by this task
   */
  formatResult(taskPayload, result, status = 'completed', error = null, artifacts = []) {
    return {
      type: 'result',
      taskId: taskPayload.taskId || `task:${Date.now()}`,
      agent: this.agentId,
      task: taskPayload.task,
      status,
      output: result,
      artifacts,
      error,
      durationMs: this.startTime ? Date.now() - this.startTime : 0,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Write a file to the shared artifact store.
   * Returns the artifactId for inclusion in task results.
   *
   * @param {string} filename
   * @param {string|Buffer} content
   * @param {object} metadata
   * @returns {string} artifactId
   */
  writeArtifact(filename, content, metadata = {}) {
    return this.artifacts.writeArtifact(this.agentId, filename, content, metadata);
  }

  /**
   * Read an artifact written by any worker.
   *
   * @param {string} artifactId
   * @returns {{ content: Buffer, manifest: object, filePath: string }}
   */
  readArtifact(artifactId) {
    return this.artifacts.readArtifact(artifactId);
  }

  /**
   * Publish result to coordination channel
   */
  async publishResult(result) {
    await this.redis.publish(this.coordinationChannel, JSON.stringify(result));
    logger.info(this.agentId, `Result published: ${result.status}`, { status: result.status });
  }

  /**
   * Send heartbeat
   */
  async sendHeartbeat() {
    const heartbeat = {
      type: 'heartbeat',
      agent: this.agentId,
      status: this.running ? 'running' : 'idle',
      currentTask: this.currentTask,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
    await this.redis.publish(this.heartbeatChannel, JSON.stringify(heartbeat));

    // Refresh registry entry and TTL sentinel so stale agents auto-evict.
    // Without this, lastSeen is frozen at register() time and the TTL sentinel
    // expires 3×heartbeatInterval after first register, not after last heartbeat.
    const ttl = Math.floor((this.heartbeatInterval * 3) / 1000);
    const entry = JSON.stringify({
      status: heartbeat.status,
      capabilities: this.getCapabilities(),
      lastSeen: Date.now()
    });
    await this.redis.hset(this.registryKey, this.agentId, entry);
    await this.redis.set(`${this.registryKey}:${this.agentId}:ttl`, '1', 'EX', ttl);
  }

  /**
   * Poll for tasks (blocking pop)
   */
  async pollTask() {
    try {
      // BLPOP returns [key, message] or null
      const result = await this.redis.blpop(this.inboxKey, this.pollTimeout);

      if (!result) {
        return null; // No task, timeout
      }

      const [key, message] = result;
      return JSON.parse(message);
    } catch (error) {
      logger.error(this.agentId, 'Poll error', { error: error.message });
      return null;
    }
  }

  /**
   * Run the worker loop
   */
  async start() {
    if (this.running) {
      logger.warn(this.agentId, 'Already running');
      return;
    }

    await this.connect();
    await this.register();

    this.running = true;
    logger.info(this.agentId, `Worker started, polling ${this.inboxKey}`, { inbox: this.inboxKey });

    // Start heartbeat interval
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatInterval);

    // Main loop
    while (this.running) {
      const taskPayload = await this.pollTask();

      if (!taskPayload) {
        continue; // Timeout, keep polling
      }

      logger.info(this.agentId, `Received task: ${taskPayload.task}`, { task: taskPayload.task });

      this.startTime = Date.now();
      this.currentTask = taskPayload.task;

      try {
        const result = await this.processTask(taskPayload);
        const formattedResult = this.formatResult(taskPayload, result, 'completed');
        await this.publishResult(formattedResult);
      } catch (error) {
        logger.error(this.agentId, 'Task error', { error: error.message, task: taskPayload.task });
        const errorResult = this.formatResult(taskPayload, null, 'failed', error.message);
        await this.publishResult(errorResult);
      }

      this.currentTask = null;
      this.startTime = null;
    }
  }

  /**
   * Stop the worker gracefully
   */
  async stop() {
    logger.info(this.agentId, 'Stopping...');
    this.running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // Wait for current task to finish (max 30s)
    let waited = 0;
    while (this.currentTask && waited < 30000) {
      await new Promise(r => setTimeout(r, 100));
      waited += 100;
    }

    await this.deregister();

    if (this.redis) {
      await this.redis.quit();
    }

    logger.info(this.agentId, 'Stopped');
  }
}

module.exports = BaseWorker;
