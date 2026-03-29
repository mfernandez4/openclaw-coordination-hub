/**
 * Result Processor
 * 
 * Middleware for processing worker results before they reach the orchestrator.
 * Applies filters, policies, and formatting.
 * 
 * Subscribes to: a2a:coordination
 * Publishes to: a2a:results:{orchestratorId}
 */

const fs = require('fs');
const { logger } = require('./logger');
const path = require('path');

const COORDINATION_CHANNEL = 'a2a:coordination';
const RESULTS_PREFIX = 'a2a:results';

class ResultProcessor {
  constructor(options = {}) {
    this.redis = null;
    this.configPath = options.configPath || path.join(__dirname, '../config/result-policies.json');
    this.defaultOrchestrator = options.orchestratorId || 'main';
    this.config = this.loadConfig();
    this.running = false;
  }

  /**
   * Load configuration from file
   */
  loadConfig() {
    const defaultConfig = {
      filters: [],
      formatters: {
        default: 'markdown',
        slack: 'compact',
        json: 'raw'
      },
      defaultFormatter: 'markdown',
      // Policy rules
      policies: {
        // Block results longer than X ms
        maxDurationMs: null,
        // Require approval for certain agents
        requireApproval: [],
        // Block specific agents
        blockAgents: [],
        // Log all results
        auditLog: true
      }
    };

    try {
      if (fs.existsSync(this.configPath)) {
        const userConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        return { ...defaultConfig, ...userConfig };
      }
    } catch (e) {
      logger.error('result-processor', 'Config load error', { error: e.message });
    }

    return defaultConfig;
  }

  /**
   * Reload configuration
   */
  reloadConfig() {
    this.config = this.loadConfig();
    logger.info('result-processor', 'Config reloaded');
  }

  /**
   * Connect to Redis
   */
  async connect() {
    const Redis = require('ioredis');
    // Use separate connections for subscriber and publisher
    this.subscriber = new Redis({
      host: process.env.REDIS_HOST || 'redis',
      port: process.env.REDIS_PORT || 6379
    });
    this.publisher = new Redis({
      host: process.env.REDIS_HOST || 'redis',
      port: process.env.REDIS_PORT || 6379
    });
    logger.info('result-processor', 'Connected to Redis');
  }

  /**
   * Apply filters to a result
   */
  applyFilters(result) {
    const { filters, policies } = this.config;
    let filtered = { ...result };
    let passed = true;
    let reason = null;

    // Check block list
    if (policies.blockAgents && policies.blockAgents.includes(filtered.agent)) {
      passed = false;
      reason = `Agent ${filtered.agent} is blocked`;
    }

    // Check max duration
    if (passed && policies.maxDurationMs && filtered.durationMs > policies.maxDurationMs) {
      // Could block, could just warn. For now, just pass with metadata
      filtered.warnings = filtered.warnings || [];
      filtered.warnings.push(`Duration ${filtered.durationMs}ms exceeds max ${policies.maxDurationMs}ms`);
    }

    // Check require approval list
    if (passed && policies.requireApproval && policies.requireApproval.includes(filtered.agent)) {
      filtered.requiresApproval = true;
    }

    // Apply custom filters from config
    for (const filter of filters) {
      if (filter.agent && filter.agent !== '*' && filter.agent !== filtered.agent) {
        continue;
      }

      if (filter.maxDurationMs && filtered.durationMs > filter.maxDurationMs) {
        passed = false;
        reason = `Duration ${filtered.durationMs}ms exceeds filter max ${filter.maxDurationMs}ms`;
        break;
      }
    }

    return { filtered, passed, reason };
  }

  /**
   * Format result based on configured formatter
   */
  formatResult(result, formatterName = null) {
    const formatter = formatterName || this.config.defaultFormatter || 'markdown';
    const formatters = this.config.formatters || {};

    switch (formatter) {
      case 'markdown':
        return this.formatMarkdown(result);
      case 'compact':
        return this.formatCompact(result);
      case 'json':
        return JSON.stringify(result, null, 2);
      default:
        // Try custom formatter or fall back to markdown
        if (formatters[formatter]) {
          return this.formatCustom(result, formatters[formatter]);
        }
        return this.formatMarkdown(result);
    }
  }

