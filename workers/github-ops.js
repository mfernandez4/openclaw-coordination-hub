/**
 * GitHub Operations Worker
 * Handles GitHub CLI (gh) and git operations
 */

const { execSync } = require('child_process');
const BaseWorker = require('./base-worker');

class GitHubOpsWorker extends BaseWorker {
  constructor(options = {}) {
    super('github-ops', options);
  }

  /**
   * Get worker capabilities
   */
  getCapabilities() {
    return ['gh', 'git', 'read', 'write'];
  }

  /**
   * Execute shell command and return result
   */
  execCommand(command) {
    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return { success: true, output: output.trim() };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        stderr: error.stderr ? error.stderr.trim() : null
      };
    }
  }

  /**
   * Process a task based on task type
   */
  async processTask(taskPayload) {
    const { task, pr, number, branch } = taskPayload;

    switch (task) {
      case 'check-pr':
        if (!pr) {
          return { error: 'Missing required parameter: pr' };
        }
        return this.execCommand(`gh pr view ${pr} --json title,state,url`);

      case 'list-prs':
        return this.execCommand(`gh pr list --json number,title,state,url`);

      case 'check-issue':
        if (!number) {
          return { error: 'Missing required parameter: number' };
        }
        return this.execCommand(`gh issue view ${number}`);

      case 'list-issues':
        return this.execCommand(`gh issue list --json number,title,state`);

      case 'create-branch':
        if (!branch) {
          return { error: 'Missing required parameter: branch' };
        }
        return this.execCommand(`git checkout -b ${branch}`);

      default:
        return { error: 'Unknown task' };
    }
  }
}

// Start worker if run directly
if (require.main === module) {
  const worker = new GitHubOpsWorker();
  
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

module.exports = GitHubOpsWorker;
