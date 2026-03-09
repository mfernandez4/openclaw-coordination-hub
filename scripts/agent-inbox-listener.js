#!/usr/bin/env node
/**
 * Agent Inbox Listener
 * Subscribes to a2a:inbox:{agentId} and processes handoffs
 */

const Redis = require('ioredis');

const AGENT_ID = process.argv[2] || 'test-agent';
const INBOX_CHANNEL = `a2a:inbox:${AGENT_ID}`;

console.log(`[${AGENT_ID}] Starting inbox listener on ${INBOX_CHANNEL}...`);

const subscriber = new Redis({ host: 'redis', port: 6379 });
subscriber.subscribe(INBOX_CHANNEL);

subscriber.on('message', (channel, msg) => {
  console.log(`[${AGENT_ID}] Received:`, msg);
  
  try {
    const payload = JSON.parse(msg);
    
    if (payload.type === 'handoff') {
      console.log(`[${AGENT_ID}] Processing handoff: ${payload.task}`);
      
      // Simulate work
      const result = {
        type: 'result',
        agent: AGENT_ID,
        task: payload.task,
        status: 'completed',
        output: `Executed: ${payload.task} (context: ${JSON.stringify(payload.context || {})})`,
        timestamp: new Date().toISOString()
      };
      
      console.log(`[${AGENT_ID}] Result:`, JSON.stringify(result));
      
      // Ack back via coordination channel
      const redis = new Redis({ host: 'redis', port: 6379 });
      redis.publish('a2a:coordination', JSON.stringify({
        ...result,
        originalHandoff: payload
      })).then(() => {
        console.log(`[${AGENT_ID}] Ack published to a2a:coordination`);
        redis.quit();
      });
    }
  } catch (e) {
    console.error(`[${AGENT_ID}] Error:`, e.message);
  }
});

console.log(`[${AGENT_ID}] Listening for messages...`);

// Exit after 30 seconds if no message
setTimeout(() => {
  console.log(`[${AGENT_ID}] Timeout - exiting`);
  subscriber.unsubscribe(INBOX_CHANNEL).then(() => {
    subscriber.quit();
    process.exit(0);
  });
}, 30000);
