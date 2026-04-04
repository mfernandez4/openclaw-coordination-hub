/**
 * Unit tests for MemoryBridge (src/memory-bridge.js)
 *
 * Uses a real temp directory so we exercise actual fs calls. Each describe
 * block gets its own isolated dir, removed in afterAll.
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { MemoryBridge } = require('../../src/memory-bridge');

function makeTmpBridge() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bridge-test-'));
  const bridge = new MemoryBridge({ memoryBasePath: tmpDir });
  return { bridge, tmpDir, journalPath: path.join(tmpDir, 'journal.jsonl') };
}

function appendJournalLine(journalPath, obj) {
  fs.appendFileSync(journalPath, JSON.stringify(obj) + '\n');
}

// ─── getRecentSessions ───────────────────────────────────────────────────────

describe('MemoryBridge.getRecentSessions()', () => {
  let bridge, tmpDir, journalPath;
  beforeEach(() => ({ bridge, tmpDir, journalPath } = makeTmpBridge()));
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('returns empty array when journal does not exist', async () => {
    const sessions = await bridge.getRecentSessions();
    expect(sessions).toEqual([]);
  });

  test('returns session_start events within the time window', async () => {
    const recentTs = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    appendJournalLine(journalPath, {
      event: 'session_start',
      session_id: 'sess-1',
      agent_id: 'agent-a',
      ts: recentTs,
      source: 'test'
    });

    const sessions = await bridge.getRecentSessions(1); // last 1 hour
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('sess-1');
    expect(sessions[0].agentId).toBe('agent-a');
    expect(sessions[0].type).toBe('session_start');
  });

  test('returns agent_reg events within the time window', async () => {
    const recentTs = new Date(Date.now() - 30_000).toISOString();
    appendJournalLine(journalPath, {
      event: 'agent_reg',
      trace_id: 'trace-1',
      agent_id: 'agent-b',
      ts: recentTs
    });

    const sessions = await bridge.getRecentSessions(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].type).toBe('agent_reg');
    expect(sessions[0].sessionId).toBe('trace-1');
  });

  test('excludes events outside the time window', async () => {
    const oldTs = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // 2 h ago
    appendJournalLine(journalPath, {
      event: 'session_start', session_id: 'old', agent_id: 'x', ts: oldTs
    });

    const sessions = await bridge.getRecentSessions(1); // last 1 hour only
    expect(sessions).toHaveLength(0);
  });

  test('ignores unrecognised event types', async () => {
    appendJournalLine(journalPath, {
      event: 'task_complete', session_id: 'x', agent_id: 'y', ts: new Date().toISOString()
    });

    const sessions = await bridge.getRecentSessions(1);
    expect(sessions).toHaveLength(0);
  });

  test('skips malformed JSON lines without throwing', async () => {
    fs.appendFileSync(journalPath, 'not-valid-json\n');
    appendJournalLine(journalPath, {
      event: 'session_start', session_id: 'ok', agent_id: 'z', ts: new Date().toISOString()
    });

    const sessions = await bridge.getRecentSessions(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('ok');
  });

  test('handles entry with no ts field (defaults to epoch, outside window)', async () => {
    appendJournalLine(journalPath, { event: 'session_start', session_id: 's', agent_id: 'a' });
    const sessions = await bridge.getRecentSessions(1);
    expect(sessions).toHaveLength(0);
  });

  test('accepts sessionId or agentId under alternate field names', async () => {
    appendJournalLine(journalPath, {
      event: 'session_start',
      sessionId: 'alt-sess',
      agentId: 'alt-agent',
      ts: new Date().toISOString()
    });
    const sessions = await bridge.getRecentSessions(1);
    expect(sessions[0].sessionId).toBe('alt-sess');
    expect(sessions[0].agentId).toBe('alt-agent');
  });

  test('defaults source to coordination-hub when absent', async () => {
    appendJournalLine(journalPath, {
      event: 'session_start', session_id: 's2', agent_id: 'a', ts: new Date().toISOString()
    });
    const sessions = await bridge.getRecentSessions(1);
    expect(sessions[0].source).toBe('coordination-hub');
  });
});

// ─── recordAgentEvent ────────────────────────────────────────────────────────

describe('MemoryBridge.recordAgentEvent()', () => {
  let bridge, tmpDir, journalPath;
  beforeEach(() => ({ bridge, tmpDir, journalPath } = makeTmpBridge()));
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('appends one JSON line to journal.jsonl', async () => {
    await bridge.recordAgentEvent('agent-1', 'task_complete', { result: 'ok' });
    const lines = fs.readFileSync(journalPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.agent_id).toBe('agent-1');
    expect(entry.event).toBe('task_complete');
  });

  test('journal entry contains all required fields', async () => {
    await bridge.recordAgentEvent('agent-2', 'heartbeat', {});
    const entry = JSON.parse(fs.readFileSync(journalPath, 'utf-8').trim());
    expect(typeof entry.ts).toBe('string');
    expect(typeof entry.trace_id).toBe('string');
    expect(typeof entry.block_id).toBe('string');
    expect(typeof entry.dedupe_key).toBe('string');
    expect(typeof entry.content_hash).toBe('string');
    expect(entry.source).toBe('coordination-hub');
    expect(entry.routes).toBeDefined();
    expect(entry.prioritization).toBeDefined();
    expect(entry.graph).toBeDefined();
  });

  test('returns { ts, blockId, agentId, eventType }', async () => {
    const result = await bridge.recordAgentEvent('agent-3', 'register', { cap: 'coding' });
    expect(result.agentId).toBe('agent-3');
    expect(result.eventType).toBe('register');
    expect(typeof result.ts).toBe('string');
    expect(typeof result.blockId).toBe('string');
  });

  test('stores data payload in entry', async () => {
    const data = { task: 'run-tests', status: 'pass' };
    await bridge.recordAgentEvent('agent-4', 'task_done', data);
    const entry = JSON.parse(fs.readFileSync(journalPath, 'utf-8').trim());
    expect(entry.data).toEqual(data);
  });

  test('dedupe_key is deterministic for identical data', async () => {
    const data = { x: 1 };
    await bridge.recordAgentEvent('a', 'ev', data);
    await bridge.recordAgentEvent('a', 'ev', data);
    const lines = fs.readFileSync(journalPath, 'utf-8').trim().split('\n');
    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    expect(e1.content_hash).toBe(e2.content_hash);
  });

  test('appends multiple events as separate lines', async () => {
    await bridge.recordAgentEvent('a', 'e1', {});
    await bridge.recordAgentEvent('a', 'e2', {});
    await bridge.recordAgentEvent('a', 'e3', {});
    const lines = fs.readFileSync(journalPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  test('does not throw when journal directory is unwritable (logs error)', async () => {
    // Point bridge at a path where the parent doesn't exist
    const badBridge = new MemoryBridge({
      memoryBasePath: path.join(os.tmpdir(), `nonexistent-${Date.now()}`, 'deep')
    });
    // Should resolve without throwing
    await expect(badBridge.recordAgentEvent('a', 'ev', {})).resolves.toBeDefined();
  });
});

// ─── getAgentContext ─────────────────────────────────────────────────────────

describe('MemoryBridge.getAgentContext()', () => {
  test('returns agentId, lastSeen, and capabilities', async () => {
    const { bridge, tmpDir } = makeTmpBridge();
    try {
      const ctx = await bridge.getAgentContext('agent-x');
      expect(ctx.agentId).toBe('agent-x');
      expect(typeof ctx.lastSeen).toBe('number');
      expect(Array.isArray(ctx.capabilities)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
