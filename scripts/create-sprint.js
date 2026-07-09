#!/usr/bin/env node
/**
 * Sprint Creation Script — Phase 1
 * Creates all 7 milestones and 26 issues on openclaw-coordination-hub
 */
const { execSync } = require('child_process');
const REPO = 'mfernandez4/openclaw-coordination-hub';

function gh(args, options = {}) {
  const cmd = ['gh', ...args, '--repo', REPO].join(' ');
  console.log(`  $ ${cmd}`);
  try {
    const out = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
    return out.trim();
  } catch (e) {
    console.error('    ERROR:', e.message);
    if (e.stderr) console.error('    STDERR:', e.stderr.trim());
    if (e.stdout) console.error('    STDOUT:', e.stdout.trim());
    throw e;
  }
}

function ghJSON(args) {
  const out = gh(args, { encoding: 'utf-8' });
  return JSON.parse(out);
}

// ── Milestones ────────────────────────────────────────────────────────────────
const MILESTONES = [
  { number: null, title: 'M1 — Core Routing' },
  { number: null, title: 'M2 — Security Hardening' },
  { number: null, title: 'M3 — Worker Implementations' },
  { number: null, title: 'M4 — Memory Integration' },
  { number: null, title: 'M5 — Observability & Health' },
  { number: null, title: 'M6 — Testing' },
  { number: null, title: 'M7 — Spec & Config Alignment' },
];

console.log('\n=== Creating Milestones ===');
for (const m of MILESTONES) {
  const out = ghJSON(['milestone', 'create', m.title, '--json', 'number']);
  m.number = out.number;
  console.log(`  Created milestone #${m.number}: ${m.title}\n`);
}

const M = {};
for (const m of MILESTONES) {
  M[m.title.split('—')[0].trim()] = m.number;
}
console.log('Milestone number map:', M);

