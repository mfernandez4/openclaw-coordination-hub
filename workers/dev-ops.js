/**
 * DevOps Worker
 * Handles deployment, status checks, logs, and service restarts via Docker
 */

const BaseWorker = require('./base-worker.js');
const { execFile } = require('child_process');
const fs = require('fs');

function execDocker(args) {
  return new Promise((resolve) => {
    execFile('docker', args, { encoding: 'utf-8', timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: err.message, stderr: stderr || '' });
      } else {
        resolve({ success: true, stdout: stdout.trim(), stderr: stderr ? stderr.trim() : '' });
      }
    });
  });
}

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
   * Handle deployment task — docker compose up -d
   */
  async handleDeploy(context) {
    const { target, projectPath } = context;
    if (!target && !projectPath) {
      return { success: false, error: 'Missing required: target or projectPath' };
    }

    const project = target || projectPath;
    const result = await execDocker(['compose', '-f', project, 'up', '-d', '--pull', 'always']);

    if (result.success) {
      return { success: true, message: `Deployed ${project}`, output: result.stdout };
    } else {
      // Fallback for non-compose targets (e.g., docker run)
      const runResult = await execDocker(['run', '-d', '--name', target, target]);
      if (runResult.success) {
        return { success: true, message: `Container ${target} started`, output: runResult.stdout };
      }
      return { success: false, error: `Deploy failed: ${result.error}`, detail: result.stderr };
    }
  }

  /**
   * Handle status check — docker ps / docker inspect
   */
  async handleStatus(context) {
    const { service } = context;
    if (!service) {
      // List all running containers
      const result = await execDocker(['ps', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}']);
      if (result.success) {
        const lines = result.stdout.split('\n').filter(Boolean).map(line => {
          const [name, status, image] = line.split('\t');
          return { name, status, image };
        });
        return { success: true, services: lines };
      }
      return { success: false, error: result.error };
    }

    const result = await execDocker(['inspect', '--format', '{{.State.Status}}', service]);
    if (result.success) {
      return { success: true, service, status: result.stdout };
    }
    return { success: false, error: `Service '${service}' not found or not accessible` };
  }

  /**
   * Handle logs retrieval — docker logs or read from log path
   */
  async handleLogs(context) {
    const { service, lines = 100, logPath } = context;

    if (logPath) {
      // Read from configured log file path
      if (!fs.existsSync(logPath)) {
        return { success: false, error: `Log path not found: ${logPath}` };
      }
      const content = fs.readFileSync(logPath, 'utf-8');
      const allLines = content.split('\n');
      return { success: true, logs: allLines.slice(-lines).join('\n'), source: logPath };
    }

    if (!service) {
      return { success: false, error: 'Missing required: service or logPath' };
    }

    const result = await execDocker(['logs', '--tail', String(lines), service]);
    return {
      success: result.success,
      logs: result.success ? result.stdout : result.stderr,
      source: `docker:${service}`,
      error: result.success ? undefined : result.error
    };
  }

  /**
   * Handle service restart — docker restart
   */
  async handleRestart(context) {
    const { service } = context;
    if (!service) {
      return { success: false, error: 'Missing required: service' };
    }

    const result = await execDocker(['restart', service]);
    if (result.success) {
      return { success: true, message: `Service '${service}' restarted` };
    }
    return { success: false, error: `Restart failed: ${result.error}` };
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
