/**
 * Memory Bridge - connects coordination hub to OpenClaw's memory system
 * 
 * Provides read/write access to memory-system-v1 graph and sessions.
 * Reads from journal.jsonl for session history.
 * Writes agent events to journal.jsonl in memory-system format.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MemoryBridge {
  constructor(options = {}) {
    this.memoryBasePath = options.memoryBasePath ||
      process.env.OPENCLAW_MEMORY_BASE ||
      '/f/ai-workspace/projects/openclaw-memory-system-v1/.memory-system';
    this.journalPath = path.join(this.memoryBasePath, 'journal.jsonl');
  }

  /**
   * Get recent sessions from journal.jsonl
   * Filters for 'session_start' events within the last N hours.
   */
  async getRecentSessions(hours = 24) {
    if (!fs.existsSync(this.journalPath)) {
      console.warn('[MemoryBridge] journal.jsonl not found — returning empty sessions');
      return [];
    }

    try {
      const content = fs.readFileSync(this.journalPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const cutoff = Date.now() - hours * 60 * 60 * 1000;

      const sessions = [];
      for (const line of lines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        // Look for session_start events or agent_reg events
        if (entry.event === 'session_start' || entry.event === 'agent_reg') {
          const ts = entry.ts ? new Date(entry.ts).getTime() : 0;
          if (ts >= cutoff) {
            sessions.push({
              sessionId: entry.session_id || entry.sessionId || entry.trace_id,
              agentId: entry.agent_id || entry.agentId,
              ts: entry.ts,
              type: entry.event,
              source: entry.source || 'coordination-hub'
            });
          }
        }
      }

      return sessions;
    } catch (err) {
      console.warn(`[MemoryBridge] Failed to read sessions: ${err.message}`);
      return [];
    }
  }

  /**
   * Record an agent event to journal.jsonl in memory-system format.
   * Writes as a JSON line compatible with the memory-system pipeline.
   * Non-blocking — errors are logged but do not throw.
   */
  async recordAgentEvent(agentId, eventType, data = {}) {
    const ts = new Date().toISOString();
    const blockId = crypto.randomUUID();
    const content = JSON.stringify(data);
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    const journalEntry = {
      ts,
      event: eventType,
      trace_id: `coordination-hub:${agentId}:${eventType}:${Date.now()}`,
      block_id: blockId,
      agent_id: agentId,
      dedupe_key: `sha256:${contentHash}`,
      content_hash: contentHash,
      source: 'coordination-hub',
      data,
      routes: {
        daily: { written: false, reason: 'coordination_hub_event' },
        long_term: { written: false, reason: 'coordination_hub_event' }
      },
      prioritization: {
        score: 50,
        recommended_priority: 'P1',
        suppressed: false,
        effective_priority: 'P1'
      },
      graph: { status: 'noop', attempted: false }
    };

    try {
      fs.appendFileSync(this.journalPath, JSON.stringify(journalEntry) + '\n');
    } catch (err) {
      console.error(`[MemoryBridge] Failed to write agent event: ${err.message}`);
      // Non-blocking — do not throw
    }

    return { ts, blockId, agentId, eventType };
  }

  async getAgentContext(agentId) {
    // Retrieve context for a specific agent from memory
    // Placeholder implementation
    return {
      agentId,
      lastSeen: Date.now(),
      capabilities: []
    };
  }
}

module.exports = { MemoryBridge };