// ── Issues ────────────────────────────────────────────────────────────────────
const ISSUES = [
  // M1 — Core Routing
  {
    milestone: M['M1'], labels: ['bug', 'P0'],
    title: 'Task routing gap — no worker pulls from coordination:tasks queue',
    body: `## Problem\nTaskQueue enqueues to coordination:tasks via LPUSH. No worker polls this queue. Tasks enqueued from A2A messages sit in Redis indefinitely. The only consumers are individual typed workers (coding, github-ops, etc.) polling their own queues, which are never written to.\n\n## Fix\nAdd a dispatcher in index.js that BRPOP from coordination:tasks, reads the type field, and routes to the appropriate typed queue (e.g., tasks:coding, tasks:github-ops). Or rewrite workers to all pull from coordination:tasks and self-select by task type.\n\n## Acceptance Criteria\n- A task enqueued via taskQueue.enqueue() reaches the correct worker\n- Unroutable task types are dead-lettered with an error result published`,
  },
  {
    milestone: M['M1'], labels: ['bug', 'P0'],
    title: 'ResultProcessor imported but never started in index.js',
    body: `## Problem\nsrc/result-processor.js exists and is functional but is never imported or initialized in src/index.js. Audit logging, result persistence, and a2a:results:{orchestratorId} publishing are all dead code.\n\n## Fix\nImport ResultProcessor in index.js and call start() alongside the other component initializations.\n\n## Acceptance Criteria\n- ResultProcessor starts with the service\n- Completed task results appear in a2a:results:main channel\n- Audit log entries appear in Redis with correct TTL`,
  },
  {
    milestone: M['M1'], labels: ['bug', 'P0'],
    title: 'coordination-listener.js subscribes to wrong channel',
    body: `## Problem\nscripts/coordination-listener.js subscribes to a2a:results but ResultProcessor publishes to a2a:results:{orchestratorId} (e.g., a2a:results:main). The listener never receives any messages.\n\n## Fix\nEither subscribe to a2a:results:* using Redis pattern subscribe, or default to a2a:results:main configurable via RESULT_CHANNEL env var.\n\n## Acceptance Criteria\n- coordination-listener.js receives results published by ResultProcessor\n- Channel name is configurable via environment variable`,
  },
  {
    milestone: M['M1'], labels: ['bug', 'P1'],
    title: 'A2A agent registry split-brain — in-memory Map never synced from Redis',
    body: `## Problem\nA2AAdapter maintains a local Map of registered agents. getOnlineAgents() queries only this map, not the Redis a2a:registry hash that workers write to via BaseWorker. Result: getOnlineAgents() always returns only [hub], regardless of which workers are running.\n\n## Fix\nOn startup and on a2a:agents events, sync the local map from HGETALL a2a:registry. Alternatively, remove the local map and query Redis directly.\n\n## Acceptance Criteria\n- getOnlineAgents() returns all workers that have registered heartbeats in Redis\n- Stale entries (missed heartbeat > 60s) are excluded`,
  },

  // M2 — Security Hardening
  {
    milestone: M['M2'], labels: ['bug', 'P0'],
    title: 'Command injection in CodingWorker — unsanitized payload interpolated into shell string',
    body: `## Problem\nworkers/coding.js line ~101 constructs shell commands by direct string interpolation of task.payload fields (e.g., \`grep -r "\${pattern}" \${searchPath}\`). An attacker controlling task payloads can execute arbitrary shell commands.\n\n## Fix\nReplace all exec/execSync shell-string construction with execFile using argument arrays. Validate searchPath against an allowlist of permitted directories. Reject payloads with shell metacharacters in pattern fields.\n\n## Acceptance Criteria\n- grep, find, and any shell invocations use execFile with argument arrays, never template strings\n- Payload validation rejects inputs containing \`, $(), ;, |, &&, ||, >, <\n- Tests cover injection attempt payloads`,
  },
  {
    milestone: M['M2'], labels: ['bug', 'P0'],
    title: 'Command injection in GitHubOpsWorker — branch name from payload interpolated into git commands',
    body: `## Problem\nworkers/github-ops.js uses execSync with template strings like \`git checkout -b \${branch}\` where branch comes directly from task payload. Malicious branch names can inject shell commands.\n\n## Fix\nSwitch to execFile with argument arrays for all git invocations. Validate branch name against \`/^[a-zA-Z0-9/_.-]+$/\` before use.\n\n## Acceptance Criteria\n- All git calls use execFile with array args\n- Branch/repo/path fields validated before use\n- Injection attempt payload test cases added`,
  },
  {
    milestone: M['M2'], labels: ['enhancement', 'P1'],
    title: 'Add input validation layer for all task payloads',
    body: `## Problem\nNo centralized validation for task payloads before they reach workers. Each worker trusts payload fields completely.\n\n## Fix\nCreate src/validation.js with per-task-type schemas (using zod or a lightweight validator). Validate in the dispatcher (Issue #1 fix) before routing. Return structured error result for invalid payloads.\n\n## Acceptance Criteria\n- Each task type has a defined schema\n- Invalid payloads produce a failed task result, not an unhandled error\n- type, payload, and id fields validated for all tasks`,
  },

  // M3 — Worker Implementations
  {
    milestone: M['M3'], labels: ['bug', 'P0'],
    title: 'ResearchWorker calls web_search() and web_fetch() as globals — crashes on execution',
    body: `## Problem\nworkers/research.js calls web_search() and web_fetch() (lines ~54, ~87) as if they are global functions. These are OpenClaw MCP tool bindings unavailable in standalone Node.js. Every research task throws ReferenceError: web_search is not defined.\n\n## Fix\nReplace with node-fetch HTTP calls or an npm search/fetch library. If MCP tool access is required, stub with a clear NotImplementedError and document the dependency. Do not leave crashing code in a production path.\n\n## Acceptance Criteria\n- research task type executes without throwing ReferenceError\n- Either real web fetch capability is wired, or a clear stub is returned with a not_implemented status`,
  },
  {
    milestone: M['M3'], labels: ['enhancement', 'P1'],
    title: 'DevOpsWorker — all handlers return hardcoded stub strings',
    body: `## Problem\nworkers/dev-ops.js returns 'deployed', 'running', 'sample log output' for all operations. No real Docker or system interaction occurs.\n\n## Fix\nImplement real handlers: use dockerode or execFile('docker', [...]) for container ops; read actual log files or Docker logs for get_logs; report real container status for check_status.\n\n## Acceptance Criteria\n- deploy invokes real Docker commands or returns not_implemented with explanation\n- check_status queries actual container state\n- get_logs returns real log output or last N lines from a configured log path`,
  },
  {
    milestone: M['M3'], labels: ['bug', 'P1'],
    title: 'worker-ctl.js — execSync with detached workers blocks forever; redis package missing',
    body: `## Problem\n(1) Line ~55 uses execSync to start workers with stdio: 'detached' — execSync waits for process to exit, blocking forever for long-running workers. Should use spawn with detached: true and unref(). (2) Line ~20: require('redis') — only ioredis is installed. Throws MODULE_NOT_FOUND on startup.\n\n## Fix\nReplace execSync with spawn(..., { detached: true, stdio: 'ignore' }) + .unref(). Replace require('redis') with require('ioredis').\n\n## Acceptance Criteria\n- worker-ctl.js start <worker> returns immediately with the spawned PID\n- No MODULE_NOT_FOUND on startup\n- Worker continues running after worker-ctl.js exits`,
  },
  {
    milestone: M['M3'], labels: ['bug', 'P1'],
    title: 'agent-inbox-worker.js hardcodes host: \'redis\' instead of reading REDIS_HOST env var',
    body: `## Problem\nLine ~15 of scripts/agent-inbox-worker.js hardcodes host: 'redis'. Works only inside Docker with the service named redis. Fails in all other environments (local dev, CI, staging with different service names).\n\n## Fix\nReplace with host: process.env.REDIS_HOST || 'redis' and port: parseInt(process.env.REDIS_PORT) || 6379.\n\n## Acceptance Criteria\n- REDIS_HOST and REDIS_PORT env vars control connection\n- Defaults still work in Docker Compose environment`,
  },

  // M4 — Memory Integration
  {
    milestone: M['M4'], labels: ['bug', 'P1'],
    title: 'MemoryBridge.getRecentSessions() looks for non-existent memory.json',
    body: `## Problem\nsrc/memory-bridge.js attempts to read a memory.json file that does not exist in openclaw-memory-system-v1. The memory system uses individual markdown files with SHA256-keyed deduplication, not a flat JSON store. Method always returns empty.\n\n## Fix\nRead from the actual memory-system-v1 file structure — daily notes directory or the promote pipeline output. Or expose a read API in memory-system-v1 and call it here.\n\n## Acceptance Criteria\n- getRecentSessions() returns actual session data from memory-system-v1\n- Graceful empty array return if memory system is not configured`,
  },
  {
    milestone: M['M4'], labels: ['bug', 'P1'],
    title: 'MemoryBridge.recordAgentEvent() only logs to console — never writes to disk',
    body: `## Problem\nrecordAgentEvent() calls console.log() and returns. No data is written to memory-system-v1 or anywhere persistent. Agent events are silently dropped.\n\n## Fix\nWire recordAgentEvent() to call memoryBridge.write() using the write pipeline contract from memory-system-v1 (pipeline.js writeMemoryBlock()).\n\n## Acceptance Criteria\n- Agent events produce entries in memory-system-v1 daily notes\n- Failed writes log error but do not throw (non-blocking)`,
  },
  {
    milestone: M['M4'], labels: ['enhancement', 'P2'],
    title: 'Wire MemoryBridge into result flow — persist completed task summaries',
    body: `## Problem\nTask completion results flow through ResultProcessor but are never written to the memory system. Long-term agent interaction history is lost.\n\n## Fix\nAfter ResultProcessor processes a result, call memoryBridge.recordAgentEvent() with a summary of task type, agent, result status, and any significant output.\n\n## Acceptance Criteria\n- Completed tasks with success status produce a memory entry\n- Memory entries tagged with coordination-hub and task type\n- Failed tasks with error messages also recorded`,
  },

  // M5 — Observability & Health
  {
    milestone: M['M5'], labels: ['enhancement', 'P1'],
    title: 'Add HTTP health endpoint',
    body: `## Problem\nNo way to probe service health from Docker Compose healthcheck or monitoring. Redis connection state and component status are invisible externally.\n\n## Fix\nAdd a minimal HTTP server (no framework needed — http.createServer) on port 3001 (configurable via HEALTH_PORT). GET /health returns { status: 'ok', redis: 'connected'|'disconnected', uptime: N }.\n\n## Acceptance Criteria\n- GET /health returns 200 with JSON when Redis is connected\n- Returns 503 when Redis is disconnected\n- Docker Compose healthcheck can use this endpoint`,
  },
  {
    milestone: M['M5'], labels: ['enhancement', 'P1'],
    title: 'Replace console.log with structured JSON logging',
    body: `## Problem\nAll logging uses console.log with string interpolation. No log levels, no structured fields, no timestamps. Impossible to parse or filter in production.\n\n## Fix\nReplace with a minimal structured logger (e.g., pino — already lightweight) or a simple wrapper that emits { level, timestamp, component, message, ...fields } JSON to stdout.\n\n## Acceptance Criteria\n- All log output is valid JSON, one object per line\n- Log level controlled by LOG_LEVEL env var (default: info)\n- Each log entry includes component field identifying the source module`,
  },
  {
    milestone: M['M5'], labels: ['enhancement', 'P1'],
    title: 'Redis disconnection not handled — service crashes silently',
    body: `## Problem\nioredis default reconnect behavior retries, but errors during reconnect propagate as unhandled rejections. No alerting or status update occurs when Redis goes down.\n\n## Fix\nAdd error event handlers on all ioredis instances. On disconnect, update health status (for Issue #15 endpoint), log structured error, and if reconnect fails after N attempts, exit with non-zero code so Docker restarts the container.\n\n## Acceptance Criteria\n- Redis disconnect is logged with structured error entry\n- Health endpoint returns 503 during disconnect\n- Unhandled promise rejections from Redis are caught and logged`,
  },

  // M6 — Testing
  {
    milestone: M['M6'], labels: ['enhancement', 'P1'],
    title: 'Add unit tests for core components',
    body: `## Problem\nNo automated tests exist for any src/ component. Zero confidence in refactors.\n\n## Fix\nAdd Jest (or Vitest) test suite. Cover: TaskQueue enqueue/dequeue, RedisPubSub publish/subscribe with mock Redis, A2AAdapter message routing, ResultProcessor filter/format pipeline.\n\n## Acceptance Criteria\n- npm test runs and passes\n- Coverage for task-queue.js, redis-pubsub.js, a2a-adapter.js, result-processor.js\n- Redis mocked via ioredis-mock or manual stub`,
  },
  {
    milestone: M['M6'], labels: ['enhancement', 'P1'],
    title: 'Promote a2a-test.js to an automated integration test',
    body: `## Problem\nscripts/a2a-test.js exists as a manual smoke test. It is not wired into any test runner and must be run by hand.\n\n## Fix\nMove to test/integration/a2a.test.js, add proper assertions, and wire into npm test (with a --integration flag guard so it only runs with a live Redis).\n\n## Acceptance Criteria\n- npm run test:integration runs a2a-test.js logic with assertions\n- Test fails loudly if Redis is unavailable rather than hanging\n- CI can skip integration tests without breaking the test command`,
  },
  {
    milestone: M['M6'], labels: ['enhancement', 'P2'],
    title: 'Add Redis test harness using ioredis-mock',
    body: `## Problem\nUnit tests that touch Redis require a live Redis instance, making them slow and environment-dependent.\n\n## Fix\nConfigure ioredis-mock as a dev dependency. Create a test utility (test/helpers/redis.js) that swaps in the mock for unit tests.\n\n## Acceptance Criteria\n- All unit tests in M6 Issue #18 run without a live Redis instance\n- ioredis-mock listed in devDependencies`,
  },

  // M7 — Spec & Config Alignment
  {
    milestone: M['M7'], labels: ['bug', 'P2'],
    title: 'Channel name mismatch between TECHNICAL_SPEC.md and implementation',
    body: `## Problem\nSpec documents channels agents:events, tasks:events, workflows:events. Implementation uses a2a:agents, a2a:coordination, a2a:inbox:{id}, a2a:results:{id}. These are entirely different namespaces.\n\n## Fix\nUpdate TECHNICAL_SPEC.md to reflect actual channel names. Add a channel reference table to README.\n\n## Acceptance Criteria\n- Spec and code use identical channel names\n- README contains a channel reference table`,
  },
  {
    milestone: M['M7'], labels: ['enhancement', 'P2'],
    title: 'Spec documents priority queues — implementation uses a single queue',
    body: `## Problem\nTECHNICAL_SPEC.md section 4.2 documents tasks:queue:<priority> with LPUSH/RPOP. Actual implementation uses a single coordination:tasks queue with BRPOP. No priority support exists.\n\n## Fix\nEither implement priority queues (high, normal, low) by polling in priority order, or remove priority queue documentation from spec and add a backlog issue for future work.\n\n## Acceptance Criteria\n- Spec and implementation agree on queue structure\n- If priority queues are deferred, a clear backlog note explains the gap`,
  },
  {
    milestone: M['M7'], labels: ['enhancement', 'P2'],
    title: 'Spec documents agent TTL status hash — BaseWorker uses plain registry hash with no TTL',
    body: `## Problem\nSpec: agents:status:<agent-id> hash with 300s TTL. Implementation: BaseWorker writes to a2a:registry hash field with no TTL. Dead workers persist in registry indefinitely.\n\n## Fix\nEither add EXPIRE on each heartbeat write in BaseWorker (TTL = heartbeat_interval × 3), or document that the registry requires manual cleanup and add a cleanup task.\n\n## Acceptance Criteria\n- Workers missing heartbeats are automatically evicted from registry within 3× heartbeat interval\n- OR spec updated to document actual behavior with explicit cleanup strategy`,
  },
  {
    milestone: M['M7'], labels: ['enhancement', 'P2'],
    title: 'docs/redis-compose-addition.yaml uses wrong network name',
    body: `## Problem\ndocs/redis-compose-addition.yaml references network openclaw-internal. The actual Docker Compose environment uses ai-stack_default or a project-namespaced network. The external: true reference will fail if the network name doesn't match.\n\n## Fix\nVerify the actual network name in the compose stack. Update the yaml to use the correct network or document the prerequisite: docker network create openclaw-internal.\n\n## Acceptance Criteria\n- README documents the exact docker network create command needed\n- redis-compose-addition.yaml matches the actual network used by the stack`,
  },
  {
    milestone: M['M7'], labels: ['bug', 'P2'],
    title: 'hub-task.js appears duplicated — scripts/ and root level',
    body: `## Problem\nA hub-task.js file exists in both scripts/ and what appears to be the project root. Duplicate files diverge silently.\n\n## Fix\nAudit both files. If identical, remove the duplicate and update any references. If diverged, reconcile and keep only the canonical path.\n\n## Acceptance Criteria\n- Only one hub-task.js exists\n- All references point to the canonical location`,
  },
  {
    milestone: M['M7'], labels: ['bug', 'P2'],
    title: 'package.json engine constraint says >=18 but spec says Node 20+',
    body: `## Problem\nTECHNICAL_SPEC.md section 8.1 requires Node.js 20+. package.json engines field says >=18. Inconsistency allows running on Node 18 even if 20+ features are used.\n\n## Fix\nAlign both to >=20. If the codebase genuinely supports 18, update the spec.\n\n## Acceptance Criteria\n- package.json engines.node matches TECHNICAL_SPEC.md requirement\n- CI (if added) uses the specified Node version`,
  },
];

console.log('\n=== Creating Issues ===');
const created = [];
for (const issue of ISSUES) {
  const labelArgs = issue.labels.flatMap(l => ['--label', l]);
  const out = ghJSON([
    'issue', 'create',
    '--title', issue.title,
    '--body', issue.body,
    '--milestone', String(issue.milestone),
    ...labelArgs,
    '--json', 'number,title,url'
  ]);
  console.log(`  Created #${out.number}: ${out.title}`);
  console.log(`  ${out.url}\n`);
  created.push(out);
}

// ── Print Summary ─────────────────────────────────────────────────────────────
console.log('\n=== Sprint Summary ===\n');
console.log('**Milestones:**');
for (const m of MILESTONES) {
  console.log(`- [#${m.number}] ${m.title}`);
}
console.log('\n**Issues:**');
for (const i of created) {
  console.log(`- #${i.number} ${i.title}`);
}

console.log('\n**Status Table:**');
console.log('| Issue | Branch | PR | Status |');
console.log('|-------|--------|----|--------|');
for (const i of created) {
  console.log(`| #${i.number} | — | — | pending |`);
}
console.log('\n✅ Phase 1 complete. Next: Issue #1 PR (fix/issue-1-task-routing-gap)');
