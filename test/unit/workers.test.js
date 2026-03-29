/**
 * Unit tests for specialist workers: CodingWorker, ResearchWorker,
 * GitHubOpsWorker, DevOpsWorker.
 *
 * Focus: input validation and pure-logic paths that don't require
 * real subprocesses, network calls, or filesystem access.
 * execFile calls are mocked at the module level where needed.
 */
const CodingWorker   = require('../../workers/coding');
const ResearchWorker = require('../../workers/research');
const GitHubOpsWorker = require('../../workers/github-ops');
const DevOpsWorker   = require('../../workers/dev-ops');

function makeMockRedis() {
  return {
    hset:    vi.fn().mockResolvedValue(1),
    expire:  vi.fn().mockResolvedValue(1),
    set:     vi.fn().mockResolvedValue('OK'),
    hdel:    vi.fn().mockResolvedValue(1),
    del:     vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
    blpop:   vi.fn().mockResolvedValue(null),
    quit:    vi.fn().mockResolvedValue('OK'),
  };
}

function makeMockArtifacts() {
  return { writeArtifact: vi.fn(), readArtifact: vi.fn() };
}

// ─── CodingWorker ─────────────────────────────────────────────────────────────

describe('CodingWorker', () => {
  let worker;

  beforeEach(() => {
    worker = new CodingWorker('coding', {
      redis: makeMockRedis(),
      artifactStore: makeMockArtifacts()
    });
  });

  describe('searchCode() — input validation', () => {
    test('rejects pattern containing shell metacharacters', async () => {
      const result = await worker.searchCode('foo;bar', '/app');
      expect(result.error).toMatch(/forbidden shell characters/);
    });

    test('rejects pipe character in pattern', async () => {
      const result = await worker.searchCode('foo|bar', '/app');
      expect(result.error).toMatch(/forbidden shell characters/);
    });

    test('rejects backtick in pattern', async () => {
      const result = await worker.searchCode('foo`whoami`', '/app');
      expect(result.error).toMatch(/forbidden shell characters/);
    });

    test('rejects path outside allowed directories', async () => {
      const result = await worker.searchCode('pattern', '/etc');
      expect(result.error).toMatch(/not in allowed directories/);
    });

    test('rejects path traversal outside allowed root', async () => {
      const result = await worker.searchCode('pattern', '/tmp/../../etc');
      expect(result.error).toMatch(/not in allowed directories/);
    });
  });

  describe('runTests() — path validation', () => {
    test('rejects path outside allowed directories', async () => {
      const result = await worker.runTests('/etc');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not in allowed directories/);
    });
  });

  describe('processTask() — task routing', () => {
    test('returns error for unknown task type', async () => {
      const result = await worker.processTask({ task: 'unknown-op', context: {} });
      expect(result.error).toBe('Unknown task');
    });
  });
});

// ─── ResearchWorker ───────────────────────────────────────────────────────────

describe('ResearchWorker', () => {
  let worker;

  beforeEach(() => {
    worker = new ResearchWorker({
      redis: makeMockRedis(),
      artifactStore: makeMockArtifacts()
    });
  });

  describe('handleAnalyze()', () => {
    test('returns error when text is missing', async () => {
      const result = await worker.handleAnalyze({});
      expect(result.error).toBe('Missing text parameter');
    });

    test('returns word count, char count, and line count', async () => {
      const result = await worker.handleAnalyze({ text: 'hello world\nfoo bar' });
      expect(result.success).toBe(true);
      expect(result.analysis.wordCount).toBe(4);
      expect(result.analysis.charCount).toBe(19);
      expect(result.analysis.lineCount).toBe(2);
    });

    test('detects URL hints in text', async () => {
      const result = await worker.handleAnalyze({ text: 'see https://example.com for details' });
      expect(result.analysis.hints.hasUrl).toBe(true);
    });

    test('detects email hints in text', async () => {
      const result = await worker.handleAnalyze({ text: 'contact user@example.com' });
      expect(result.analysis.hints.hasEmail).toBe(true);
    });

    test('truncates textPreview at 500 chars', async () => {
      const longText = 'a'.repeat(600);
      const result = await worker.handleAnalyze({ text: longText });
      expect(result.analysis.textPreview).toHaveLength(503); // 500 + '...'
      expect(result.analysis.textPreview.endsWith('...')).toBe(true);
    });
  });

  describe('handleSearch()', () => {
    test('returns error when query is missing', async () => {
      const result = await worker.handleSearch({});
      expect(result.error).toBe('Missing query parameter');
    });

    test('returns not_configured when BRAVE_SEARCH_API_KEY is unset', async () => {
      const modulePath = require.resolve('../../workers/research');
      const savedModule = require.cache[modulePath];
      const savedEnv = process.env.BRAVE_SEARCH_API_KEY;

      delete process.env.BRAVE_SEARCH_API_KEY;
      delete require.cache[modulePath]; // bust cache so module-scoped const is re-evaluated

      try {
        const ResearchWorkerFresh = require('../../workers/research');
        const w = new ResearchWorkerFresh({
          redis: makeMockRedis(),
          artifactStore: makeMockArtifacts()
        });
        const result = await w.handleSearch({ query: 'node.js' });
        expect(result.status).toBe('not_configured');
      } finally {
        // Restore env and module cache regardless of test outcome
        if (savedEnv !== undefined) {
          process.env.BRAVE_SEARCH_API_KEY = savedEnv;
        } else {
          delete process.env.BRAVE_SEARCH_API_KEY;
        }
        if (savedModule !== undefined) {
          require.cache[modulePath] = savedModule;
        } else {
          delete require.cache[modulePath];
        }
      }
    });
  });

  describe('handleFetch()', () => {
    test('returns error when url is missing', async () => {
      const result = await worker.handleFetch({});
      expect(result.error).toBe('Missing url parameter');
    });
  });

  describe('processTask() — task routing', () => {
    test('returns error for unknown task type', async () => {
      const result = await worker.processTask({ task: 'unknown', context: {} });
      expect(result.error).toBe('Unknown task');
    });
  });
});

