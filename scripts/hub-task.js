#!/usr/bin/env node
/**
 * Hub Task Helper
 *
 * Enqueue tasks to the coordination hub from main session.
 * Usage: node scripts/hub-task.js --task "do something" [--agent coding] [--priority high|normal|low]
 *
 * Environment:
 *   REDIS_HOST - Redis host (default: redis)
 *   REDIS_PORT - Redis port (default: 6379)
 */

const Redis = require('ioredis');

const COORDINATION_BASE = 'coordination:tasks';
const VALID_PRIORITIES = ['high', 'normal', 'low'];

async function enqueueTask(task, agent = 'default', priority = 'normal') {
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: process.env.REDIS_PORT || 6379
  });

  const normalizedPriority = VALID_PRIORITIES.includes(priority) ? priority : 'normal';

  const taskObj = {
    id: `task:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`,
    task,
    type: agent !== 'default' ? agent : task.split(' ')[0], // best-effort type hint
    agent,
    priority: normalizedPriority,
    createdAt: new Date().toISOString(),
    status: 'pending'
  };

  // If agent specified, put directly in agent's inbox queue
  if (agent && agent !== 'default') {
    const inboxKey = `a2a:inbox:${agent}`;
    await redis.lpush(inboxKey, JSON.stringify(taskObj));
    console.log(`Enqueued to ${inboxKey}: ${taskObj.id}`);
  } else {
    // Push to the appropriate priority queue — dispatcher reads coordination:tasks:{priority}
    const queueKey = `${COORDINATION_BASE}:${normalizedPriority}`;
    await redis.lpush(queueKey, JSON.stringify(taskObj));
    console.log(`Enqueued to ${queueKey}: ${taskObj.id}`);
  }

  await redis.quit();
  return taskObj.id;
}

async function getQueueStatus() {
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: process.env.REDIS_PORT || 6379
  });

  const [high, normal, low] = await Promise.all([
    redis.llen(`${COORDINATION_BASE}:high`),
    redis.llen(`${COORDINATION_BASE}:normal`),
    redis.llen(`${COORDINATION_BASE}:low`)
  ]);

  const preview = await redis.lrange(`${COORDINATION_BASE}:normal`, 0, 4);

  await redis.quit();

  return { high, normal, low, total: high + normal + low, preview };
}

// CLI
const args = process.argv.slice(2);

if (args.includes('--status')) {
  getQueueStatus().then(s => {
    console.log(`Queue lengths — high: ${s.high}, normal: ${s.normal}, low: ${s.low} (total: ${s.total})`);
    if (s.preview.length) {
      console.log('Normal queue preview:', s.preview.map(t => JSON.parse(t).task).join(', '));
    }
    process.exit(0);
  });
} else if (args.includes('--task') || args.includes('-t')) {
  const taskIdx = args.indexOf('--task') > -1 ? args.indexOf('--task') : args.indexOf('-t');
  const task = args[taskIdx + 1];
  const agentIdx = args.indexOf('--agent');
  const agent = agentIdx > -1 ? args[agentIdx + 1] : 'default';
  const priorityIdx = args.indexOf('--priority');
  const priority = priorityIdx > -1 ? args[priorityIdx + 1] : 'normal';

  if (!task) {
    console.error('Usage: node hub-task.js --task "do something" [--agent coding] [--priority high|normal|low]');
    process.exit(1);
  }

  enqueueTask(task, agent, priority).then(id => {
    console.log(`Enqueued: ${id}`);
    process.exit(0);
  });
} else {
  console.log('Hub Task Helper');
  console.log('');
  console.log('Usage:');
  console.log('  node hub-task.js --task "do something"                 # normal priority');
  console.log('  node hub-task.js --task "do" --priority high           # high priority');
  console.log('  node hub-task.js --task "do" --agent coding            # direct to agent inbox');
  console.log('  node hub-task.js -t "do something"                     # shorthand');
  console.log('  node hub-task.js --status                              # check queue lengths');
  console.log('');
  console.log('Priorities: high | normal (default) | low');
  console.log('Agents:     coding | research | github-ops | dev-ops');
}
