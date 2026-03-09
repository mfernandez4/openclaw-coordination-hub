#!/usr/bin/env node

/**
 * Worker Control CLI
 * Usage: node worker-ctl.js start|stop|status [agent]
 */

const { execSync } = require('child_process');
const path = require('path');

const SCRIPTS_DIR = __dirname;
const HUB_DIR = path.resolve(SCRIPTS_DIR, '..');

const agents = ['github-ops', 'coding', 'research', 'dev-ops'];

function getRedisStatus() {
  try {
    // Try to get worker status from Redis
    const { createClient } = require('redis');
    const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    
    client.on('error', () => null);
    
    // Synchronous attempt (won't work in async context)
    return null;
  } catch (e) {
    // Fallback: check via process list
    return null;
  }
}

function getRunningWorkers() {
  try {
    const ps = execSync('ps aux | grep "node workers/"', { encoding: 'utf8' });
    const workers = [];
    for (const agent of agents) {
      if (ps.includes(`node workers/${agent}.js`)) {
        workers.push(agent);
      }
    }
    return workers;
  } catch (e) {
    return [];
  }
}

function startWorkers(specificAgent = null) {
  const targetAgents = specificAgent ? [specificAgent] : agents;
  
  console.log(`Starting workers: ${targetAgents.join(', ')}`);
  
  for (const agent of targetAgents) {
    const workerPath = path.join(HUB_DIR, 'workers', `${agent}.js`);
    try {
      execSync(`node "${workerPath}" &`, { 
        cwd: HUB_DIR,
        stdio: 'detached'
      });
      console.log(`  ✓ Started ${agent}`);
    } catch (e) {
      console.error(`  ✗ Failed to start ${agent}: ${e.message}`);
    }
  }
  
  console.log('All workers started');
}

function stopWorkers() {
  console.log('Stopping all workers...');
  
  try {
    execSync('pkill -f "node workers/"', { encoding: 'utf8' });
    console.log('All workers stopped');
  } catch (e) {
    // pkill returns error if no processes found
    console.log('All workers stopped (none were running)');
  }
}

function statusWorkers(specificAgent = null) {
  const running = getRunningWorkers();
  const targetAgents = specificAgent ? [specificAgent] : agents;
  
  console.log('Worker Status:');
  console.log('---------------');
  
  for (const agent of targetAgents) {
    const isRunning = running.includes(agent);
    console.log(`  ${isRunning ? '●' : '○'} ${agent}: ${isRunning ? 'running' : 'stopped'}`);
  }
  
  console.log('');
  console.log(`Total: ${running.length}/${targetAgents.length} running`);
}

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];
const agent = args[1];

switch (command) {
  case 'start':
    startWorkers(agent);
    break;
  case 'stop':
    stopWorkers();
    break;
  case 'status':
    statusWorkers(agent);
    break;
  default:
    console.log('Usage: node worker-ctl.js start|stop|status [agent]');
    console.log('  start [agent]   - Start all workers or specific agent');
    console.log('  stop            - Stop all workers');
    console.log('  status [agent]  - Show status of all workers or specific agent');
    process.exit(1);
}
