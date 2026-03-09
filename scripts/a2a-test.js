/**
 * A2A Handoff Test
 * 
 * Tests directed message passing between agents.
 * Run: node scripts/a2a-test.js
 */
const { RedisPubSub } = require('../src/redis-pubsub');
const { A2AAdapter } = require('../src/a2a-adapter');

async function testHandoff() {
  console.log('=== A2A Directed Handoff Test ===\n');
  
  // Create two agents
  const agentA = new A2AAdapter({ agentId: 'design-agent' });
  const agentB = new A2AAdapter({ agentId: 'coding-agent' });
  
  const pubsub = new RedisPubSub();
  await pubsub.connect();
  console.log('Redis connected\n');
  
  await agentA.initialize(pubsub);
  await agentB.initialize(pubsub);
  
  // Override handlers to capture messages
  let receivedByB = false;
  let receivedAck = false;
  
  agentB.handleTask = (from, to, payload) => {
    console.log(`[coding-agent] Received handoff from ${from}:`, payload.task);
    receivedByB = true;
    
    // Send ack back
    agentB.sendTo(from, 'ack', { originalTask: payload.task, status: 'received' });
  };
  
  agentA.handleAck = (from, to, payload) => {
    console.log(`[design-agent] Got ack from ${from}:`, payload.status);
    receivedAck = true;
  };
  
  // Wait for subscriptions
  await new Promise(r => setTimeout(r, 1000));
  
  // Design agent hands off to coding agent
  console.log('[design-agent] Handing off spec to coding-agent...\n');
  await agentA.handoffTo('coding-agent', 'Implement user authentication module', {
    spec: 'OAuth2 with JWT',
    priority: 5
  });
  
  // Wait for processing
  await new Promise(r => setTimeout(r, 2000));
  
  // Test coordination channel
  console.log('\n[design-agent] Sending coordination message...');
  await agentA.coordinate('resource-lock', { resource: 'database', requestedBy: 'design-agent' });
  
  await new Promise(r => setTimeout(r, 1000));
  
  // Results
  console.log('\n=== Results ===');
  console.log(`Directed handoff: ${receivedByB ? 'PASS' : 'FAIL'}`);
  console.log(`Ack received: ${receivedAck ? 'PASS' : 'FAIL'}`);
  
  const statusA = agentA.getStatus();
  const statusB = agentB.getStatus();
  console.log(`\nAgent A status:`, statusA);
  console.log(`Agent B status:`, statusB);
  
  await pubsub.disconnect();
  
  process.exit(receivedByB ? 0 : 1);
}

testHandoff().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