  /**
   * Format as markdown
   */
  formatMarkdown(result) {
    const { agent, task, status, output, error, durationMs, timestamp } = result;
    
    const lines = [];
    lines.push(`🤖 **${agent}** completed: "${task}"`);
    lines.push(`**Status:** ${status === 'completed' ? '✅' : '❌'} ${status}`);
    
    if (error) {
      lines.push(`**Error:** ${error}`);
    } else if (output) {
      lines.push('**Output:**');
      if (typeof output === 'object') {
        lines.push('```json');
        lines.push(JSON.stringify(output, null, 2));
        lines.push('```');
      } else {
        lines.push(output);
      }
    }
    
    if (durationMs) {
      lines.push(`*Duration: ${durationMs}ms*`);
    }
    
    return lines.join('\n');
  }

  /**
   * Format compact (one-liner)
   */
  formatCompact(result) {
    const { agent, task, status, error } = result;
    const emoji = status === 'completed' ? '✅' : '❌';
    const errStr = error ? ` (${error})` : '';
    return `${emoji} ${agent}: ${task}${errStr}`;
  }

  /**
   * Format using custom template
   */
  formatCustom(result, template) {
    return template
      .replace('{agent}', result.agent)
      .replace('{task}', result.task)
      .replace('{status}', result.status)
      .replace('{output}', JSON.stringify(result.output))
      .replace('{error}', result.error || '')
      .replace('{duration}', result.durationMs || '');
  }

  /**
   * Process a result
   */
  async processResult(rawResult) {
    logger.debug('result-processor', 'Processing result', { taskId: rawResult.taskId });

    // Apply filters
    const { filtered, passed, reason } = this.applyFilters(rawResult);

    if (!passed) {
      logger.warn('result-processor', 'Result blocked', { reason });
      // Could publish to a2a:blocked for audit
      return null;
    }

    // Add metadata
    filtered.processedAt = new Date().toISOString();
    filtered.formatter = this.config.defaultFormatter;

    // Format the result
    const formatted = this.formatResult(filtered);
    
    // Determine target channel (could route to specific orchestrator)
    const targetChannel = `${RESULTS_PREFIX}:${this.defaultOrchestrator}`;

    // Publish to results channel (pub/sub)
    await this.publisher.publish(targetChannel, JSON.stringify({
      raw: filtered,
      formatted: formatted
    }));

    // Also persist to results list (for orchestrator to pick up)
    const resultsKey = `a2a:results:${this.defaultOrchestrator}:list`;
    await this.publisher.lpush(resultsKey, JSON.stringify({
      raw: filtered,
      formatted: formatted
    }));
    // Keep only last 100 results
    await this.publisher.ltrim(resultsKey, 0, 99);

    logger.info('result-processor', 'Published result', { channel: targetChannel });

    // Audit log if enabled
    if (this.config.policies.auditLog) {
      const auditKey = `a2a:audit:${rawResult.taskId}`;
      await this.publisher.set(auditKey, JSON.stringify(filtered), 'EX', 86400); // 24h TTL
    }

    return { raw: filtered, formatted };
  }

  /**
   * Start processing
   */
  async start() {
    await this.connect();
    this.running = true;

    // Subscribe to coordination channel
    await this.subscriber.subscribe(COORDINATION_CHANNEL);
    logger.info('result-processor', 'Subscribed', { channel: COORDINATION_CHANNEL });

    // Listen for results
    this.subscriber.on('message', async (channel, message) => {
      if (channel !== COORDINATION_CHANNEL) return;

      try {
        const result = JSON.parse(message);
        
        if (result.type === 'result') {
          await this.processResult(result);
        }
      } catch (e) {
        logger.error('result-processor', 'Parse error', { error: e.message });
      }
    });

    logger.info('result-processor', 'Running');
  }

  /**
   * Stop processing
   */
  async stop() {
    this.running = false;
    if (this.subscriber) {
      await this.subscriber.unsubscribe(COORDINATION_CHANNEL);
      await this.subscriber.quit();
    }
    if (this.publisher) {
      await this.publisher.quit();
    }
    logger.info('result-processor', 'Stopped');
  }
}

// Run if executed directly
if (require.main === module) {
  const processor = new ResultProcessor();
  
  process.on('SIGINT', async () => {
    await processor.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await processor.stop();
    process.exit(0);
  });

  processor.start().catch(err => {
    logger.fatal('result-processor', 'Failed to start', { error: err.message });
    process.exit(1);
  });
}

module.exports = { ResultProcessor };
