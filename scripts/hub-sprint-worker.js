#!/usr/bin/env node
/**
 * hub-sprint-worker.js — Sprint task worker for the coordination hub
 *
 * Extends BaseWorker: registers with hub, uses typed inbox a2a:inbox:sprint,
 * publishes results to a2a:coordination (Path 2: full hub dispatcher integration).
 *
 * Task execution: spawns OpenClaw sub-agents via sessions API, or gh/git commands.
 *
 * Usage:
 *   node hub-sprint-worker.js [--heartbeat-interval <ms>]
 *
 * Environment:
 *   REDIS_HOST              - Redis host (default: redis)
 *   REDIS_PORT              - Redis port (default: 6379)
 *   OPENCLAW_GATEWAY_URL    - OpenClaw gateway URL (default: http://localhost:18789)
 *   OPENCLAW_GATEWAY_TOKEN  - OpenClaw gateway token (optional)
 *   AGENT_ID                - OpenClaw agent ID for spawning sub-agents (default: sprint-worker)
 */

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

// Load BaseWorker from hub
const HUB_PATH = process.env.HUB_PATH || '/app';

// Import ledger and completion validation
let ledgerApi = null;
let validateCompletion = null;
try {
  const ledgerModule = require(`${HUB_PATH}/src/execution-ledger`);
  ledgerApi = {
    create: ledgerModule.create,
    start: ledgerModule.start,
    complete: ledgerModule.complete,
    invalidate: ledgerModule.invalidate
  };
  ({ validateCompletion } = require(`${HUB_PATH}/src/validation`));
} catch (e) {
  console.warn(`[sprint] Could not load ledger/validation modules: ${e.message}`);
}
let BaseWorker;
try {
  BaseWorker = require(`${HUB_PATH}/workers/base-worker.js`);
} catch (e) {
  // Fallback: inline minimal BaseWorker if hub path not available
  console.error(`[sprint] Hub BaseWorker not found at ${HUB_PATH}, using inline fallback`);
  BaseWorker = class InlineBaseWorker {
    constructor(agentId, options = {}) {
      this.agentId = agentId;
      this.inboxKey = `a2a:inbox:${agentId}`;
      this.coordinationChannel = 'a2a:coordination';
      this.heartbeatChannel = 'a2a:heartbeats';
      this.registryKey = 'a2a:registry';
      this.redis = null;
      this.pollTimeout = options.pollTimeout || 5;
      this.heartbeatInterval = options.heartbeatInterval || 30000;
      this.running = false;
      this.currentTask = null;
      this.startTime = null;
    }

    async connect() {
      const Redis = require('ioredis');
      this.redis = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: process.env.REDIS_PORT || 6379
      });
    }

    async register() {
      const ttl = Math.floor((this.heartbeatInterval * 3) / 1000);
      this.startedAt = new Date().toISOString();
      await this.redis.hset(this.registryKey, this.agentId, JSON.stringify({
        status: 'online', startedAt: this.startedAt,
        capabilities: this.getCapabilities(), lastSeen: Date.now()
      }));
      await this.redis.expire(this.registryKey, 3600);
      await this.redis.set(`${this.registryKey}:${this.agentId}:ttl`, '1', 'EX', ttl);
      console.log(`[${this.agentId}] Registered (TTL: ${ttl}s)`);
    }

    async deregister() {
      await this.redis.hdel(this.registryKey, this.agentId);
      await this.redis.del(`${this.registryKey}:${this.agentId}:ttl`);
    }

    getCapabilities() { return ['gh', 'git', 'read', 'write', 'sprint']; }

    async processTask(taskPayload) { throw new Error('processTask() must be implemented'); }

    formatResult(taskPayload, result, status = 'completed', error = null) {
      return {
        type: 'result', taskId: taskPayload.taskId || taskPayload.task_id,
        agent: this.agentId, task: taskPayload.task || taskPayload.objective,
        status, output: result, error,
        durationMs: this.startTime ? Date.now() - this.startTime : 0,
        timestamp: new Date().toISOString()
      };
    }

    async publishResult(result) {
      await this.redis.publish(this.coordinationChannel, JSON.stringify(result));
      console.log(`[${this.agentId}] Result published: ${result.status}`);
    }

    async sendHeartbeat() {
      const hb = {
        type: 'heartbeat', agent: this.agentId,
        status: this.running ? 'running' : 'idle',
        currentTask: this.currentTask,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      };
      await this.redis.publish(this.heartbeatChannel, JSON.stringify(hb));
      if (!this.running) return;
      const ttl = Math.floor((this.heartbeatInterval * 3) / 1000);
      await this.redis.hset(this.registryKey, this.agentId, JSON.stringify({
        status: hb.status, capabilities: this.getCapabilities(),
        lastSeen: Date.now(), startedAt: this.startedAt
      }));
      if (!this.running) return;
      await this.redis.expire(this.registryKey, 3600);
      if (!this.running) return;
      await this.redis.set(`${this.registryKey}:${this.agentId}:ttl`, '1', 'EX', ttl);
    }

    async pollTask() {
      try {
        const result = await this.redis.blpop(this.inboxKey, this.pollTimeout);
        if (!result) return null;
        const [, message] = result;
        return JSON.parse(message);
      } catch (err) {
        console.error(`[${this.agentId}] Poll error:`, err.message);
        return null;
      }
    }

    async start() {
      if (this.running) { console.warn(`[${this.agentId}] Already running`); return; }
      await this.connect();
      await this.register();
      this.running = true;
      console.log(`[${this.agentId}] Worker started, polling ${this.inboxKey}`);
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatInterval);
      while (this.running) {
        const taskPayload = await this.pollTask();
        if (!taskPayload) continue;
        const laneId = taskPayload.id || taskPayload.taskId || taskPayload.task_id;
        console.log(`[${this.agentId}] Received task:`, taskPayload.task || taskPayload.objective || taskPayload.task_id);
        this.startTime = Date.now();
        this.currentTask = taskPayload.task || taskPayload.objective;
        try {
          // Transition ledger: pending → running
          if (ledgerApi && this.redis && laneId) {
            await ledgerApi.start(this.redis, laneId).catch(err => {
              console.warn(`[${this.agentId}] Ledger start failed for ${laneId}: ${err.message}`);
            });
          }
          const result = await this.processTask(taskPayload);
          const formatted = this.formatResult(taskPayload, result, 'completed');
          await this.publishResult(formatted);
        } catch (err) {
          console.error(`[${this.agentId}] Task error:`, err.message);
          // Transition ledger: running → invalid on uncaught error
          if (ledgerApi && this.redis && laneId) {
            await ledgerApi.invalidate(this.redis, laneId, { reason: err.message }).catch(() => {});
          }
          const errorResult = this.formatResult(taskPayload, null, 'failed', err.message);
          await this.publishResult(errorResult);
        }
        this.currentTask = null;
        this.startTime = null;
      }
    }

    async stop() {
      console.log(`[${this.agentId}] Stopping...`);
      this.running = false;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      let waited = 0;
      while (this.currentTask && waited < 30000) {
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }
      await this.deregister();
      if (this.redis) await this.redis.quit();
      console.log(`[${this.agentId}] Stopped`);
    }
  };
}

