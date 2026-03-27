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
  TASK_SCHEMAS
};
