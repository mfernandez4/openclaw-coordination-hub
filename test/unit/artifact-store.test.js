/**
 * Unit tests for ArtifactStore (src/artifact-store.js)
 *
 * Uses a real temp directory so we exercise the actual fs calls without
 * touching the project tree. Each suite gets a fresh dir; it is removed
 * in afterAll.
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { ArtifactStore } = require('../../src/artifact-store');

function makeTmpStore() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-store-test-'));
  const store  = new ArtifactStore({ basePath: tmpDir });
  return { store, tmpDir };
}

// ─── constructor ─────────────────────────────────────────────────────────────

describe('ArtifactStore constructor', () => {
  let tmpDir;
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('creates basePath directory on construction', () => {
    tmpDir = path.join(os.tmpdir(), `artifact-ctor-test-${Date.now()}`);
    expect(fs.existsSync(tmpDir)).toBe(false);
    new ArtifactStore({ basePath: tmpDir });
    expect(fs.existsSync(tmpDir)).toBe(true);
  });
});

// ─── writeArtifact ───────────────────────────────────────────────────────────

describe('ArtifactStore.writeArtifact()', () => {
  let store, tmpDir;
  beforeAll(() => ({ store, tmpDir } = makeTmpStore()));
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('returns a non-empty artifactId string', () => {
    const id = store.writeArtifact('agent-1', 'out.txt', 'hello');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('artifactId starts with agentId', () => {
    const id = store.writeArtifact('research-agent', 'result.json', '{}');
    expect(id.startsWith('research-agent-')).toBe(true);
  });

  test('creates artifact directory with content file and manifest', () => {
    const id = store.writeArtifact('agent-2', 'data.txt', 'payload');
    const artifactDir = path.join(tmpDir, id);
    expect(fs.existsSync(path.join(artifactDir, 'data.txt'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'manifest.json'))).toBe(true);
  });

  test('manifest contains correct metadata fields', () => {
    const meta = { tag: 'test', version: 1 };
    const id = store.writeArtifact('agent-3', 'f.txt', 'content', meta);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, id, 'manifest.json'), 'utf-8')
    );
    expect(manifest.artifactId).toBe(id);
    expect(manifest.agentId).toBe('agent-3');
    expect(manifest.filename).toBe('f.txt');
    expect(manifest.metadata).toEqual(meta);
    expect(typeof manifest.createdAt).toBe('string');
  });

  test('writes string content verbatim', () => {
    const id = store.writeArtifact('agent-4', 'hello.txt', 'hello world');
    const content = fs.readFileSync(path.join(tmpDir, id, 'hello.txt'), 'utf-8');
    expect(content).toBe('hello world');
  });

  test('writes Buffer content correctly', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02]);
    const id  = store.writeArtifact('agent-5', 'bin.bin', buf);
    const content = fs.readFileSync(path.join(tmpDir, id, 'bin.bin'));
    expect(Buffer.compare(content, buf)).toBe(0);
  });

  test('each call returns a unique artifactId', () => {
    const ids = new Set();
    for (let i = 0; i < 5; i++) {
      ids.add(store.writeArtifact('agent-u', 'f.txt', 'x'));
    }
    expect(ids.size).toBe(5);
  });
});

// ─── readArtifact ────────────────────────────────────────────────────────────

describe('ArtifactStore.readArtifact()', () => {
  let store, tmpDir;
  beforeAll(() => ({ store, tmpDir } = makeTmpStore()));
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('returns content, manifest, and filePath for a written artifact', () => {
    const id = store.writeArtifact('reader-agent', 'report.txt', 'the report');
    const result = store.readArtifact(id);
    expect(result.content.toString()).toBe('the report');
    expect(result.manifest.artifactId).toBe(id);
    expect(result.filePath).toContain('report.txt');
  });

  test('returns a Buffer for content', () => {
    const id = store.writeArtifact('buf-agent', 'bytes.bin', Buffer.from([1, 2, 3]));
    const { content } = store.readArtifact(id);
    expect(Buffer.isBuffer(content)).toBe(true);
    expect(content[0]).toBe(1);
  });

  test('throws for a non-existent artifactId', () => {
    expect(() => store.readArtifact('does-not-exist')).toThrow(/Artifact not found/);
  });
});

// ─── listArtifacts ───────────────────────────────────────────────────────────

describe('ArtifactStore.listArtifacts()', () => {
  let store, tmpDir;
  beforeAll(() => ({ store, tmpDir } = makeTmpStore()));
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('returns empty array when store is empty', () => {
    expect(store.listArtifacts()).toEqual([]);
  });

  test('returns all artifact IDs', () => {
    const a = store.writeArtifact('x', 'f.txt', '1');
    const b = store.writeArtifact('y', 'f.txt', '2');
    const list = store.listArtifacts();
    expect(list).toContain(a);
    expect(list).toContain(b);
  });

  test('filters by agentId prefix when provided', () => {
    const { store: s, tmpDir: td } = makeTmpStore();
    try {
      const a1 = s.writeArtifact('alpha', 'f.txt', '1');
      const a2 = s.writeArtifact('alpha', 'f.txt', '2');
      s.writeArtifact('beta', 'f.txt', '3');

      const alphaOnly = s.listArtifacts('alpha');
      expect(alphaOnly).toContain(a1);
      expect(alphaOnly).toContain(a2);
      expect(alphaOnly.every(id => id.startsWith('alpha-'))).toBe(true);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  test('returns empty array when basePath does not exist', () => {
    const s = new ArtifactStore({ basePath: path.join(os.tmpdir(), `gone-${Date.now()}`) });
    // Remove the dir that the constructor just created
    fs.rmSync(s.basePath, { recursive: true, force: true });
    expect(s.listArtifacts()).toEqual([]);
  });
});

// ─── cleanup ─────────────────────────────────────────────────────────────────

describe('ArtifactStore.cleanup()', () => {
  test('removes artifacts older than maxAgeMs and returns count', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      const id = store.writeArtifact('cleaner', 'f.txt', 'old');

      // Back-date the manifest so it appears old
      const manifestPath = path.join(tmpDir, id, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.createdAt = new Date(Date.now() - 10000).toISOString(); // 10 s ago
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const removed = store.cleanup(5000); // 5 s max age
      expect(removed).toBe(1);
      expect(fs.existsSync(path.join(tmpDir, id))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('keeps artifacts newer than maxAgeMs', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      store.writeArtifact('fresh', 'f.txt', 'new');
      const removed = store.cleanup(86400000); // 24 h
      expect(removed).toBe(0);
      expect(store.listArtifacts().length).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('removes artifact with malformed manifest', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      const id = store.writeArtifact('broken', 'f.txt', 'x');
      fs.writeFileSync(path.join(tmpDir, id, 'manifest.json'), 'not-json{{{');

      const removed = store.cleanup(0);
      expect(removed).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns 0 when basePath does not exist', () => {
    const s = new ArtifactStore({ basePath: path.join(os.tmpdir(), `gone-cleanup-${Date.now()}`) });
    fs.rmSync(s.basePath, { recursive: true, force: true });
    expect(s.cleanup()).toBe(0);
  });
});
