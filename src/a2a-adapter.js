/**
 * A2A (Agent-to-Agent) Protocol Adapter
 * 
 * Provides modality-agnostic agent communication
 * following the A2A specification patterns.
 */
const { RedisPubSub } = require('./redis-pubsub');

class A2AAdapter {
  constructor(options = {}) {
    this.pubsub = options.pubsub || null;
    this.agentId = options.agentId || 'hub';
    this.messageTypes = ['task', 'result', 'error', 'heartbeat'];
  }

  async initialize(pubsub) {
    this.pubsub = pubsub;
    // Subscribe to agent communication channel
    await this.pubsub.subscribe('a2a:agents', this.handleMessage.bind(this));
  }

  handleMessage(message) {
    const { type, from, to, payload } = message;
    
    if (!this.messageTypes.includes(type)) {
      console.warn(`Unknown message type: ${type}`);
      return;
    }

    // Route message based on type
    switch (type) {
      case 'task':
        this.handleTask(from, to, payload);
        break;
      case 'result':
        this.handleResult(from, to, payload);
        break;
      case 'error':
        this.handleError(from, to, payload);
        break;
      case 'heartbeat':
        this.handleHeartbeat(from, payload);
        break;
    }
  }

  async send(to, type, payload) {
    const message = {
      type,
      from: this.agentId,
      to,
      payload,
      timestamp: Date.now()
    };
    return this.pubsub.publish('a2a:agents', message);
  }

  handleTask(from, to, payload) {
    console.log(`Task from ${from}:`, payload);
  }

  handleResult(from, to, payload) {
    console.log(`Result from ${from}:`, payload);
  }

  handleError(from, to, payload) {
    console.error(`Error from ${from}:`, payload);
  }

  handleHeartbeat(from, payload) {
    // Could track agent liveness here
  }
}

module.exports = { A2AAdapter };
