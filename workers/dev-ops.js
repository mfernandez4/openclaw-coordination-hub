/**
 * DevOps Worker
 * Handles deployment, status checks, logs, and service restarts
 */

const BaseWorker = require('./base-worker.js');

class DevOpsWorker extends BaseWorker {
  constructor(agentId = 'dev-ops', options = {}) {
    super(agentId, options);
  }

  /**
   * Get worker capabilities
   */
  getCapabilities() {
    return ['exec', 'gateway'];
  }

  /**
   * Process a dev-ops task
   */
  async processTask(taskPayload) {
    const { task, context = {} } = taskPayload;

    switch (task) {
      case 'deploy':
        return this.handleDeploy(context);
      case 'status':
        return this.handleStatus(context);
      case 'logs':
        return this.handleLogs(context);
      case 'restart':
        return this.handleRestart(context);
      default:
        return { error: 'Unknown task' };
    }
  }

  /**
   * Handle deployment task
   */
  handleDeploy(context) {
    return {
      status: 'deployed',
      target: context.target
    };
  }

  /**
   * Handle status check task
   */
  handleStatus(context) {
    return {
      status: 'running',
      service: context.service
    };
  }

  /**
   * Handle logs retrieval task
   */
  handleLogs(context) {
    return {
      logs: 'sample log output'
    };
  }

  /**
   * Handle service restart task
   */
  handleRestart(context) {
    return {
      status: 'restarted'
    };
  }
}

// Run the worker if executed directly
if (require.main === module) {
  const worker = new DevOpsWorker('dev-ops');
  
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

module.exports = DevOpsWorker;
