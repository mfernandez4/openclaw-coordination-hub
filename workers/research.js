/**
 * Research Worker
 * Handles web search, web fetch, and text analysis tasks
 */

const BaseWorker = require('./base-worker.js');
const { logger } = require('../src/logger');

// Search API configuration — set BRAVE_SEARCH_API_KEY env var to enable
const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY;
const SEARCH_API_URL = 'https://api.search.brave.com/res/v1/web/search';

class ResearchWorker extends BaseWorker {
  constructor(options = {}) {
    super('research', options);
  }

  /**
   * Get worker capabilities
   */
  getCapabilities() {
    return ['web_search', 'web_fetch', 'analyze'];
  }

  /**
   * Process a research task
   */
  async processTask(taskPayload) {
    const { task, context } = taskPayload;

    switch (task) {
      case 'search':
        return await this.handleSearch(context);
      
      case 'fetch':
        return await this.handleFetch(context);
      
      case 'analyze':
        return await this.handleAnalyze(context);
      
      default:
        return { error: 'Unknown task' };
    }
  }

  /**
   * Handle web search task
   */
  async handleSearch(context) {
    const { query, count = 5, country = 'US', freshness } = context;
    
    if (!query) {
      return { error: 'Missing query parameter' };
    }

    logger.info(this.agentId, `Searching for: ${query}`, { query });

    if (!BRAVE_SEARCH_API_KEY) {
      return {
        success: false,
        status: 'not_configured',
        error: 'BRAVE_SEARCH_API_KEY env var not set. Web search is disabled.'
      };
    }

    try {
      const params = new URLSearchParams({
        q: query,
        count: count.toString(),
        country,
        ...(freshness ? { freshness } : {})
      });

      const response = await fetch(`${SEARCH_API_URL}?${params}`, {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': BRAVE_SEARCH_API_KEY
        }
      });

      if (!response.ok) {
        return { success: false, error: `Search API returned ${response.status}: ${response.statusText}` };
      }

      const data = await response.json();
      const results = (data.results || []).slice(0, count).map(r => ({
        title: r.title,
        url: r.url,
        description: r.description
      }));

      return { success: true, query, count: results.length, results };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle web fetch task
   */
  async handleFetch(context) {
    const { url, maxChars = 50000 } = context;
    
    if (!url) {
      return { error: 'Missing url parameter' };
    }

    logger.info(this.agentId, `Fetching: ${url}`, { url });

    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; CoordinationHub/1.0)'
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const text = await response.text();
      return {
        success: true,
        url,
        statusCode: response.status,
        content: text.substring(0, maxChars),
        truncated: text.length > maxChars,
        fullLength: text.length
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle text analysis task
   */
  async handleAnalyze(context) {
    const { text } = context;
    
    if (!text) {
      return { error: 'Missing text parameter' };
    }

    logger.info(this.agentId, `Analyzing text (${text.length} chars)`, { length: text.length });

    // Simple analysis - could be extended with more sophisticated processing
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
    const charCount = text.length;
    const lineCount = text.split('\n').length;
    
    // Detect language hints (simple heuristic)
    const hasUrl = /https?:\/\/[^\s]+/.test(text);
    const hasEmail = /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text);
    const hasNumbers = /\d+/.test(text);
    
    return {
      success: true,
      analysis: {
        wordCount,
        charCount,
        lineCount,
        hints: {
          hasUrl,
          hasEmail,
          hasNumbers
        },
        // Return the original text for reference
        textPreview: text.substring(0, 500) + (text.length > 500 ? '...' : '')
      }
    };
  }
}

// Run the worker if executed directly
if (require.main === module) {
  const worker = new ResearchWorker();
  
  process.on('SIGINT', async () => {
    await worker.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    await worker.stop();
    process.exit(0);
  });
  
  worker.start().catch(err => {
    logger.fatal('research', 'Worker failed to start', { error: err.message, stack: err.stack });
    process.exitCode = 1;
  });
}

module.exports = ResearchWorker;
