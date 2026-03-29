/**
 * Mem0 Adapter - Optional memory layer
 *
 * This module is OPTIONAL and DISABLED BY DEFAULT.
 * Set MEM0_ENABLED=true to activate.
 *
 * Requires:
 *   MEM0_API_KEY  — API key for the Mem0 service
 *   MEM0_BASE_URL — Base URL (default: http://localhost:8000)
 *
 * If MEM0_ENABLED=true but MEM0_API_KEY is not set, logs fatal and falls
 * back to MemoryBridge rather than crashing.
 *
 * Runtime search/addMemory failures also fall back to MemoryBridge safely.
 *
 * See: https://github.com/mem0ai/mem0
 */
const { MemoryBridge } = require('./memory-bridge');
const { logger } = require('./logger');

class Mem0Adapter {
  constructor(options = {}) {
    this.enabled = options.enabled || process.env.MEM0_ENABLED === 'true';
    this.apiKey = options.apiKey || process.env.MEM0_API_KEY;
    this.baseUrl = (options.baseUrl || process.env.MEM0_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
    this.fallbackBridge = options.fallbackBridge || new MemoryBridge(options);

    if (this.enabled && !this.apiKey) {
      logger.fatal('mem0', 'MEM0_ENABLED=true but MEM0_API_KEY is not set — falling back to MemoryBridge');
      this.enabled = false;
    }
  }

  async initialize() {
    if (!this.enabled) {
      logger.info('mem0', 'Disabled (opt-in) — using basic memory bridge');
      return false;
    }

    logger.info('mem0', 'Initializing', { baseUrl: this.baseUrl });

    try {
      const res = await fetch(`${this.baseUrl}/v1/health/`, {
        method: 'GET',
        headers: { Authorization: `Token ${this.apiKey}` },
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) {
        throw new Error(`Health check returned HTTP ${res.status}`);
      }
      logger.info('mem0', 'Connected successfully');
      return true;
    } catch (err) {
      logger.fatal('mem0', 'Connection failed — falling back to MemoryBridge', { error: err.message });
      this.enabled = false;
      return false;
    }
  }

  async search(query, options = {}) {
    if (!this.enabled) {
      return this.fallbackBridge.getRecentSessions(options.limit || 10);
    }

    try {
      const res = await fetch(`${this.baseUrl}/v1/memories/search/`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query,
          user_id: options.userId || 'workspace',
          agent_id: options.agentId,
          limit: options.limit || 10
        })
      });
      const data = await res.json();
      return data.results || [];
    } catch (err) {
      logger.warn('mem0', 'Search failed — falling back to MemoryBridge', { error: err.message });
      return this.fallbackBridge.getRecentSessions(options.limit || 10);
    }
  }

  async addMemory(content, metadata = {}) {
    if (!this.enabled) {
      return this.fallbackBridge.recordAgentEvent(metadata.agentId || 'unknown', 'memory', { content });
    }

    try {
      const res = await fetch(`${this.baseUrl}/v1/memories/`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content }],
          user_id: metadata.userId || 'workspace',
          agent_id: metadata.agentId || 'hub'
        })
      });
      return await res.json();
    } catch (err) {
      logger.warn('mem0', 'addMemory failed — falling back to MemoryBridge', { error: err.message });
      return this.fallbackBridge.recordAgentEvent(metadata.agentId || 'unknown', 'memory', { content });
    }
  }

  isEnabled() {
    return this.enabled;
  }
}

module.exports = { Mem0Adapter };
