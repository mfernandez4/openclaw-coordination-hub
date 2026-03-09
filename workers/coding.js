/**
 * Coding Worker
 * Handles file operations and code-related tasks
 */

const BaseWorker = require('./base-worker');
const fs = require('fs').promises;
const path = require('path');
const { exec: execPromise } = require('child_process');

class CodingWorker extends BaseWorker {
  constructor(agentId, options = {}) {
    super(agentId, options);
  }

  /**
   * Get worker capabilities
   */
  getCapabilities() {
    return ['read', 'write', 'edit', 'exec'];
  }

  /**
   * Process a task
   */
  async processTask(taskPayload) {
    const { task, context = {} } = taskPayload;
    
    switch (task) {
      case 'list-files':
        return await this.listFiles(context.path);
      
      case 'read-file':
        return await this.readFile(context.path);
      
      case 'write-file':
        return await this.writeFile(context.path, context.content);
      
      case 'search-code':
        return await this.searchCode(context.pattern, context.path);
      
      case 'run-tests':
        return await this.runTests(context.path);
      
      default:
        return { error: 'Unknown task' };
    }
  }

  /**
   * List files in a directory
   */
  async listFiles(dirPath) {
    try {
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      const results = files.map(file => ({
        name: file.name,
        isDirectory: file.isDirectory(),
        isFile: file.isFile(),
        path: path.join(dirPath, file.name)
      }));
      return { files: results, count: results.length };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Read a file
   */
  async readFile(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { content, path: filePath };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Write content to a file
   */
  async writeFile(filePath, content) {
    try {
      // Ensure directory exists
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      
      await fs.writeFile(filePath, content, 'utf-8');
      return { success: true, path: filePath };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Search for a pattern in files (grep-like)
   */
  async searchCode(pattern, searchPath = '.') {
    try {
      const command = `grep -r "${pattern}" ${searchPath} --include="*.js" --include="*.json" --include="*.md" --include="*.ts" --include="*.jsx" --include="*.tsx" -l 2>/dev/null || true`;
      
      return new Promise((resolve) => {
        execPromise(command, { encoding: 'utf-8' })
          .then(files => {
            if (!files.trim()) {
              resolve({ files: [], message: 'No matches found' });
            } else {
              const fileList = files.trim().split('\n').filter(f => f);
              resolve({ files: fileList, count: fileList.length });
            }
          })
          .catch(() => {
            resolve({ files: [], message: 'No matches found' });
          });
      });
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Run tests (npm test or similar)
   */
  async runTests(projectPath = '.') {
    try {
      const command = `cd ${projectPath} && npm test`;
      
      return new Promise((resolve) => {
        execPromise(command, { encoding: 'utf-8', timeout: 120000 })
          .then(stdout => {
            resolve({ output: stdout, success: true });
          })
          .catch(error => {
            resolve({ output: error.message, success: false });
          });
      });
    } catch (error) {
      return { error: error.message };
    }
  }
}

// Run the worker if executed directly
if (require.main === module) {
  const worker = new CodingWorker('coding');
  
  process.on('SIGTERM', async () => {
    await worker.stop();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    await worker.stop();
    process.exit(0);
  });
  
  worker.start().catch(console.error);
}

module.exports = CodingWorker;
