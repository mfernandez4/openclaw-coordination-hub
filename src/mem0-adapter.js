/**
 * Mem0 Adapter - Optional memory layer
 * 
 * This module is OPTIONAL and DISABLED BY DEFAULT.
 * Set MEM0_ENABLED=true to activate.
 * 
 * Mem0 provides semantic memory with embeddings.
 * See: https://github.com/mem0ai/mem0
 */
const { MemoryBridge } = require('./memory-bridge');

class Mem0Adapter {
  constructor(options = {}) {
    this.enabled = options.enabled || process.env.MEM0_ENABLED === 'true';
    this.apiKey = options.apiKey || process.env.MEM0_API_KEY;
    this.baseUrl = options.baseUrl || process.env.MEM0_BASE_URL || 'http://localhost:8000';
    this.fallbackBridge = options.fallbackBridge || new MemoryBridge(options);
    
    if (this.enabled && !this.apiKey) {
      console.warn('[Mem0] MEM0_ENABLED=true but MEM0_API_KEY not set - falling back to basic memory');
      this.enabled = false;
    }
  }

  async initialize() {
    if (!this.enabled) {
      console.log('[Mem0] Disabled (opt-in) - using basic memory bridge');
      return false;
    }

    console.log('[Mem0] Initializing at', this.baseUrl);
    // Actual Mem0 client initialization would go here
    // For now, just log that we're in Mem0 mode
    return true;
  }

  async search(query, options = {}) {
    if (!this.enabled) {
      return this.fallbackBridge.getRecentSessions(options.limit || 10);
    }

    // Mem0 semantic search would go here
    console.log('[Mem0] Search:', query);
    return [];
  }

  async addMemory(content, metadata = {}) {
    if (!this.enabled) {
      return this.fallbackBridge.recordAgentEvent(metadata.agentId || 'unknown', 'memory', { content });
    }

    // Mem0 add memory would go here
    console.log('[Mem0] Add memory:', content.substring(0, 50) + '...');
    return { id: `mem0:${Date.now()}`, content, metadata };
  }

  isEnabled() {
    return this.enabled;
  }
}

module.exports = { Mem0Adapter };
