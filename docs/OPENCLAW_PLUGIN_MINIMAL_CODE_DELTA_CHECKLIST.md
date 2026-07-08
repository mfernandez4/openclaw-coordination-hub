# OpenClaw ↔ Coordination Hub
## Minimal Code Delta Checklist (v1)

**Date:** 2026-04-05  
**Status:** Draft / implementation-ready

---

## Plugin-only (MVP) — required

This path should work end-to-end without hub core changes.

### New plugin files

- [ ] `~/.openclaw/extensions/coordination-hub-tool/package.json`
- [ ] `~/.openclaw/extensions/coordination-hub-tool/openclaw.plugin.json`
- [ ] `~/.openclaw/extensions/coordination-hub-tool/index.ts`
- [ ] `~/.openclaw/extensions/coordination-hub-tool/src/keys.ts`
- [ ] `~/.openclaw/extensions/coordination-hub-tool/src/redis-client.ts`
- [ ] `~/.openclaw/extensions/coordination-hub-tool/src/tools/dispatch-task.ts`
- [ ] `~/.openclaw/extensions/coordination-hub-tool/src/tools/get-task-result.ts`

### `dispatch_task` implementation

- [ ] Validate input schema
- [ ] Generate `taskId`; set both `id` and `taskId` to same value
- [ ] Build envelope (`task`, `type`, `payload`, `priority`, `orchestratorId`, `metadata`)
- [ ] Routing:
  - [ ] `routing=dispatcher` → `LPUSH coordination:tasks:{priority}`
  - [ ] `routing=direct` → `RPUSH a2a:inbox:{agent_id}`
- [ ] Write plugin-owned status hash `a2a:task:{taskId}` with TTL
- [ ] Optional bounded wait (`wait_ms`) using same retrieval path as `get_task_result`

### `get_task_result` implementation

- [ ] Lookup order:
  1. [ ] `a2a:task:{taskId}`
  2. [ ] `a2a:audit:{taskId}`
  3. [ ] Scan `a2a:results:{orchestratorId}:list`
- [ ] Polling support (`wait_ms`, `poll_interval_ms`)
- [ ] Normalize status enum in tool response

### OpenClaw config changes

- [ ] Add plugin entry in `openclaw.json`
- [ ] Set plugin env (`REDIS_HOST`, `REDIS_PORT`)
- [ ] Restart gateway

### MVP plugin tests

- [ ] Enqueue route correctness (dispatcher/direct)
- [ ] Correlation preservation (`id == taskId`)
- [ ] Terminal lookup from `a2a:audit:{taskId}`
- [ ] Timeout behavior for short waits

---

## Hub-core — minimum required

No hub code changes required for MVP.

### Runtime checks only

- [ ] Dispatcher is running
- [ ] Target workers are running
- [ ] Result processor is running
- [ ] `auditLog` remains enabled

---

## Hub-core hardening (recommended, tiny)

Low-risk improvements to prevent correlation drift.

- [ ] `workers/base-worker.js`: prefer `taskPayload.taskId || taskPayload.id`
- [ ] `src/result-processor.js`: robustly preserve task identity
- [ ] Add regression test for task correlation continuity

---

## Optional nice-to-have (phase 2+)

- [ ] `cancel_task(task_id)` tool
- [ ] Requeue dead-letter tool
- [ ] Lifecycle state transitions in `a2a:task:{taskId}` (`queued|dispatched|running|terminal`)
- [ ] Idempotency dedupe (`SETNX` + TTL)
- [ ] Per-task callback channel (`a2a:result:{taskId}`)
- [ ] Metrics/tracing (queue latency, completion latency, failures)
- [ ] Batch dispatch API

---

## References

- `docs/OPENCLAW_DISPATCH_TASK_TOOL_CONTRACT.md`
- `src/dispatcher.js`
- `src/result-processor.js`
- `workers/base-worker.js`
