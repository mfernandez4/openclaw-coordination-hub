/**
 * A2A (Agent-to-Agent) Protocol Adapter
 *
 * Provides modality-agnostic agent communication
 * following the A2A specification patterns.
 *
 * Features:
 * - Broadcast to all agents (a2a:agents)
 * - Directed handoffs (to specific agent via inbox)
 * - Coordination channel for peer negotiation
 * - Agent registry for discovery
 */
const { EventEmitter } = require('events');
const { RedisPubSub } = require('./redis-pubsub');
const { logger } = require('./logger');

class A2AAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pubsub = options.pubsub || null;
    this.agentId = options.agentId || 'hub';
    this.messageTypes = ['task', 'result', 'error', 'heartbeat', 'handoff', 'negotiate', 'ack'];
    this.inboxQueue = `a2a:inbox:${this.agentId}`;
    this.registryKey = 'a2a:registry';
    this.registry = new Map(); // agentId -> { status, capabilities, lastSeen }
    // Threshold used in syncRegistryFromRedis() to prune dead agents.
    // Default is 3× the default heartbeat interval (30s × 3 = 90s).
    // Set lower if your workers use a shorter heartbeatInterval so stale
    // entries are evicted within a reasonable liveness window.
    this.staleAgentMs = options.staleAgentMs ?? 90000;
  }

  async initialize(pubsub) {
    this.pubsub = pubsub;

    // Subscribe to broadcast channel (all agents)
    await this.pubsub.subscribe('a2a:agents', this.handleBroadcast.bind(this));

    // Subscribe to coordination channel (peer negotiation)
    await this.pubsub.subscribe('a2a:coordination', this.handleCoordination.bind(this));

    // Subscribe to own inbox for directed messages
    await this.pubsub.subscribe(this.inboxQueue, this.handleInbox.bind(this));

    // Best-effort sync from Redis registry first to avoid split-brain on restart.
    await this.syncRegistryFromRedis();

    // Register self
    this.registerAgent(this.agentId, { capabilities: this.getCapabilities() });
    await this.syncAgentToRedis(this.agentId, {
      capabilities: this.getCapabilities(),
      status: 'online',
      lastSeen: Date.now()
    });

    logger.info('a2a', `${this.agentId} initialized`, { agentId: this.agentId, inbox: this.inboxQueue });
  }

  // ========== Agent Registry ==========

  registerAgent(agentId, metadata = {}) {
    this.registry.set(agentId, {
      ...metadata,
      status: 'online',
      lastSeen: Date.now()
    });
    logger.info('a2a', `Registered: ${agentId}`, { agentId });
  }

  getAgent(agentId) {
    return this.registry.get(agentId);
  }

  getAllAgents() {
    return Array.from(this.registry.entries()).map(([id, data]) => ({ id, ...data }));
  }

  getOnlineAgents() {
    const now = Date.now();
    return this.getAllAgents().filter(a => now - a.lastSeen < 60000); // 60s timeout
  }

  async syncRegistryFromRedis() {
    if (!this.pubsub?.client) return;

    try {
      const entries = await this.pubsub.client.hgetall(this.registryKey);
      if (!entries) return;

      const agentIds = Object.keys(entries);

      // Batch-check all per-agent TTL sentinel keys in one round-trip.
      // Sentinels are written by BaseWorker.register() / sendHeartbeat() and expire
      // at 3× heartbeat interval. A missing sentinel means the agent stopped
      // heartbeating (crashed or clean stop without deregister()).
      const sentinelKeys = agentIds.map(id => `${this.registryKey}:${id}:ttl`);
      const sentinelValues = sentinelKeys.length > 0
        ? await this.pubsub.client.mget(...sentinelKeys)
        : [];
      const liveAgents = new Set(agentIds.filter((_, i) => sentinelValues[i] !== null));

      for (const [agentId, raw] of Object.entries(entries)) {
        try {
          const parsed = JSON.parse(raw);

          // Prune entries whose sentinel has expired and whose lastSeen is stale.
          // Skip self — the hub has no sentinel and should never prune itself.
          // The lastSeen guard prevents false-pruning non-BaseWorker agents (e.g.
          // external registrations) that don't use the sentinel pattern.
          if (agentId !== this.agentId && !liveAgents.has(agentId)) {
            const lastSeenAge = typeof parsed.lastSeen === 'number'
              ? Date.now() - parsed.lastSeen
              : Infinity;
            if (lastSeenAge > this.staleAgentMs) {
              await this.pubsub.client.hdel(this.registryKey, agentId);
              this.registry.delete(agentId);
              logger.info('a2a', `Pruned stale registry entry for crashed agent`, { agentId });
              continue;
            }
          }

          this.registry.set(agentId, {
            ...(this.registry.get(agentId) || {}),
            ...parsed,
            status: parsed.status || 'online',
            // Use 0 (epoch) as fallback — not Date.now() — so entries without a
            // lastSeen field are treated as stale, not as just-seen.
            lastSeen: typeof parsed.lastSeen === 'number' ? parsed.lastSeen : 0
          });
        } catch {
          // ignore malformed rows
        }
      }
    } catch (err) {
      logger.error('a2a', 'Redis registry sync failed', { error: err.message });
    }
  }

  async syncAgentToRedis(agentId, metadata = {}) {
    if (!this.pubsub?.client) return;

    const entry = {
      status: metadata.status || 'online',
      capabilities: metadata.capabilities || [],
      lastSeen: metadata.lastSeen || Date.now()
    };

    try {
      await this.pubsub.client.hset(this.registryKey, agentId, JSON.stringify(entry));
    } catch (err) {
      logger.error('a2a', 'Redis registry write failed', { error: err.message });
    }
  }

  // ========== Message Handling ==========

  handleBroadcast(message) {
    // Handle messages sent to broadcast channel
    // If 'to' is specified and it's not us, ignore
    if (message.to && message.to !== this.agentId && message.to !== '*') {
      return; // Not for us
    }

    // Best-effort periodic pull from Redis to avoid local/remote drift.
    if (message.type === 'heartbeat' || message.type === 'result') {
      this.syncRegistryFromRedis().catch(() => {});
    }

    // Artifact availability notification from SharedStore.
    // Emit as an event so hub/workers can subscribe without coupling to handleMessage.
    if (message.type === 'artifact_ready') {
      logger.info('a2a', `Artifact ready: ${message.artifactId}`, {
        artifactId: message.artifactId,
        agentId: message.agentId,
        tags: message.tags
      });
      this.emit('artifact_ready', message);
      return;
    }

    this.handleMessage(message);
  }

  handleInbox(message) {
    // Handle directed messages to our inbox
    if (message.to === this.agentId) {
      logger.info('a2a', `Direct message from ${message.from}`, { from: message.from, type: message.type });
      this.handleMessage(message);
    }
  }

  handleCoordination(message) {
    // Handle peer negotiation messages
    logger.info('a2a', `Coordination from ${message.from}`, { from: message.from, type: message.type });
    this.handleNegotiation(message);
  }

  handleMessage(message) {
    const { type, from, to, payload } = message;

    if (!this.messageTypes.includes(type)) {
      logger.warn('a2a', `Unknown message type: ${type}`, { type });
      return;
    }

    // Route message based on type
    switch (type) {
      case 'task':
      case 'handoff':
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
      case 'ack':
        this.handleAck(from, to, payload);
        break;
      case 'negotiate':
        this.handleNegotiation(message);
        break;
    }
  }

  // ========== Send Methods ==========

  /**
   * Send to specific agent (directed handoff)
   */
  async sendTo(agentId, type, payload) {
    const message = {
      type,
      from: this.agentId,
      to: agentId,
      payload,
      timestamp: Date.now(),
      id: `msg:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`
    };
    // Publish to target's inbox
    const inboxChannel = `a2a:inbox:${agentId}`;
    await this.pubsub.publish(inboxChannel, message);
    logger.info('a2a', `Directed to ${agentId}`, { to: agentId, type });
    return message.id;
  }

  /**
   * Send to all agents (broadcast)
   */
  async broadcast(type, payload) {
    const message = {
      type,
      from: this.agentId,
      to: '*',
      payload,
      timestamp: Date.now(),
      id: `msg:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`
    };
    await this.pubsub.publish('a2a:agents', message);
    logger.info('a2a', `Broadcast: ${type}`, { type });
    return message.id;
  }

  /**
   * Send to coordination channel (peer negotiation)
   */
  async coordinate(type, payload) {
    const message = {
      type: 'negotiate',
      from: this.agentId,
      to: 'coordination',
      payload: { ...payload, coordinationType: type },
      timestamp: Date.now(),
      id: `msg:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`
    };
    await this.pubsub.publish('a2a:coordination', message);
    logger.info('a2a', `Coordination: ${type}`, { type });
    return message.id;
  }

  /**
   * Convenience: handoff to another agent
   */
  async handoffTo(agentId, taskDescription, context = {}) {
    return this.sendTo(agentId, 'handoff', {
      task: taskDescription,
      context,
      handedOffBy: this.agentId,
      priority: context.priority || 0
    });
  }

  // ========== Handlers (override in subclass) ==========

  handleTask(from, to, payload) {
    logger.info('a2a', `Task from ${from}`, { from, payload });
  }

  handleResult(from, to, payload) {
    logger.info('a2a', `Result from ${from}`, { from, payload });
  }

  handleError(from, to, payload) {
    logger.error('a2a', `Error from ${from}`, { from, payload });
  }

  handleHeartbeat(from, payload) {
    // Update registry
    const current = this.registry.get(from) || { capabilities: [] };
    const updated = {
      ...current,
      status: payload.status || 'online',
      lastSeen: Date.now()
    };

    this.registry.set(from, updated);
    this.syncAgentToRedis(from, updated).catch(() => {});
  }

  handleAck(from, to, payload) {
    logger.info('a2a', `Ack from ${from}`, { from, payload });
  }

  handleNegotiation(message) {
    const { from, payload } = message;
    logger.info('a2a', `Negotiation from ${from}`, { from, payload });
    // Override to implement conflict resolution
  }

  // ========== Helpers ==========

  getCapabilities() {
    return [];
  }

  getStatus() {
    return {
      agentId: this.agentId,
      inbox: this.inboxQueue,
      onlineAgents: this.getOnlineAgents().length,
      registeredAgents: this.getAllAgents().length
    };
  }
}

module.exports = { A2AAdapter };
