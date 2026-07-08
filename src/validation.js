/**
 * Task Payload Validation Layer
 * 
 * Validates task payloads against per-type schemas before routing.
 * Provides structured error results for invalid payloads.
 */

// Field validators
const validators = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  boolean: (v) => typeof v === 'boolean',
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  optional: (v, schema) => v === undefined || validate(v, schema),
};

/**
 * Validate a value against a schema field definition
 */
function validate(value, field) {
  if (typeof field === 'function') {
    return field(value);
  }
  if (typeof field === 'object' && field !== null) {
    if (field.type) {
      const typeFn = validators[field.type];
      if (!typeFn) return false;
      if (!typeFn(value, field)) return false;
    }
    if (field.enum && value !== undefined && !field.enum.includes(value)) {
      return false;
    }
    if (field.min !== undefined && typeof value === 'number' && value < field.min) {
      return false;
    }
    if (field.max !== undefined && typeof value === 'number' && value > field.max) {
      return false;
    }
    if (field.pattern && typeof value === 'string' && !field.pattern.test(value)) {
      return false;
    }
    if (field.fields) {
      return validateObject(value, field.fields);
    }
  }
  return true;
}

function validateObject(obj, fields) {
  if (typeof obj !== 'object' || obj === null) return false;
  for (const [key, schema] of Object.entries(fields)) {
    if (!schema.optional && obj[key] === undefined) return false;
    if (obj[key] !== undefined && !validate(obj[key], schema)) return false;
  }
  return true;
}

/**
 * Task type schemas
 */
const TASK_SCHEMAS = {
  // Base fields required for ALL tasks
  _base: {
    type: { type: 'string', optional: true },
    id: { type: 'string', optional: true },
  },

  coding: {
    task: { type: 'string', enum: ['list-files', 'read-file', 'write-file', 'search-code', 'run-tests'] },
    context: { type: 'object', optional: true },
  },

  'github-ops': {
    task: { type: 'string', enum: ['check-pr', 'list-prs', 'check-issue', 'list-issues', 'create-branch'] },
    pr: { type: 'string', optional: true },
    number: { type: 'number', optional: true },
    branch: { type: 'string', optional: true },
  },

  research: {
    task: { type: 'string', enum: ['search', 'fetch', 'analyze'] },
    context: { type: 'object', optional: true },
  },

  'dev-ops': {
    task: { type: 'string', enum: ['deploy', 'check-status', 'get-logs'] },
    context: { type: 'object', optional: true },
  }
};

/**
 * Validate a task payload
 * Returns { valid: true } or { valid: false, error: string }
 */
function validateTask(task) {
  // Validate base required fields
  if (!task || typeof task !== 'object') {
    return { valid: false, error: 'Task must be a non-null object' };
  }

  if (typeof task.task !== 'string') {
    return { valid: false, error: 'task.task must be a string' };
  }

  // Determine schema based on task.type or infer from task name
  const taskType = task.type || inferTaskType(task.task);
  const schema = TASK_SCHEMAS[taskType];

  if (!schema) {
    // Unknown task type — allow through for now, dispatcher will dead-letter
    return { valid: true };
  }

  const fields = { ...TASK_SCHEMAS._base, ...schema };

  for (const [fieldName, fieldSchema] of Object.entries(fields)) {
    const value = task[fieldName];

    // Check required
    if (!fieldSchema.optional && value === undefined) {
      return { valid: false, error: `Missing required field: ${fieldName}` };
    }

    // Check type
    if (value !== undefined && !validate(value, fieldSchema)) {
      const expected = fieldSchema.type || (fieldSchema.enum ? `one of [${fieldSchema.enum.join(', ')}]` : 'any');
      return {
        valid: false,
        error: `Field '${fieldName}' has invalid value. Expected ${expected}, got ${JSON.stringify(value)}`
      };
    }
  }

  return { valid: true };
}

/**
 * Infer task type from task name string
 */