// ─── GitHubOpsWorker ──────────────────────────────────────────────────────────

describe('GitHubOpsWorker', () => {
  let worker;

  beforeEach(() => {
    worker = new GitHubOpsWorker({
      redis: makeMockRedis(),
      artifactStore: makeMockArtifacts()
    });
  });

  describe('processTask() — parameter validation (no exec calls)', () => {
    test('check-pr returns error when pr param is missing', async () => {
      const result = await worker.processTask({ task: 'check-pr' });
      expect(result.error).toMatch(/Missing required parameter: pr/);
    });

    test('check-issue returns error when number param is missing', async () => {
      const result = await worker.processTask({ task: 'check-issue' });
      expect(result.error).toMatch(/Missing required parameter: number/);
    });

    test('create-branch returns error when branch param is missing', async () => {
      const result = await worker.processTask({ task: 'create-branch' });
      expect(result.error).toMatch(/Missing required parameter: branch/);
    });

    test('create-branch rejects branch name with semicolon', async () => {
      const result = await worker.processTask({ task: 'create-branch', branch: 'bad;name' });
      expect(result.error).toMatch(/Invalid branch name/);
    });

    test('create-branch rejects branch name with spaces', async () => {
      const result = await worker.processTask({ task: 'create-branch', branch: 'bad name' });
      expect(result.error).toMatch(/Invalid branch name/);
    });

    test('returns error for unknown task type', async () => {
      const result = await worker.processTask({ task: 'unknown-task' });
      expect(result.error).toBe('Unknown task');
    });
  });
});

// ─── DevOpsWorker ─────────────────────────────────────────────────────────────

describe('DevOpsWorker', () => {
  let worker;

  beforeEach(() => {
    worker = new DevOpsWorker('dev-ops', {
      redis: makeMockRedis(),
      artifactStore: makeMockArtifacts()
    });
  });

  describe('handleDeploy() — path validation', () => {
    test('returns error when compose file path is missing', async () => {
      const result = await worker.handleDeploy({});
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Missing required/);
    });

    test('rejects path traversal in compose file path', async () => {
      const result = await worker.handleDeploy({ target: '../../../etc/crontab' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid compose file path/);
    });

    test('rejects non-yaml compose file extension', async () => {
      const result = await worker.handleDeploy({ target: 'compose.txt' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid compose file path/);
    });

    test('rejects path with shell-unsafe characters', async () => {
      const result = await worker.handleDeploy({ target: 'docker;compose.yml' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid compose file path/);
    });
  });

  describe('handleRestart() — parameter validation', () => {
    test('returns error when service param is missing', async () => {
      const result = await worker.handleRestart({});
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Missing required: service/);
    });
  });

  describe('processTask() — task routing', () => {
    test('returns error for unknown task type', async () => {
      const result = await worker.processTask({ task: 'unknown', context: {} });
      expect(result.error).toBe('Unknown task');
    });
  });
});
