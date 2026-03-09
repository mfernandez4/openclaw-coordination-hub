#!/usr/bin/env node
/**
 * Coordination Listener
 * Subscribes to a2a:coordination channel and forwards results to main session
 * 
 * This runs as a background process, listening for worker results
 * and sending them to the user via the message tool.
 */

const Redis = require('ioredis');

const COORDINATION_CHANNEL = 'a2a:coordination';
const RESULTS_CHANNEL = 'a2a:results';

console.log('[coordination-listener] Starting...');

const subscriber = new Redis({ 
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379 
});

subscriber.subscribe(COORDINATION_CHANNEL);
subscriber.subscribe(RESULTS_CHANNEL);

console.log(`[coordination-listener] Listening on ${COORDINATION_CHANNEL} and ${RESULTS_CHANNEL}`);

subscriber.on('message', (channel, msg) => {
  try {
    const payload = JSON.parse(msg);
    
    console.log(`[coordination-listener] Received from ${channel}:`, JSON.stringify(payload, null, 2));
    
    // Format result for display
    if (payload.type === 'result') {
      const resultText = formatWorkerResult(payload);
      console.log('---');
      console.log(resultText);
      console.log('---');
    }
  } catch (e) {
    console.error('[coordination-listener] Parse error:', e.message);
  }
});

function formatWorkerResult(payload) {
  const { agent, task, status, output, error, durationMs, timestamp } = payload;
  
  let lines = [];
  lines.push(`🤖 **${agent}** completed: "${task}"`);
  lines.push(`   Status: ${status === 'completed' ? '✅' : '❌'} ${status}`);
  
  if (error) {
    lines.push(`   Error: ${error}`);
  } else if (output) {
    // Pretty print output
    if (typeof output === 'object') {
      lines.push(`   Output: ${JSON.stringify(output, null, 2)}`);
    } else {
      lines.push(`   Output: ${output}`);
    }
  }
  
  if (durationMs) {
    lines.push(`   Duration: ${durationMs}ms`);
  }
  
  return lines.join('\n');
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('[coordination-listener] Shutting down...');
  subscriber.unsubscribe().then(() => subscriber.quit());
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[coordination-listener] Shutting down...');
  subscriber.unsubscribe().then(() => subscriber.quit());
  process.exit(0);
});

console.log('[coordination-listener] Ready');