const { logger } = require(`${HUB_PATH}/src/logger.js`);

// === Config ===
const AGENT_ID = 'sprint';
const HEARTBEAT_INTERVAL = parseInt(process.argv.find(a => a.startsWith('--heartbeat-interval='))?.split('=')[1] || '30000', 10);
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const WORKER_TIMEOUT = 120000; // 2 min max per task

// === Sprint Worker ===
class SprintWorker extends BaseWorker {
  constructor(options = {}) {
    super(AGENT_ID, { ...options, heartbeatInterval: HEARTBEAT_INTERVAL });
    this.gatewayUrl = GATEWAY_URL;
    this.gatewayToken = GATEWAY_TOKEN;
  }

  getCapabilities() {
    return ['gh', 'git', 'read', 'write', 'sprint', 'multi-step'];
  }

  /**
   * Execute a shell command (gh, git, etc.)
   */
  execCommandAsync(args, cwd = '/home/node/.openclaw/workspace') {
    return new Promise((resolve) => {
      execFile(args[0], args.slice(1), {
        encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, cwd
      }, (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, error: err.message, stderr: stderr?.trim() || null });
        } else {
          resolve({ success: true, output: stdout.trim() });
        }
      });
    });
  }

  /**
   * Spawn an OpenClaw sub-agent via sessions API
   */
  async spawnSubAgent(objective, options = {}) {
    const { project, timeoutSeconds = 60 } = options;

    const body = {
      task: objective,
      runtime: 'subagent',
      mode: 'run',
      runTimeoutSeconds: timeoutSeconds,
    };

    const headers = { 'Content-Type': 'application/json' };
    if (this.gatewayToken) headers['Authorization'] = `Bearer ${this.gatewayToken}`;

    try {
      const response = await fetch(`${this.gatewayUrl}/api/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutSeconds * 1000 + 10000),
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `HTTP ${response.status}: ${text}` };
      }

      const data = await response.json();
      return { success: true, sessionId: data.sessionId, status: 'spawned' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Build a ledger completion payload from SprintWorker result.
   * Extracts commitHash and changedFiles from step results.
   * @param {object} result - SprintWorker.processTask() output
   */
  _buildCompletionPayload(result) {
    if (!result) return { commitHash: '', changedFiles: [], verification: {} };

    let commitHash = '';
    let changedFiles = [];

    for (const step of result.results || []) {
      const cmd = step.command || '';
      // Extract short commit hash from `git commit -m "..."` output
      if (cmd.startsWith('git commit')) {
        const match = (step.output || '').match(/\[([a-f0-9]+)\s/);
        if (match) commitHash = match[1].substring(0, 7);
      }
      // Extract changed files from `git diff --name-only` or `git status --porcelain`
      if (cmd.startsWith('git diff --name-only') || cmd.startsWith('git status')) {
        const files = (step.output || '')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0 && !l.startsWith('??') && !l.startsWith('warning:'));
        if (files.length > 0) changedFiles.push(...files);
      }
    }

    // Synthesize verification: one key per step, truthy if the step succeeded
    const verification = {};
    for (const step of result.results || []) {
      const key = `step_${step.step}`;
      verification[key] = step.success !== false;
    }

    return { commitHash, changedFiles: [...new Set(changedFiles)], verification };
  }

  /**
   * Transition the ledger after processing: complete or invalidate.
   * Implements two-strike pattern: strict retry once, then escalate.
   */
  async _transitionLedger(laneId, result, error) {
    if (!ledgerApi || !this.redis || !laneId) return;

    // Only ledger-complete 'completed' (no errors) results
    if (!error && result && result.status === 'completed') {
      const { commitHash, changedFiles, verification } = this._buildCompletionPayload(result);

      if (validateCompletion) {
        const valid = validateCompletion({
          state: 'done',
          commitHash,
          changedFiles,
          verification
        });

        if (!valid.valid) {
          // Completion schema failed → invalidate
          const { shouldEscalate } = await ledgerApi.invalidate(this.redis, laneId, {
            reason: valid.error
          });
          console.warn(`[${this.agentId}] Completion invalid for ${laneId}: ${valid.error}${shouldEscalate ? ' [ESCALATE]' : ' [retry-1]'}`);
          return;
        }
      }

      try {
        await ledgerApi.complete(this.redis, laneId, { commitHash, changedFiles, verification });
        console.log(`[${this.agentId}] Ledger complete: ${laneId} (${commitHash})`);
      } catch (err) {
        console.warn(`[${this.agentId}] Ledger complete failed for ${laneId}: ${err.message}`);
      }
    } else if (error || (result && result.status !== 'completed')) {
      const reason = error ? error.message : (result.errors_count > 0
        ? `${result.errors_count} step(s) failed`
        : `non-success status: ${result.status}`);
      const { shouldEscalate } = await ledgerApi.invalidate(this.redis, laneId, { reason }).catch(() => ({ shouldEscalate: false }));
      console.warn(`[${this.agentId}] Lane invalid for ${laneId}: ${reason}${shouldEscalate ? ' [ESCALATE — 2nd failure]' : ' [retry-1]'}`);
    }
  }

  /**
   * Process a sprint task — parses steps from objective and executes them
   */
  async processTask(taskPayload) {
    const { objective, project, steps, task_id, taskId } = taskPayload;
    const id = task_id || taskId || 'unknown';
    const startTime = Date.now();
    const results = [];
    const errors = [];
    const WORKDIR = project
      ? `/f/ai-workspace/projects/${project}`
      : '/home/node/.openclaw/workspace';

    // Parse steps from objective (markdown numbered list format)
    let stepList = steps || [];
    if (!stepList.length && typeof objective === 'string') {
      const stepMatch = objective.match(/(?:STEP\s*\d+[:\s-]*|^\d+[\.\)]\s*)(.*)/gim);
      if (stepMatch) {
        stepList = stepMatch.map(s => s.replace(/^(?:STEP\s*\d+[:\s-]*|^\d+[\.\)]\s*)/i, '').trim());
      }
    }

    if (!stepList.length) {
      // Fallback: treat entire objective as a single command to run
      return {
        task_id: id, status: 'no_steps',
        message: 'No executable steps found in task payload',
        started_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime
      };
    }

    for (let i = 0; i < stepList.length; i++) {
      const step = stepList[i];
      const stepStart = Date.now();
      console.log(`[${AGENT_ID}] Step ${i + 1}/${stepList.length}: ${step.substring(0, 80)}...`);

      try {
        // Detect gh vs git vs generic command
        const trimmed = step.trim();
        const parts = trimmed.split(/\s+/);
        const cmd = parts[0];

        if (cmd === 'gh') {
          const result = await this.execCommandAsync(parts, WORKDIR);
          results.push({ step: i + 1, command: trimmed, ...result, duration_ms: Date.now() - stepStart });
          if (!result.success) errors.push({ step: i + 1, error: result.error });
        } else if (cmd === 'git') {
          const result = await this.execCommandAsync(parts, WORKDIR);
          results.push({ step: i + 1, command: trimmed, ...result, duration_ms: Date.now() - stepStart });
          if (!result.success) errors.push({ step: i + 1, error: result.error });
        } else if (cmd === 'spawn') {
          // spawn <objective> [--project <name>] [--timeout <seconds>]
          const subParts = parts.slice(1);
          const timeoutIdx = subParts.indexOf('--timeout');
          const timeout = timeoutIdx >= 0 ? parseInt(subParts[timeoutIdx + 1]) : 60;
          const projectIdx = subParts.indexOf('--project');
          const projectName = projectIdx >= 0 ? subParts[projectIdx + 1] : project;
          const subObjective = subParts.slice(0, projectIdx >= 0 ? projectIdx : undefined).join(' ');
          const spawnResult = await this.spawnSubAgent(subObjective, { project: projectName, timeoutSeconds: timeout });
          results.push({ step: i + 1, command: `spawn: ${subObjective}`, ...spawnResult, duration_ms: Date.now() - stepStart });
          if (!spawnResult.success) errors.push({ step: i + 1, error: spawnResult.error });
        } else {
          // Generic shell command
          const result = await new Promise((resolve) => {
            const child = spawn('/bin/sh', ['-c', trimmed], {
              cwd: WORKDIR, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024
            });
            let out = '', err = '';
            child.stdout.on('data', d => { out += d.toString(); });
            child.stderr.on('data', d => { err += d.toString(); });
            child.on('close', (code) => {
              resolve({
                success: code === 0,
                output: out.trim(),
                stderr: err.trim() || null,
                error: code !== 0 ? `exit ${code}` : undefined
              });
            });
            child.on('error', e => resolve({ success: false, error: e.message }));
          });
          results.push({ step: i + 1, command: trimmed, ...result, duration_ms: Date.now() - stepStart });
          if (!result.success) errors.push({ step: i + 1, error: result.error });
        }
      } catch (err) {
        results.push({ step: i + 1, error: err.message, duration_ms: Date.now() - stepStart });
        errors.push({ step: i + 1, error: err.message });
      }
    }

    const result = {
      task_id: id,
      status: errors.length === 0 ? 'completed' : errors.length < stepList.length ? 'partial' : 'failed',
      steps_total: stepList.length,
      steps_completed: results.filter(r => r.success !== false).length,
      errors_count: errors.length,
      results,
      errors: errors.length ? errors : undefined,
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      agent: AGENT_ID,
      project
    };

    // Transition ledger: complete or invalidate based on result
    const laneId = task_id || taskId;
    await this._transitionLedger(laneId, result, null).catch(err => {
      console.warn(`[${this.agentId}] _transitionLedger error: ${err.message}`);
    });

    return result;
  }
}

// === Bootstrap ===
const worker = new SprintWorker();

process.on('SIGINT', async () => {
  await worker.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await worker.stop();
  process.exit(0);
});

worker.start().catch(err => {
  console.error(`[${AGENT_ID}] Fatal:`, err.message, err.stack);
  process.exitCode = 1;
});
