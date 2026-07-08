/**
 * Escalation Publisher — TTL watchdog for execution lanes
 *
 * Scans all ledger entries for lanes that have exceeded their deadline
 * (started but not yet done|blocked|invalid). Marks them as invalid
 * and publishes an escalation event to the coordination channel.
 *
 * Reuse pattern: called by sprint supervisor on each scan cycle.
 * A lane is escalated at most once — once state is 'invalid', subsequent
 * watchdog cycles skip it (no re-escalation).
 */

const { logger } = require('./logger');

const ESCALATION_CHANNEL = 'a2a:escalations';

/**
 * Check all ledger lanes for stalled (expired deadline) entries.
 * Stale = deadline has passed AND state is 'pending' or 'running'.
 *
 * @param {import('ioredis').Redis} redis
 * @param {number} watchdogIntervalMs - supervisor scan interval (ms);
 *   lanes must have been stalled for at least this long to be escalated.
 *   Default: 15000 (one full supervisor scan cycle).
 * @returns {Promise<string[]>} list of escalated laneIds
 */
async function checkAndEscalate(redis, watchdogIntervalMs = 15000) {
  const escalated = [];

  try {
    const { allLanes, invalidate } = require('./execution-ledger');
    const lanes = await allLanes(redis);
    const nowMs = Date.now();

    for (const lane of lanes) {
      // Only escalate non-terminal lanes (pending/running)
      if (lane.state === 'done' || lane.state === 'blocked' || lane.state === 'invalid') {
        continue;
      }

      // deadline field: set by ledger.start() when the lane begins.
      // If missing, set a conservative 5-min deadline from now.
      if (!lane.deadline) {
        const deadline = new Date(nowMs + 300_000).toISOString();
        await redis.hset(`ledger:${lane.taskId}`, 'deadline', deadline).catch(() => {});
        continue;
      }

      const deadlineMs = new Date(lane.deadline).getTime();
      const graceMs = watchdogIntervalMs;

      if (nowMs > deadlineMs + graceMs) {
        const overdueSec = Math.round((nowMs - deadlineMs) / 1000);
        const reason = `Lane stalled: deadline ${lane.deadline} exceeded by ${overdueSec}s (state=${lane.state})`;

        // Mark as invalid (idempotent — safe to call multiple times)
        const ledgerKey = `ledger:${lane.taskId}`;
        const currentState = await redis.hget(ledgerKey, 'state');

        // Skip if already terminal
        if (currentState === 'done' || currentState === 'blocked') {
          continue;
        }

        // Skip re-escalation: if already invalid with [ESCALATED] in blocker, skip
        if (currentState === 'invalid') {
          const blocker = await redis.hget(ledgerKey, 'blocker');
          if (blocker && blocker.includes('[ESCALATED]')) continue;
        }

        try {
          await invalidate(redis, lane.taskId, { reason: `${reason} [ESCALATED]` });

          const event = {
            type: 'escalation',
            laneId: lane.taskId,
            taskId: lane.taskId,
            agent: 'watchdog',
            reason,
            stateBefore: currentState,
            stateAfter: 'invalid',
            retryCount: lane.retryCount,
            deadline: lane.deadline,
            timestamp: new Date().toISOString()
          };

          await redis.publish(ESCALATION_CHANNEL, JSON.stringify(event));
          logger.warn('escalation', `Escalated lane ${lane.taskId}: ${reason}`, {
            laneId: lane.taskId,
            reason
          });

          escalated.push(lane.taskId);
        } catch (err) {
          logger.warn('escalation', `Failed to escalate lane ${lane.taskId}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    logger.warn('escalation', `Watchdog check failed: ${err.message}`);
  }

  return escalated;
}

module.exports = { checkAndEscalate };
