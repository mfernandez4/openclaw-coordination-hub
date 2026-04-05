/**
 * Unit tests for SharedStore (src/shared-store.js)
 *
 * Uses a real temp directory — same pattern as artifact-store.test.js —
 * so the fs layer is exercised without mocking.
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { SharedStore } = require('../../src/shared-store');

function makeTmpStore(redis = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-store-test-'));
  const store = new SharedStore({ basePath: tmpDir, redis });
  return { store, tmpDir };
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ─── writeArtifact — inherited behaviour still works ─────────────────────────

describe('SharedStore.writeArtifact() — inherited', () => {
  test('returns a non-empty artifactId and creates manifest', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      const id = store.writeArtifact('worker-a', 'out.txt', 'hello');
      expect(id).toBeTruthy();
      const manifestPath = path.join(tmpDir, id, 'manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);
    } finally { cleanup(tmpDir); }
  });

  test('readArtifact returns correct content and manifest', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      const id = store.writeArtifact('worker-a', 'data.json', '{"x":1}', { taskId: 'T1' });
      const { content, manifest } = store.readArtifact(id);
      expect(content.toString()).toBe('{"x":1}');
      expect(manifest.metadata.taskId).toBe('T1');
    } finally { cleanup(tmpDir); }
  });
});

// ─── Redis pub/sub notification ───────────────────────────────────────────────

describe('SharedStore.writeArtifact() — artifact_ready notification', () => {
  test('publishes to a2a:agents when redis is injected', () => {
    const mockRedis = { publish: vi.fn().mockResolvedValue(1) };
    const { store, tmpDir } = makeTmpStore(mockRedis);
    try {
      store.writeArtifact('worker-a', 'file.txt', 'content', { tags: ['coding'] });

      expect(mockRedis.publish).toHaveBeenCalledOnce();
      const [channel, raw] = mockRedis.publish.mock.calls[0];
      expect(channel).toBe('a2a:agents');
      const msg = JSON.parse(raw);
      expect(msg.type).toBe('artifact_ready');
      expect(msg.agentId).toBe('worker-a');
      expect(msg.filename).toBe('file.txt');
      expect(msg.tags).toEqual(['coding']);
      expect(typeof msg.artifactId).toBe('string');
      expect(typeof msg.timestamp).toBe('string');
    } finally { cleanup(tmpDir); }
  });

  test('publish includes taskId from metadata', () => {
    const mockRedis = { publish: vi.fn().mockResolvedValue(1) };
    const { store, tmpDir } = makeTmpStore(mockRedis);
    try {
      store.writeArtifact('worker-b', 'r.json', '{}', { taskId: 'task-99' });
      const [, raw] = mockRedis.publish.mock.calls[0];
      const msg = JSON.parse(raw);
      expect(msg.taskId).toBe('task-99');
    } finally { cleanup(tmpDir); }
  });

  test('publish sets tags to [] when metadata has no tags', () => {
    const mockRedis = { publish: vi.fn().mockResolvedValue(1) };
    const { store, tmpDir } = makeTmpStore(mockRedis);
    try {
      store.writeArtifact('worker-c', 'x.txt', 'hi', {});
      const [, raw] = mockRedis.publish.mock.calls[0];
      expect(JSON.parse(raw).tags).toEqual([]);
    } finally { cleanup(tmpDir); }
  });

  test('publish normalizes non-array tags to [] in the notification payload', () => {
    // Regression: metadata.tags || [] passes through truthy non-arrays (e.g. a string).
    // The artifact_ready payload must always carry tags as string[].
    const mockRedis = { publish: vi.fn().mockResolvedValue(1) };
    const { store, tmpDir } = makeTmpStore(mockRedis);
    try {
      store.writeArtifact('worker-a', 'f.txt', 'x', { tags: 'coding' });
      const [, raw] = mockRedis.publish.mock.calls[0];
      expect(JSON.parse(raw).tags).toEqual([]);
    } finally { cleanup(tmpDir); }
  });

  test('does NOT publish when redis is null', () => {
    const { store, tmpDir } = makeTmpStore(null);
    try {
      // Should not throw — just skips notification
      expect(() => store.writeArtifact('worker-a', 'f.txt', 'x')).not.toThrow();
    } finally { cleanup(tmpDir); }
  });

  test('publish failure does not throw or fail the write (async rejection)', async () => {
    const mockRedis = { publish: vi.fn().mockRejectedValue(new Error('Redis gone')) };
    const { store, tmpDir } = makeTmpStore(mockRedis);
    try {
      let id;
      expect(() => { id = store.writeArtifact('worker-a', 'f.txt', 'x'); }).not.toThrow();
      expect(id).toBeTruthy();
      // Let the rejected promise flush — must not cause unhandled rejection
      await Promise.resolve();
    } finally { cleanup(tmpDir); }
  });

  test('publish failure does not throw or fail the write (sync throw)', () => {
    // Guards against a Redis client whose publish() throws synchronously
    // (callback-based clients, or a client that returns a non-Promise value).
    const mockRedis = { publish: vi.fn(() => { throw new Error('sync boom'); }) };
    const { store, tmpDir } = makeTmpStore(mockRedis);
    try {
      let id;
      expect(() => { id = store.writeArtifact('worker-a', 'f.txt', 'x'); }).not.toThrow();
      expect(id).toBeTruthy();
    } finally { cleanup(tmpDir); }
  });

  test('publish is called once per write', () => {
    const mockRedis = { publish: vi.fn().mockResolvedValue(1) };
    const { store, tmpDir } = makeTmpStore(mockRedis);
    try {
      store.writeArtifact('a', '1.txt', 'x');
      store.writeArtifact('b', '2.txt', 'y');
      store.writeArtifact('c', '3.txt', 'z');
      expect(mockRedis.publish).toHaveBeenCalledTimes(3);
    } finally { cleanup(tmpDir); }
  });
});

// ─── find() ──────────────────────────────────────────────────────────────────

describe('SharedStore.find()', () => {
  test('empty query returns all artifacts', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      store.writeArtifact('a', 'f1.txt', 'x', {});
      store.writeArtifact('b', 'f2.txt', 'y', {});
      const results = store.find({});
      expect(results).toHaveLength(2);
    } finally { cleanup(tmpDir); }
  });

  test('find by agentId returns only that agent\'s artifacts', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      store.writeArtifact('agent-1', 'a.txt', 'x');
      store.writeArtifact('agent-1', 'b.txt', 'y');
      store.writeArtifact('agent-2', 'c.txt', 'z');
      const results = store.find({ agentId: 'agent-1' });
      expect(results).toHaveLength(2);
      expect(results.every(m => m.agentId === 'agent-1')).toBe(true);
    } finally { cleanup(tmpDir); }
  });

  test('find by single tag', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      store.writeArtifact('a', 'f.txt', 'x', { tags: ['coding', 'output'] });
      store.writeArtifact('b', 'g.txt', 'y', { tags: ['research'] });
      const results = store.find({ tags: ['coding'] });
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe('a');
    } finally { cleanup(tmpDir); }
  });

  test('find by multiple tags requires all to be present', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      store.writeArtifact('a', 'f.txt', 'x', { tags: ['coding', 'output'] });
      store.writeArtifact('b', 'g.txt', 'y', { tags: ['coding'] });
      // both have 'coding', only first has 'output'
      expect(store.find({ tags: ['coding', 'output'] })).toHaveLength(1);
      expect(store.find({ tags: ['coding'] })).toHaveLength(2);
    } finally { cleanup(tmpDir); }
  });

  test('find by taskId', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      store.writeArtifact('a', 'f.txt', 'x', { taskId: 'task-1' });
      store.writeArtifact('b', 'g.txt', 'y', { taskId: 'task-2' });
      const results = store.find({ taskId: 'task-1' });
      expect(results).toHaveLength(1);
      expect(results[0].metadata.taskId).toBe('task-1');
    } finally { cleanup(tmpDir); }
  });

  test('find by type', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      store.writeArtifact('a', 'f.txt', 'x', { type: 'patch' });
      store.writeArtifact('b', 'g.txt', 'y', { type: 'report' });
      expect(store.find({ type: 'patch' })).toHaveLength(1);
      expect(store.find({ type: 'report' })).toHaveLength(1);
    } finally { cleanup(tmpDir); }
  });

  test('find by filename', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      store.writeArtifact('a', 'output.json', 'x');
      store.writeArtifact('b', 'output.json', 'y');
      store.writeArtifact('c', 'other.txt', 'z');
      const results = store.find({ filename: 'output.json' });
      expect(results).toHaveLength(2);
    } finally { cleanup(tmpDir); }
  });

  test('find combining agentId + tag + taskId', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      store.writeArtifact('worker-a', 'f.txt', 'x', { tags: ['coding'], taskId: 'T1' });
      store.writeArtifact('worker-a', 'g.txt', 'y', { tags: ['coding'], taskId: 'T2' });
      store.writeArtifact('worker-b', 'h.txt', 'z', { tags: ['coding'], taskId: 'T1' });
      const results = store.find({ agentId: 'worker-a', tags: ['coding'], taskId: 'T1' });
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe('worker-a');
      expect(results[0].metadata.taskId).toBe('T1');
    } finally { cleanup(tmpDir); }
  });

  test('find returns empty array when no artifacts match', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      store.writeArtifact('a', 'f.txt', 'x', { tags: ['coding'] });
      expect(store.find({ tags: ['research'] })).toEqual([]);
    } finally { cleanup(tmpDir); }
  });

  test('find returns empty array on empty store', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      expect(store.find({})).toEqual([]);
    } finally { cleanup(tmpDir); }
  });

  test('find silently skips artifacts with unreadable manifests', () => {
    const { store, tmpDir } = makeTmpStore();
    try {
      const id = store.writeArtifact('a', 'f.txt', 'x');
      // Corrupt the manifest
      fs.writeFileSync(path.join(tmpDir, id, 'manifest.json'), 'not-json{{{');
      // Should not throw — just skips the bad entry
      expect(() => store.find({})).not.toThrow();
      expect(store.find({})).toEqual([]);
    } finally { cleanup(tmpDir); }
  });

  test('find({ agentId }) does not return artifacts from agents whose ID shares a prefix', () => {
    // Regression: listArtifacts('agent') prefix-matches 'agent-1-...' artifact IDs.
    // matchesQuery must re-check manifest.agentId for exact equality.
    const { store, tmpDir } = makeTmpStore();
    try {
      store.writeArtifact('agent', 'a.txt', 'x');
      store.writeArtifact('agent-1', 'b.txt', 'y');
      const results = store.find({ agentId: 'agent' });
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe('agent');
    } finally { cleanup(tmpDir); }
  });

  test('find({ tags: <string> }) returns empty array without throwing', () => {
    // Regression: passing a string instead of string[] must not crash via .every().
    const { store, tmpDir } = makeTmpStore();
    try {
      store.writeArtifact('a', 'f.txt', 'x', { tags: ['coding'] });
      expect(() => store.find({ tags: 'coding' })).not.toThrow();
      expect(store.find({ tags: 'coding' })).toEqual([]);
    } finally { cleanup(tmpDir); }
  });
});
