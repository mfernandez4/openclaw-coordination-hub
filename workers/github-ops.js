/**
 * GitHub Operations Worker
 * Handles GitHub CLI (gh) and git operations
 */

const { execFile } = require('child_process');
const BaseWorker = require('./base-worker');

// Strict branch name validation — alphanumeric, slash, underscore, dot, hyphen only
const BRANCH_NAME_REGEX = /^[a-zA-Z0-9/_.-]+$/;
const SHELL_METACHAR_REGEX = /[,;|`$(){}[\]<>\\!#*?"'&\n\r]/;

function isBranchNameSafe(branch) {
  return BRANCH_NAME_REGEX.test(branch) && !SHELL_METACHAR_REGEX.test(branch);
}

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
   * Execute a command using execFile (no shell interpolation)
   * Returns a promise for async use.
   */
  execCommandAsync(args) {
    return new Promise((resolve) => {
      execFile(args[0], args.slice(1), {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024
      }, (err, stdout, stderr) => {
        if (err) {
          resolve({
            success: false,
            error: err.message,
            stderr: stderr ? stderr.trim() : null
          });
        } else {
          resolve({ success: true, output: stdout.trim() });
        }
      });
    });
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
        return this.execCommandAsync(['gh', 'pr', 'view', pr, '--json', 'title,state,url']);

      case 'list-prs':
        return this.execCommandAsync(['gh', 'pr', 'list', '--json', 'number,title,state,url']);

      case 'check-issue':
        if (!number) {
          return { error: 'Missing required parameter: number' };
        }
        return this.execCommandAsync(['gh', 'issue', 'view', number.toString()]);

      case 'list-issues':
        return this.execCommandAsync(['gh', 'issue', 'list', '--json', 'number,title,state']);

      case 'create-branch':
        if (!branch) {
          return { error: 'Missing required parameter: branch' };
        }
        if (!isBranchNameSafe(branch)) {
          return { error: 'Invalid branch name: contains forbidden characters or pattern' };
        }
        return this.execCommandAsync(['git', 'checkout', '-b', branch]);

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
