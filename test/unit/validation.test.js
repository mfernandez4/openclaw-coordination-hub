/**
 * Unit tests for src/validation.js
 *
 * Pure-function module — no mocks needed.
 */
const { validateTask, buildValidationError, TASK_SCHEMAS } = require('../../src/validation');

// ─── validateTask ────────────────────────────────────────────────────────────

describe('validateTask', () => {
  describe('base checks', () => {
    test('rejects null', () => {
      const r = validateTask(null);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/non-null object/);
    });

    test('rejects a string', () => {
      expect(validateTask('oops').valid).toBe(false);
    });

    test('rejects task without task field', () => {
      const r = validateTask({ type: 'coding' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/task\.task must be a string/);
    });

    test('rejects task with numeric task field', () => {
      expect(validateTask({ task: 42 }).valid).toBe(false);
    });
  });

  describe('unknown task type passes through', () => {
    test('unknown type is allowed (dispatcher will dead-letter)', () => {
      const r = validateTask({ task: 'completely-unknown' });
      expect(r.valid).toBe(true);
    });
  });

  describe('coding tasks', () => {
    test('accepts valid coding task with explicit type', () => {
      const r = validateTask({ task: 'list-files', type: 'coding' });
      expect(r.valid).toBe(true);
    });

    test('infers coding type from task name', () => {
      expect(validateTask({ task: 'read-file' }).valid).toBe(true);
      expect(validateTask({ task: 'write-file' }).valid).toBe(true);
      expect(validateTask({ task: 'search-code' }).valid).toBe(true);
      expect(validateTask({ task: 'run-tests' }).valid).toBe(true);
    });

    test('rejects invalid task value for coding type', () => {
      const r = validateTask({ task: 'bad-task', type: 'coding' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/task/);
    });

    test('accepts optional context field', () => {
      const r = validateTask({ task: 'list-files', type: 'coding', context: { path: '/' } });
      expect(r.valid).toBe(true);
    });

    test('rejects non-object context', () => {
      const r = validateTask({ task: 'list-files', type: 'coding', context: 'bad' });
      expect(r.valid).toBe(false);
    });
  });

  describe('github-ops tasks', () => {
    test('accepts valid github-ops task', () => {
      expect(validateTask({ task: 'check-pr', type: 'github-ops' }).valid).toBe(true);
      expect(validateTask({ task: 'list-prs', type: 'github-ops' }).valid).toBe(true);
      expect(validateTask({ task: 'check-issue', type: 'github-ops' }).valid).toBe(true);
      expect(validateTask({ task: 'list-issues', type: 'github-ops' }).valid).toBe(true);
      expect(validateTask({ task: 'create-branch', type: 'github-ops' }).valid).toBe(true);
    });

    test('infers github-ops type from task name', () => {
      expect(validateTask({ task: 'check-pr' }).valid).toBe(true);
      expect(validateTask({ task: 'list-prs' }).valid).toBe(true);
      expect(validateTask({ task: 'create-branch' }).valid).toBe(true);
    });

    test('accepts optional number field as number', () => {
      const r = validateTask({ task: 'check-pr', type: 'github-ops', number: 42 });
      expect(r.valid).toBe(true);
    });

    test('rejects number field that is a string', () => {
      const r = validateTask({ task: 'check-pr', type: 'github-ops', number: '42' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/number/);
    });

    test('rejects invalid task value', () => {
      const r = validateTask({ task: 'merge-pr', type: 'github-ops' });
      expect(r.valid).toBe(false);
    });
  });

  describe('research tasks', () => {
    test('accepts valid research tasks', () => {
      expect(validateTask({ task: 'search', type: 'research' }).valid).toBe(true);
      expect(validateTask({ task: 'fetch', type: 'research' }).valid).toBe(true);
      expect(validateTask({ task: 'analyze', type: 'research' }).valid).toBe(true);
    });

    test('infers research type from task name', () => {
      expect(validateTask({ task: 'search' }).valid).toBe(true);
      expect(validateTask({ task: 'fetch' }).valid).toBe(true);
      expect(validateTask({ task: 'analyze' }).valid).toBe(true);
    });

    test('rejects invalid task value', () => {
      expect(validateTask({ task: 'summarize', type: 'research' }).valid).toBe(false);
    });
  });

  describe('dev-ops tasks', () => {
    test('accepts valid dev-ops tasks', () => {
      expect(validateTask({ task: 'deploy', type: 'dev-ops' }).valid).toBe(true);
      expect(validateTask({ task: 'check-status', type: 'dev-ops' }).valid).toBe(true);
      expect(validateTask({ task: 'get-logs', type: 'dev-ops' }).valid).toBe(true);
    });

    test('infers dev-ops type from task name', () => {
      expect(validateTask({ task: 'deploy' }).valid).toBe(true);
      expect(validateTask({ task: 'check-status' }).valid).toBe(true);
      expect(validateTask({ task: 'get-logs' }).valid).toBe(true);
    });

    test('rejects invalid task value', () => {
      expect(validateTask({ task: 'restart', type: 'dev-ops' }).valid).toBe(false);
    });
  });

  describe('optional id and type fields', () => {
    test('accepts id as string when provided', () => {
      const r = validateTask({ task: 'search', type: 'research', id: 'task-123' });
      expect(r.valid).toBe(true);
    });

    test('rejects id as non-string', () => {
      const r = validateTask({ task: 'search', type: 'research', id: 99 });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/id/);
    });

    test('works without id field', () => {
      expect(validateTask({ task: 'deploy', type: 'dev-ops' }).valid).toBe(true);
    });
  });
});

// ─── buildValidationError ────────────────────────────────────────────────────

describe('buildValidationError', () => {
  test('returns a result envelope with status failed', () => {
    const result = buildValidationError({ task: 'read-file', id: 'task-1' }, 'missing field');
    expect(result.status).toBe('failed');
    expect(result.agent).toBe('dispatcher');
    expect(result.error).toMatch(/Validation failed: missing field/);
    expect(result.taskId).toBe('task-1');
    expect(result.task).toBe('read-file');
    expect(result.type).toBe('result');
    expect(result.output).toBeNull();
    expect(typeof result.timestamp).toBe('string');
  });

  test('falls back to task.type when task.task is absent', () => {
    const result = buildValidationError({ type: 'coding' }, 'oops');
    expect(result.task).toBe('coding');
  });

  test('falls back to "unknown" when neither task nor type present', () => {
    const result = buildValidationError({}, 'oops');
    expect(result.task).toBe('unknown');
  });

  test('generates a synthetic taskId when id is absent', () => {
    const result = buildValidationError({ task: 'search' }, 'oops');
    expect(result.taskId).toMatch(/^task:/);
  });
});

// ─── TASK_SCHEMAS export ─────────────────────────────────────────────────────

describe('TASK_SCHEMAS', () => {
  test('exports schemas for all four task types', () => {
    expect(TASK_SCHEMAS).toHaveProperty('coding');
    expect(TASK_SCHEMAS).toHaveProperty('github-ops');
    expect(TASK_SCHEMAS).toHaveProperty('research');
    expect(TASK_SCHEMAS).toHaveProperty('dev-ops');
  });
});
