#!/usr/bin/env node
/**
 * hub-sprint-supervisor.js — Pending-task recovery supervisor
 *
 * Monitors a2a:pending:{agentId}:* keys for stale entries (TTL expired).
 * Expired entries indicate the worker that claimed them died before completing.
 * Re-queues by moving the task payload back to the agent's inbox.
 *
 * Usage:
 *   node scripts/hub-sprint-supervisor.js [--scan-interval <ms>] [--dry-run]
 *
 * Env:
 *   REDIS_HOST   - Redis host (default: redis)
 *   REDIS_PORT   - Redis port (default: 6379)
 */

const Redis = require('ioredis');
const HUB_PATH = process.env.HUB_PATH || '/app';
let checkAndEscalate;
try {
  ({ checkAndEscalate } = require(`${HUB_PATH}/src/escalation-publisher`));
} catch (e) {
  console.warn(`[supervisor] Could not load escalation-publisher: ${e.message}`);
}

// ── Config ────────────────────────────────────────────────────────────────────
const SCAN_INTERVAL = parseInt(process.argv.find(a => a.startsWith('--scan-interval='))?.split('=')[1] || '15000');
const DRY_RUN = process.argv.includes('--dry-run');
const AGENTS = ['sprint', 'coding', 'github-ops', 'research', 'dev-ops'];
// Two key patterns:
//   a2a:pending:{agentId}:{ts}:{rand}  — new BaseWorker (BRPOPLPUSH)
//   sprint:pending:{taskId}             — sprint worker's custom pending mechanism
const PENDING_PATTERNS = [
  'a2a:pending:*',     // new BaseWorker typed workers
  'sprint:pending:*',  // sprint worker's own pending
];

// ── Redis ─────────────────────────────────────────────────────────────────────
const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT) || 6379
});

let running = true;

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(agent, msg, data = {}) {
  const prefix = DRY_RUN ? '[DRY-RUN]' : '';
  console.log(`${prefix}[supervisor] [${agent}] ${msg}`, data);
}

/**
 * Extract agentId from a pending key: a2a:pending:{agentId}:{ts}:{rand}
 */
function parseAgentFromKey(key) {
  const parts = key.replace(PENDING_PREFIX, '').split(':');
  return parts[0] || null;
}

/**
 * Scan all pending keys, find expired ones (TTL <= 0 means already expired or missing).
 * We check TTL > 0 means it's still alive (worker is heartbeating).
 * Keys with TTL == -1 are keys with no TTL set (old format) — skip.
 * Keys with TTL > 0 are still alive — don't touch.
 * Keys that have no TTL and no expiry are stale from old runs — re-queue.
 *
 * Actually: we use Redis TTL. TTL == -2 means key doesn't exist. TTL == -1 means no expiry.
 * TTL > 0 means still alive. TTL == -1 means expired but key still exists.
 * But since we set EXPIRE after BRPOPLPUSH, the key should have TTL set.
 *
 * Recovery strategy: scan pending keys, re-queue those whose TTL <= 0 (expired or no TTL).
 * Keys without TTL (TTL == -1) that exist are stale — re-queue them.
 */
async function scanAndRecover() {
  for (const agent of AGENTS) {
    try {
      await recoverAgent(agent);
    } catch (err) {
      console.error(`[supervisor] [${agent}] Scan error: ${err.message}`);
    }
  }

  // TTL watchdog: check ledger for stalled lanes and escalate
  if (checkAndEscalate) {
    try {
      const escalated = await checkAndEscalate(redis, SCAN_INTERVAL);
      if (escalated.length > 0) {
        console.log(`[supervisor] Escalated ${escalated.length} stalled lane(s): ${escalated.join(', ')}`);
      }
    } catch (err) {
      console.error(`[supervisor] Watchdog error: ${err.message}`);
    }
  }
}

async function recoverAgent(agent) {
  // For each pattern, scan and recover stale keys
  const patterns = [
    `a2a:pending:${agent}:*`,   // new BaseWorker format
    `sprint:pending:*`,           // sprint worker's own format (agent is always 'sprint')
  ];

  // For sprint, also check the sprint-specific pending keys by taskId
  let recovered = 0;

  for (const pattern of patterns) {
    if (agent !== 'sprint' && pattern.includes('sprint:pending')) continue; // only sprint uses sprint:pending

    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      for (const key of keys) {
        const ttl = await redis.ttl(key);
        // ttl == -2: key already gone — skip
        if (ttl === -2) continue;

        const payload = await redis.get(key);
        if (!payload) {
          // Key expired between TTL check and GET — nothing to recover
          continue;
        }

        let taskData;
        try {
          taskData = JSON.parse(payload);
        } catch {
          if (!DRY_RUN) await redis.del(key);
          log(agent, `Deleted unparseable stale key: ${key}`);
          continue;
        }

        // Determine inbox key from key pattern
        let inboxKey;
        if (key.startsWith('sprint:pending:')) {
          inboxKey = 'a2a:inbox:sprint';
        } else {
          const parts = key.replace('a2a:pending:', '').split(':');
          inboxKey = `a2a:inbox:${parts[0]}`;
        }

        // Stale criteria:
        // 1. TTL == -1: key has no expiry — definitely stale (worker died before setting TTL)
        // 2. TTL > 0 but status is 'running' and lastHeartbeat is old (>2× heartbeat interval)
        const HEARTBEAT_THRESHOLD_MS = 60000; // 60s — assume stale if no heartbeat in 60s
        const isStale = ttl === -1 || (
          taskData.status === 'running' &&
          taskData.lastHeartbeat &&
          (Date.now() - new Date(taskData.lastHeartbeat).getTime()) > HEARTBEAT_THRESHOLD_MS
        );

        if (!isStale) continue; // still alive

        if (DRY_RUN) {
          log(agent, `Would re-queue stale task from ${key}: ${taskData.task || taskData.taskId || taskData.id}`, { ttl, status: taskData.status, lastHeartbeat: taskData.lastHeartbeat });
        } else {
          // For sprint: use the original task payload from taskPayload field
          // For a2a:pending: the payload IS the original task
          const requeuePayload = taskData.taskPayload || taskData;
          await redis.lpush(inboxKey, JSON.stringify(requeuePayload));
          await redis.del(key);
          log(agent, `Re-queued stale task from ${key}: ${taskData.task || taskData.taskId || taskData.id} [ttl=${ttl}, status=${taskData.status}]`, { taskId: taskData.taskId || taskData.id });
        }
        recovered++;
      }
    } while (cursor !== '0' && running);
  }

  if (recovered > 0) {
    console.log(`[supervisor] [${agent}] Recovered ${recovered} stale task(s)`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[supervisor] Starting (scan-interval=${SCAN_INTERVAL}ms, dry-run=${DRY_RUN})`);
  console.log(`[supervisor] Monitoring agents: ${AGENTS.join(', ')}`);

  // Initial scan
  await scanAndRecover();

  // Periodic scan
  const interval = setInterval(scanAndRecover, SCAN_INTERVAL);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[supervisor] Shutting down...');
    running = false;
    clearInterval(interval);
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[supervisor] Fatal:', err);
  process.exit(1);
});
