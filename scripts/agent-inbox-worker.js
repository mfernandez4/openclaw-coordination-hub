#!/usr/bin/env node
/**
 * Agent Inbox Worker (list-based, persisted)
 * Polls a2a:inbox:{agentId} list for tasks
 */

const Redis = require('ioredis');

const AGENT_ID = process.argv[2] || 'test-agent';
const INBOX_KEY = `a2a:inbox:${AGENT_ID}`;

console.log(`[${AGENT_ID}] Starting inbox worker...`);

async function processTask() {
  const redis = new Redis({ host: 'redis', port: 6379 });
  
  // Block-pop from inbox (like BLPOP but with timeout)
  const result = await redis.blpop(INBOX_KEY, 5);
  
  if (!result) {
    console.log(`[${AGENT_ID}] No tasks, exiting`);
    await redis.quit();
    return;
  }
  
  const [key, msg] = result;
  console.log(`[${AGENT_ID}] Received:`, msg);
  
  const payload = JSON.parse(msg);
  
  if (payload.type === 'handoff') {
    console.log(`[${AGENT_ID}] Processing: ${payload.task}`);
    
    // Simulate work
    const output = `Executed: ${payload.task} (context: ${JSON.stringify(payload.context || {})})`;
    
    console.log(`[${AGENT_ID}] Result: ${output}`);
    console.log(`[${AGENT_ID}] Task complete`);
  }
  
  await redis.quit();
}

processTask().catch(e => {
  console.error(`[${AGENT_ID}] Error:`, e.message);
  process.exit(1);
});
