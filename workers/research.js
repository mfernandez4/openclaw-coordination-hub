/**
 * Research Worker
 * Handles web search, web fetch, and text analysis tasks
 */

const BaseWorker = require('./base-worker.js');

class ResearchWorker extends BaseWorker {
  constructor(options = {}) {
    super('research', options);
  }

  /**
   * Get worker capabilities
   */
  getCapabilities() {
    return ['web_search', 'web_fetch'];
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

    console.log(`[${this.agentId}] Searching for: ${query}`);

    try {
      const result = await web_search({
        query,
        count,
        country,
        freshness
      });
      
      return {
        success: true,
        query,
        results: result
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Handle web fetch task
   */
  async handleFetch(context) {
    const { url, extractMode = 'markdown', maxChars = 50000 } = context;
    
    if (!url) {
      return { error: 'Missing url parameter' };
    }

    console.log(`[${this.agentId}] Fetching: ${url}`);

    try {
      const result = await web_fetch({
        url,
        extractMode,
        maxChars
      });
      
      return {
        success: true,
        url,
        content: result
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
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

    console.log(`[${this.agentId}] Analyzing text (${text.length} chars)`);

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
    console.error('Worker failed to start:', err);
    process.exit(1);
  });
}

module.exports = ResearchWorker;