function inferTaskType(task) {
  if (!task || typeof task !== 'string') return null;
  if (task.startsWith('list-files') || task.startsWith('read-file') ||
      task.startsWith('write-file') || task.startsWith('search-code') ||
      task.startsWith('run-tests')) {
    return 'coding';
  }
  if (task.startsWith('check-pr') || task.startsWith('list-prs') ||
      task.startsWith('check-issue') || task.startsWith('create-branch')) {
    return 'github-ops';
  }
  if (task.startsWith('deploy') || task.startsWith('check-status') ||
      task.startsWith('get-logs')) {
    return 'dev-ops';
  }
  if (task.startsWith('search') || task.startsWith('fetch') ||
      task.startsWith('analyze')) {
    return 'research';
  }
  return null;
}

/** Commit hash pattern: 7–40 lowercase hex chars (matches git short/long hash) */
const COMMIT_HASH_RE = /^[a-f0-9]{7,40}$/;

/**
 * Validate a completion payload.
 *
 * Required on a `done` completion:
 *   - commitHash  — non-empty string, 7–40 hex chars
 *   - changedFiles — array of non-empty strings
 *   - verification — object with at least one passing key (value is truthy)
 *
 * Required on `blocked` / `invalid`:
 *   - blocker     — human-readable reason
 *
 * Optional on `blocked` / `invalid`:
 *   - mitigation  — recommended next step
 *
 * @param {object} completion
 * @returns {{ valid: boolean, error?: string }}
 */
function validateCompletion(completion) {
  if (!completion || typeof completion !== 'object') {
    return { valid: false, error: 'Completion must be a non-null object' };
  }

  const { state } = completion;

  if (state === 'done') {
    // commitHash required and must be a valid git hash
    if (!completion.commitHash) {
      return { valid: false, error: 'Missing required field: commitHash' };
    }
    if (typeof completion.commitHash !== 'string') {
      return { valid: false, error: 'Field commitHash must be a string' };
    }
    if (!COMMIT_HASH_RE.test(completion.commitHash)) {
      return {
        valid: false,
        error: `Field commitHash must be 7–40 hex chars, got '${completion.commitHash}'`
      };
    }

    // changedFiles required and non-empty array of strings
    if (!Array.isArray(completion.changedFiles)) {
      return { valid: false, error: 'Field changedFiles must be an array' };
    }
    if (completion.changedFiles.length === 0) {
      return { valid: false, error: 'Field changedFiles must be a non-empty array' };
    }
    for (const f of completion.changedFiles) {
      if (typeof f !== 'string' || f.trim().length === 0) {
        return { valid: false, error: 'Each entry in changedFiles must be a non-empty string' };
      }
    }

    // verification required — at least one passing key (truthy value)
    if (!completion.verification || typeof completion.verification !== 'object') {
      return {
        valid: false,
        error: 'Missing required field: verification (object with passing checks)'
      };
    }
    const verifKeys = Object.keys(completion.verification);
    if (verifKeys.length === 0) {
      return { valid: false, error: 'Field verification must have at least one key' };
    }
    const hasPassing = verifKeys.some(k => completion.verification[k]);
    if (!hasPassing) {
      return {
        valid: false,
        error: 'Field verification must have at least one passing check (truthy value)'
      };
    }

    return { valid: true };
  }

  if (state === 'blocked' || state === 'invalid') {
    if (!completion.blocker || typeof completion.blocker !== 'string' || completion.blocker.trim() === '') {
      return {
        valid: false,
        error: 'Field blocker is required for blocked/invalid completions and must be a non-empty string'
      };
    }
    return { valid: true };
  }

  if (!state) {
    return { valid: false, error: 'Missing required field: state' };
  }

  return {
    valid: false,
    error: `Unknown completion state '${state}'. Expected: done | blocked | invalid`
  };
}

/**
 * Build a failed task result for an invalid payload
 */
function buildValidationError(task, reason) {
  return {
    type: 'result',
    taskId: task.id || `task:${Date.now()}`,
    agent: 'dispatcher',
    task: task.task || task.type || 'unknown',
    status: 'failed',
    output: null,
    error: `Validation failed: ${reason}`,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  validateTask,
  buildValidationError,
  validateCompletion,
  TASK_SCHEMAS,
  COMMIT_HASH_RE
};
