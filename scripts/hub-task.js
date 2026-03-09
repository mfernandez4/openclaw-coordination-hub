#!/usr/bin/env node
/**
 * Hub Task Helper
 * 
 * Enqueue tasks to the coordination hub from main session.
 * Usage: node scripts/hub-task.js --task "do something" --agent default
 * 
 * Environment:
 *   REDIS_HOST - Redis host (default: redis)
 *   REDIS_PORT - Redis port (default: 6379)
 */

const Redis = require('ioredis');

const QUEUE_NAME = 'coordination:tasks';

async function enqueueTask(task, agent = 'default', priority = 0) {
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: process.env.REDIS_PORT || 6379
  });

  const taskObj = {
    id: `task:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`,
    task,
    agent,
    priority,
    createdAt: new Date().toISOString(),
    status: 'pending'
  };

  // If agent specified, put in agent inbox, otherwise use general queue
  if (agent && agent !== 'default') {
    const inboxKey = `a2a:inbox:${agent}`;
    await redis.rpush(inboxKey, JSON.stringify(taskObj));
    console.log(`Enqueued to ${inboxKey}: ${taskObj.id}`);
  } else {
    // Higher priority = LPUSH (front), lower = RPUSH (back)
    if (priority > 0) {
      await redis.lpush(QUEUE_NAME, JSON.stringify(taskObj));
    } else {
      await redis.rpush(QUEUE_NAME, JSON.stringify(taskObj));
    }
  }

  await redis.quit();
  return taskObj.id;
}

async function getQueueStatus() {
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: process.env.REDIS_PORT || 6379
  });

  const len = await redis.llen(QUEUE_NAME);
  const tasks = await redis.lrange(QUEUE_NAME, 0, 4);
  
  await redis.quit();
  
  return { length: len, preview: tasks };
}

// CLI
const args = process.argv.slice(2);
if (args.includes('--status')) {
  getQueueStatus().then(s => {
    console.log(`Queue length: ${s.length}`);
    console.log('Preview:', s.preview.map(t => JSON.parse(t).task).join(', '));
    process.exit(0);
  });
} else if (args.includes('--task')) {
  const taskIdx = args.indexOf('--task');
  const task = args[taskIdx + 1];
  const agentIdx = args.indexOf('--agent');
  const agent = agentIdx > -1 ? args[agentIdx + 1] : 'default';
  
  if (!task) {
    console.error('Usage: node hub-task.js --task "do something" [--agent default]');
    process.exit(1);
  }
  
  enqueueTask(task, agent).then(id => {
    console.log(`Enqueued: ${id}`);
    process.exit(0);
  });
} else {
  console.log('Hub Task Helper');
  console.log('');
  console.log('Usage:');
  console.log('  node hub-task.js --task "do something"     # Enqueue task');
  console.log('  node hub-task.js --task "do" --agent dev   # Enqueue to specific agent');
  console.log('  node hub-task.js --status                  # Check queue status');
  console.log('');
  console.log('Shortcuts:');
  console.log('  node hub-task.js -t "do something"         # Same as --task');
}
