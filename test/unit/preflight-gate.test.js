/**
 * Unit tests for src/preflight-gate.js
 */
const {
  runPreflight,
  checkRepoAccess,
  checkRequiredFiles,
  inferRequiredFiles,
  PROJECT_BASE
} = require('../../src/preflight-gate');

const fs = require('node:fs/promises');
const path = require('node:path');

describe('checkRepoAccess', () => {
  it('passes when directory exists', async () => {
    const result = await checkRepoAccess('/tmp');
    expect(result.passed).toBe(true);
  });

  it('fails when directory does not exist', async () => {
    const result = await checkRepoAccess('/nonexistent/path/that/does/not/exist');
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('fails when path exists but is a file', async () => {
    // Touch a temp file and test against it
    const tmpFile = `/tmp/preflight-gate-test-file-${Date.now()}`;
    await fs.writeFile(tmpFile, '');
    const result = await checkRepoAccess(tmpFile);
    await fs.rm(tmpFile).catch(() => {});
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('not a directory');
  });
});

describe('checkRequiredFiles', () => {
  const mkDir = async (name) => {
    const d = `/tmp/preflight-gate-test-${name}-${Date.now()}`;
    await fs.mkdir(d, { recursive: true });
    return d;
  };
  const cleanDir = async (d) => { await fs.rm(d, { recursive: true }).catch(() => {}); };

  it('passes when all required files exist', async () => {
    const d = await mkDir('files-ok');
    await fs.writeFile(path.join(d, 'package.json'), '{}');
    await fs.mkdir(path.join(d, 'src'));
    const result = await checkRequiredFiles(d, ['package.json', 'src']);
    expect(result.passed).toBe(true);
    await cleanDir(d);
  });

  it('passes when no required files specified', async () => {
    const d = await mkDir('empty');
    const result = await checkRequiredFiles(d, []);
    expect(result.passed).toBe(true);
    await cleanDir(d);
  });

  it('fails when some files are missing', async () => {
    const d = await mkDir('some-missing');
    await fs.writeFile(path.join(d, 'package.json'), '{}');
    const result = await checkRequiredFiles(d, ['package.json', 'README.md', 'SPEC.md']);
    expect(result.passed).toBe(false);
    expect(result.missing.sort()).toEqual(['README.md', 'SPEC.md']);
    await cleanDir(d);
  });

  it('fails when all files are missing', async () => {
    const d = await mkDir('all-missing');
    const result = await checkRequiredFiles(d, ['nonexistent1.txt', 'nonexistent2.txt']);
    expect(result.passed).toBe(false);
    expect(result.missing).toHaveLength(2);
    await cleanDir(d);
  });
});

describe('inferRequiredFiles', () => {
  it('returns src+test+package.json for coding tasks', () => {
    const codingTasks = [
      { task: 'implement feature X' },
      { task: 'fix the bug in auth' },
      { task: 'add validation' },
      { type: 'coding', objective: 'do something' }
    ];
    for (const payload of codingTasks) {
      const files = inferRequiredFiles(payload);
      expect(files).toContain('src');
      expect(files).toContain('test');
      expect(files).toContain('package.json');
    }
  });

  it('returns README.md for docs tasks', () => {
    const files = inferRequiredFiles({ task: 'write docs for the API' });
    expect(files).toContain('README.md');
  });

  it('returns package.json for review tasks', () => {
    const files = inferRequiredFiles({ task: 'review the PR' });
    expect(files).toContain('package.json');
  });

  it('returns package.json as default', () => {
    const files = inferRequiredFiles({ task: 'do something unspecified' });
    expect(files).toEqual(['package.json']);
  });
});

describe('runPreflight', () => {
  // Use per-test unique dirs so tests are fully isolated
  const mkDir = async (name) => {
    const d = `/tmp/preflight-gate-test-${name}-${Date.now()}`;
    await fs.mkdir(d, { recursive: true });
    return d;
  };
  const cleanDir = async (d) => { await fs.rm(d, { recursive: true }).catch(() => {}); };

  it('passes when repo path exists and required files are present', async () => {
    const d = await mkDir('runpreflight-ok');
    await fs.writeFile(path.join(d, 'package.json'), '{}');
    await fs.mkdir(path.join(d, 'src'));
    const result = await runPreflight({ repoPath: d });
    expect(result.passed).toBe(true);
    expect(result.checks.repoAccess.passed).toBe(true);
    expect(result.checks.requiredFiles.passed).toBe(true);
    await cleanDir(d);
  });

  it('fails when repo path does not exist', async () => {
    const result = await runPreflight({ project: 'nonexistent-project-xyz' });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('does not exist');
    expect(result.mitigation).toBeTruthy();
  });

  it('fails when required files are missing', async () => {
    const d = await mkDir('missing-files');
    await fs.writeFile(path.join(d, 'package.json'), '{}');
    // Task description triggers src+test+package.json inference; only package.json exists
    const result = await runPreflight({ repoPath: d, task: 'implement the feature' });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('missing');
    await cleanDir(d);
  });

  it('passes with explicit repoPath even without project', async () => {
    const d = await mkDir('explicit-path');
    await fs.writeFile(path.join(d, 'package.json'), '{}');
    await fs.mkdir(path.join(d, 'src'));
    const result = await runPreflight({ repoPath: d });
    expect(result.passed).toBe(true);
    await cleanDir(d);
  });

  it('fails when payload is not an object', async () => {
    const result = await runPreflight(null);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Invalid task payload');
  });

  it('fails when neither project nor repoPath is provided', async () => {
    const result = await runPreflight({ task: 'do something' });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Cannot determine repo path');
  });

  it('returns structured checks object on failure', async () => {
    const result = await runPreflight({ project: 'nonexistent-project-xyz' });
    expect(result.checks).toBeDefined();
    expect(result.checks.repoAccess.passed).toBe(false);
  });
});
