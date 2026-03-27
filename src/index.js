/**
 * OpenClaw Coordination Hub - Main Entry Point
 * 
 * Real-time coordination layer for sub-agent orchestration.
 * 
 * Environment:
 *   REDIS_HOST - Redis host (default: redis)
 *   REDIS_PORT - Redis port (default: 6379)
 *   MEM0_ENABLED - Enable Mem0 (default: false)
 *   MEM0_API_KEY - Mem0 API key (optional)
 */
const { RedisPubSub } = require('./redis-pubsub');
const { TaskQueue } = require('./task-queue');
const { A2AAdapter } = require('./a2a-adapter');
const { MemoryBridge } = require('./memory-bridge');
const { Mem0Adapter } = require('./mem0-adapter');
const { TaskDispatcher } = require('./dispatcher');
const { ResultProcessor } = require('./result-processor');
const { logger } = require('./logger');

class CoordinationHub {
  constructor(options = {}) {
    this.pubsub = null;
    this.taskQueue = null;
    this.a2aAdapter = null;
    this.memoryBridge = null;
    this.mem0Adapter = null;
    this.dispatcher = null;
    this.resultProcessor = null;
    this.running = false;
  }

  async start() {
    logger.info('hub', 'Starting OpenClaw Coordination Hub');

    // Initialize Redis Pub/Sub
    this.pubsub = new RedisPubSub();
    await this.pubsub.connect();
    logger.info('hub', 'Redis Pub/Sub connected');

    // Initialize Task Queue
    this.taskQueue = new TaskQueue();
    await this.taskQueue.connect();
    logger.info('hub', 'Task Queue connected');

    // Initialize and start Task Dispatcher (routes tasks from coordination:tasks to typed queues)
    this.dispatcher = new TaskDispatcher();
    await this.dispatcher.start();
    logger.info('hub', 'Task Dispatcher started');

    // Initialize and start ResultProcessor (processes and formats worker results)
    this.resultProcessor = new ResultProcessor();
    await this.resultProcessor.start();
    logger.info('hub', 'Result Processor started');

    // Initialize Memory Bridge (always-on)
    this.memoryBridge = new MemoryBridge();
    logger.info('hub', 'Memory Bridge initialized');

    // Initialize Mem0 (opt-in, disabled by default)
    this.mem0Adapter = new Mem0Adapter();
    await this.mem0Adapter.initialize();
    if (this.mem0Adapter.isEnabled()) {
      logger.info('hub', 'Mem0 integration ACTIVE');
    } else {
      logger.info('hub', 'Mem0 disabled (opt-in mode)');
    }

    // Initialize A2A Adapter
    this.a2aAdapter = new A2AAdapter({ agentId: 'hub' });
    await this.a2aAdapter.initialize(this.pubsub);
    logger.info('hub', 'A2A Adapter initialized');

    this.running = true;
    logger.info('hub', 'Coordination Hub ready');
  }

  async stop() {
    this.running = false;
    if (this.dispatcher) await this.dispatcher.stop();
    if (this.resultProcessor) await this.resultProcessor.stop();
    if (this.pubsub) await this.pubsub.disconnect();
    if (this.taskQueue) await this.taskQueue.disconnect();
    logger.info('hub', 'Stopped');
  }

  getStatus() {
    return {
      running: this.running,
      redis: this.pubsub ? 'connected' : 'disconnected',
      taskQueue: this.taskQueue ? 'connected' : 'disconnected',
      dispatcher: this.dispatcher ? 'running' : 'stopped',
      resultProcessor: this.resultProcessor ? 'running' : 'stopped',
      mem0: this.mem0Adapter?.isEnabled() || false,
      a2a: this.a2aAdapter ? 'ready' : 'not_ready'
    };
  }
}

// Start if run directly
if (require.main === module) {
  const hub = new CoordinationHub();
  hub.start().catch(err => {
    logger.fatal('hub', 'Failed to start', { error: err.message });
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    await hub.stop();
    process.exit(0);
  });
}

module.exports = { CoordinationHub };
