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

class CoordinationHub {
  constructor(options = {}) {
    this.pubsub = null;
    this.taskQueue = null;
    this.a2aAdapter = null;
    this.memoryBridge = null;
    this.mem0Adapter = null;
    this.running = false;
  }

  async start() {
    console.log('[Hub] Starting OpenClaw Coordination Hub...');

    // Initialize Redis Pub/Sub
    this.pubsub = new RedisPubSub();
    await this.pubsub.connect();
    console.log('[Hub] Redis Pub/Sub connected');

    // Initialize Task Queue
    this.taskQueue = new TaskQueue();
    await this.taskQueue.connect();
    console.log('[Hub] Task Queue connected');

    // Initialize Memory Bridge (always-on)
    this.memoryBridge = new MemoryBridge();
    console.log('[Hub] Memory Bridge initialized');

    // Initialize Mem0 (opt-in, disabled by default)
    this.mem0Adapter = new Mem0Adapter();
    await this.mem0Adapter.initialize();
    if (this.mem0Adapter.isEnabled()) {
      console.log('[Hub] Mem0 integration ACTIVE');
    } else {
      console.log('[Hub] Mem0 disabled (opt-in mode)');
    }

    // Initialize A2A Adapter
    this.a2aAdapter = new A2AAdapter({ agentId: 'hub' });
    await this.a2aAdapter.initialize(this.pubsub);
    console.log('[Hub] A2A Adapter initialized');

    this.running = true;
    console.log('[Hub] Coordination Hub ready');
  }

  async stop() {
    this.running = false;
    if (this.pubsub) await this.pubsub.disconnect();
    if (this.taskQueue) await this.taskQueue.disconnect();
    console.log('[Hub] Stopped');
  }

  getStatus() {
    return {
      running: this.running,
      redis: this.pubsub ? 'connected' : 'disconnected',
      taskQueue: this.taskQueue ? 'connected' : 'disconnected',
      mem0: this.mem0Adapter?.isEnabled() || false,
      a2a: this.a2aAdapter ? 'ready' : 'not_ready'
    };
  }
}

// Start if run directly
if (require.main === module) {
  const hub = new CoordinationHub();
  hub.start().catch(err => {
    console.error('[Hub] Failed to start:', err);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    await hub.stop();
    process.exit(0);
  });
}

module.exports = { CoordinationHub };
