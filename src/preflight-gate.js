/**
 * Preflight Gate — Pre-execution checks before a lane runs
 *
 * Runs after ledger.start() and before task execution begins.
 * If any check fails, the lane is transitioned to `blocked` and execution is skipped.
 *
 * Preflight scope (v1 — narrowest useful slice):
 *   - Repo visibility: target project path is readable
 *   - Required files: key files/directories exist (inferred from task type)
 *
 * Follow-on slices can add:
 *   - Write access: git push dry-run to target branch
 *   - Tools callable: required CLIs available (git, node, npm, gh)
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const PROJECT_BASE = '/f/ai-workspace/projects';

// ── Individual checks ─────────────────────────────────────────────────────────

/**
 * Check that a directory exists and is readable.
 * @param {string} dirPath
 * @returns {{ passed: boolean, reason?: string }}
 */
async function checkRepoAccess(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      return { passed: false, reason: `Repo path exists but is not a directory: ${dirPath}` };
    }
    return { passed: true };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { passed: false, reason: `Repo path does not exist: ${dirPath}` };
    }
    if (err.code === 'EACCES') {
      return { passed: false, reason: `Repo path is not readable: ${dirPath} (${err.message})` };
    }
    return { passed: false, reason: `Repo path access check failed: ${err.message}` };
  }
}

/**
 * Check that required files/directories exist within a repo.
 * Partial failures (some missing) are reported with the specific missing items.
 *
 * @param {string} repoPath
 * @param {string[]} requiredItems  — relative paths from repo root
 * @returns {{ passed: boolean, reason?: string, missing?: string[] }}
 */
async function checkRequiredFiles(repoPath, requiredItems) {
  if (!requiredItems || requiredItems.length === 0) {
    return { passed: true };
  }

  const missing = [];
  for (const item of requiredItems) {
    const fullPath = path.join(repoPath, item);
    try {
      await fs.access(fullPath);
    } catch {
      missing.push(item);
    }
  }

  if (missing.length === requiredItems.length) {
    return {
      passed: false,
      reason: `All required items are missing in ${repoPath}`,
      missing
    };
  }

  if (missing.length > 0) {
    return {
      passed: false,
      reason: `Some required items are missing in ${repoPath}: ${missing.join(', ')}`,
      missing
    };
  }

  return { passed: true };
}

// ── Required file inference ───────────────────────────────────────────────────

/**
 * Infer required files/directories from task payload.
 * Returns a list of relative paths that must exist for the task to have any chance.
 *
 * @param {object} taskPayload
 * @returns {string[]} relative paths from repo root
 */
function inferRequiredFiles(taskPayload) {
  const { objective, task: taskDesc, type } = taskPayload;
  const desc = [objective, taskDesc].filter(Boolean).join(' ');
  const lower = desc.toLowerCase();

  // Coding / implementation tasks need src/ and tests/
  if (type === 'coding' || lower.includes('implement') || lower.includes('fix') || lower.includes('add')) {
    return ['src', 'test', 'package.json'];
  }

  // Documentation tasks
  if (lower.includes('docs') || lower.includes('readme') || lower.includes('document')) {
    return ['README.md'];
  }

  // Review tasks
  if (lower.includes('review') || lower.includes('audit')) {
    return ['package.json'];
  }

  // Default: at minimum, the repo root must be non-empty (already covered by checkRepoAccess)
  return ['package.json'];
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run all preflight checks for a task payload.
 *
 * @param {object} taskPayload — the task object from the queue
 * @returns {Promise<{ passed: boolean, reason?: string, mitigation?: string, checks?: object }>}
 *
 * Result shape:
 *   { passed: true }                                      — all checks passed
 *   { passed: false, reason, mitigation, checks }        — at least one check failed
 */
async function runPreflight(taskPayload) {
  if (!taskPayload || typeof taskPayload !== 'object') {
    return {
      passed: false,
      reason: 'Invalid task payload: not an object',
      mitigation: 'Check that the task enqueueing code is sending a valid payload'
    };
  }

  const { project, repoPath, path: altPath } = taskPayload;

  // Resolve repo path: explicit field > project name > alt path
  const resolvedPath = repoPath || (project ? path.join(PROJECT_BASE, project) : null) || altPath;

  if (!resolvedPath) {
    return {
      passed: false,
      reason: 'Cannot determine repo path: no project, repoPath, or path field in task payload',
      mitigation: 'Add a project name or repoPath to the task payload'
    };
  }

  const checks = {};
  let passed = true;
  let reason = '';
  let mitigation = '';

  // Check 1: repo visibility
  const accessResult = await checkRepoAccess(resolvedPath);
  checks.repoAccess = accessResult;
  if (!accessResult.passed) {
    passed = false;
    reason = accessResult.reason;
    mitigation = `Verify the project path exists and the hub has read access to ${resolvedPath}`;
    return { passed, reason, mitigation, checks };
  }

  // Check 2: required files
  const requiredFiles = inferRequiredFiles(taskPayload);
  const filesResult = await checkRequiredFiles(resolvedPath, requiredFiles);
  checks.requiredFiles = { ...filesResult, checked: requiredFiles };
  if (!filesResult.passed) {
    passed = false;
    reason = filesResult.reason;
    mitigation = `Ensure the required files exist before the lane runs: ${requiredFiles.join(', ')}`;
  }

  return { passed, reason, mitigation, checks };
}

module.exports = {
  runPreflight,
  checkRepoAccess,
  checkRequiredFiles,
  inferRequiredFiles,
  PROJECT_BASE
};
