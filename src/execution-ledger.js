/**
 * Execution Ledger — Redis-backed lane state machine
 *
 * Tracks the lifecycle of each execution lane:
 *   pending → running → done | blocked | invalid
 *
 * Each lane is stored as a Redis hash:
 *   ledger:{laneId} → { state, startedAt, updatedAt, taskId, commitHash,
 *                        changedFiles, errors, retryCount, blocker, mitigation }
 *
 * State transitions are append-only: only `state` and `updatedAt` change
 * after initial creation. All other fields are set by the transition call
 * that produces that state.
 */

const { logger } = require('./logger');
const { validateCompletion: validateCompletionSchema } = require('./validation');

const VALID_STATES = new Set(['pending', 'running', 'done', 'blocked', 'invalid']);

/** Commit hash pattern: 7–40 lowercase hex chars (matches git short/long hash) */
const COMMIT_HASH_RE = /^[a-f0-9]{7,40}$/;

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Throw if the current state does not allow the requested transition.
 */
function requireTransition(currentState, allowed) {
  if (!allowed.includes(currentState)) {
    throw new Error(
      `Invalid transition: cannot go from '${currentState}' to '${allowed.join('|')}'`
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new lane entry in `pending` state.
 *
 * @param {import('ioredis').Redis} redis
 * @param {string} laneId
 * @param {string} taskId
 * @returns {Promise<object>} the created lane record
 */
async function create(redis, laneId, taskId) {
  const key = `ledger:${laneId}`;
  const now = new Date().toISOString();
  const entry = {
    state: 'pending',
    taskId: String(taskId),
    startedAt: now,
    updatedAt: now,
    commitHash: '',
    changedFiles: '[]',
    errors: '[]',
    retryCount: '0',
    blocker: '',
    mitigation: ''
  };

  // HSET returns the number of new fields added; 0 means key already existed
  const added = await redis.hset(key, entry);
  if (added === 0) {
    // Key already exists — re-create is idempotent: overwrite with fresh pending state
    await redis.del(key);
    await redis.hset(key, entry);
  }

  logger.info('ledger', `Lane created: ${laneId}`, { laneId, taskId });
  return _parseEntry(entry);
}

/**
 * Transition a lane from `pending` → `running`.
 *
 * @param {import('ioredis').Redis} redis
 * @param {string} laneId
 * @returns {Promise<object>} updated lane record
 */
/**
 * Default lane TTL: 5 minutes from start.
 * Override via LANE_TTL_SECONDS env var.
 */
function getLaneTTL() {
  return (parseInt(process.env.LANE_TTL_SECONDS, 10) || 300) * 1000; // ms
}

async function start(redis, laneId) {
  const key = `ledger:${laneId}`;
  const raw = await redis.hget(key, 'state');
  if (raw == null) throw new Error(`Lane '${laneId}' does not exist`);
  requireTransition(raw, ['pending']);

  const now = new Date();
  const deadline = new Date(now.getTime() + getLaneTTL()).toISOString();

  await redis.hset(key,
    'state', 'running',
    'updatedAt', now.toISOString(),
    'deadline', deadline
  );
  logger.info('ledger', `Lane running: ${laneId} (deadline: ${deadline})`, { laneId, deadline });

  return get(redis, laneId);
}

/**
 * Transition a lane from `running` → `done`.
 * Requires a valid commitHash and non-empty changedFiles array.
 *
 * @param {import('ioredis').Redis} redis
 * @param {string} laneId
 * @param {{ commitHash: string, changedFiles: string[], verification?: object }} data
 * @returns {Promise<object>} updated lane record
 */
async function complete(redis, laneId, data) {
  const key = `ledger:${laneId}`;
  const raw = await redis.hget(key, 'state');
  requireTransition(raw || 'pending', ['running']);

  const { commitHash, changedFiles, verification } = data;

  // Validate format — these produce the most specific, actionable errors
  if (!commitHash || !COMMIT_HASH_RE.test(commitHash)) {
    throw new Error(
      `Invalid completion: commitHash must be 7–40 hex chars, got '${commitHash}'`
    );
  }
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    throw new Error('Invalid completion: changedFiles must be a non-empty array');
  }

  // Validate full schema (verification, state) before writing to Redis
  const completionPayload = { state: 'done', commitHash, changedFiles, verification };
  const schemaResult = validateCompletionSchema(completionPayload);
  if (!schemaResult.valid) {
    throw new Error(`Invalid completion: ${schemaResult.error}`);
  }

  const now = new Date().toISOString();
  await redis.hset(key,
    'state', 'done',
    'updatedAt', now,
    'commitHash', commitHash,
    'changedFiles', JSON.stringify(changedFiles),
    'errors', '[]'
  );

  logger.info('ledger', `Lane done: ${laneId}`, { laneId, commitHash, changedFiles });
  return get(redis, laneId);
}

/**
 * Transition a lane from `running` → `blocked`.
 * Records the blocker reason; lane must not be retried without human guidance.
 *
 * @param {import('ioredis').Redis} redis
 * @param {string} laneId
 * @param {{ reason: string, mitigation?: string }} data
 * @returns {Promise<object>} updated lane record
 */
async function block(redis, laneId, data = {}) {
  const key = `ledger:${laneId}`;
  const raw = await redis.hget(key, 'state');
  // Allow blocking from pending (preflight failed before lane even started)
  // or running (preflight/recovery failed mid-execution)
  requireTransition(raw || 'pending', ['pending', 'running']);

  const { reason = 'unknown', mitigation = '' } = data;
  const now = new Date().toISOString();
  await redis.hset(key,
    'state', 'blocked',
    'updatedAt', now,
    'blocker', reason,
    'mitigation', mitigation
  );

  logger.warn('ledger', `Lane blocked: ${laneId}`, { laneId, blocker: reason });
  return get(redis, laneId);
}

/**
 * Transition a lane from `running` → `invalid`.
 * Increments retryCount. If retryCount >= 2, marks the lane permanently invalid
 * and triggers escalation (caller should publish escalation event).
 *
 * @param {import('ioredis').Redis} redis
 * @param {string} laneId
 * @param {{ reason: string, retryCount?: number }} data
 * @returns {Promise<{ record: object, shouldEscalate: boolean }>}
 */
async function invalidate(redis, laneId, data = {}) {
  const key = `ledger:${laneId}`;
  const raw = await redis.hget(key, 'state');
  // Allow invalid → invalid re-transition for retry accumulation (two-strike pattern)
  if (raw !== 'invalid') {
    requireTransition(raw || 'pending', ['running']);
  }

  const currentRetries = parseInt(await redis.hget(key, 'retryCount') || '0', 10);
  const newRetries = currentRetries + 1;
  const shouldEscalate = newRetries >= 2;

  const errors = JSON.parse(await redis.hget(key, 'errors') || '[]');
  errors.push({ reason: data.reason || 'unknown', at: new Date().toISOString() });

  const now = new Date().toISOString();
  await redis.hset(key,
    'state', 'invalid',
    'updatedAt', now,
    'retryCount', String(newRetries),
    'errors', JSON.stringify(errors),
    'blocker', data.reason || 'unknown'
  );

  logger.warn('ledger', `Lane invalid: ${laneId} (retry ${newRetries}/2)`, {
    laneId,
    retryCount: newRetries,
    shouldEscalate
  });

  return { record: await get(redis, laneId), shouldEscalate };
}

/**
 * Get the current state of a lane.
 *
 * @param {import('ioredis').Redis} redis
 * @param {string} laneId
 * @returns {Promise<object|null>} lane record or null if not found
 */
async function get(redis, laneId) {
  const key = `ledger:${laneId}`;
  const raw = await redis.hgetall(key);

  if (!raw || Object.keys(raw).length === 0) {
    return null;
  }

  return _parseEntry(raw);
}

/**
 * Return all lanes in the ledger.
 *
 * @param {import('ioredis').Redis} redis
 * @returns {Promise<object[]>}
 */
async function allLanes(redis) {
  const keys = await redis.keys('ledger:*');
  if (!keys.length) return [];

  const pipeline = redis.pipeline();
  for (const key of keys) pipeline.hgetall(key);
  const results = await pipeline.exec();

  const lanes = [];
  for (const [err, raw] of results) {
    if (!err && raw && Object.keys(raw).length > 0) {
      lanes.push(_parseEntry(raw));
    }
  }
  return lanes;
}

/**
 * Parse a raw hash entry into a clean object.
 */
function _parseEntry(raw) {
  return {
    state:       raw.state       || 'unknown',
    taskId:      raw.taskId      || '',
    startedAt:   raw.startedAt   || '',
    updatedAt:   raw.updatedAt   || '',
    commitHash:  raw.commitHash  || '',
    changedFiles: parseChangedFiles(raw.changedFiles),
    errors:       parseErrors(raw.errors),
    retryCount:   parseInt(raw.retryCount || '0', 10),
    blocker:     raw.blocker     || '',
    mitigation:  raw.mitigation  || ''
  };
}

function parseChangedFiles(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function parseErrors(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

module.exports = {
  VALID_STATES,
  COMMIT_HASH_RE,
  create,
  start,
  complete,
  block,
  invalidate,
  get,
  allLanes
};
