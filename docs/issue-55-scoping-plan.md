# Issue #55 — Scoped Implementation Plan

## Enforce no-silent-failure execution contract in coordination-hub

---

## Context

Issue #55 requires runtime enforcement of delivery reliability for multi-step sub-agent execution. The full scope covers execution ledger, completion validation, preflight gate, TTL watchdog, and escalation. All slices have been implemented in PR #56.

---

## Implemented Architecture

### Slice 1 — Execution Ledger + Completion Validation ✅

**`src/execution-ledger.js`** — Redis hash state machine:

```
ledger:{laneId} → Hash
  state:        pending | running | done | blocked | invalid
  startedAt:    ISO timestamp
  deadline:     ISO timestamp (set by start())
  taskId:      coordination task ID
  commitHash:  populated when done
  changedFiles: JSON array of changed files
  errors:       JSON array of error messages
  retryCount:  number (two-strike pattern)
  blocker:     reason for blocked/invalid
  mitigation:  recommended next step
```

State transitions:
```
pending → running  (lane started + deadline set)
running → done     (commit hash + changed files validated)
running → blocked  (preflight failed before execution)
running → invalid  (>2 retries OR completion schema check failed)
```

**Ledger API:**
- `create(redis, laneId, taskId)` → writes `pending` state
- `start(redis, laneId)` → transitions to `running`, sets deadline
- `complete(redis, laneId, { commitHash, changedFiles, verification })` → transitions to `done`
- `block(redis, laneId, { reason, mitigation })` → transitions to `blocked`
- `invalidate(redis, laneId, { reason })` → transitions to `invalid`, increments retryCount
- `get(redis, laneId)` → returns current state + metadata
- `allLanes(redis)` → returns all lanes (for supervisor use)

**`src/validation.js`** — `validateCompletion()`:
Required on `done`: `commitHash` (7–40 hex), `changedFiles` (non-empty array), `verification` (≥1 passing key)
Required on `blocked`/`invalid`: `blocker` (non-empty string)

### Slice 2 — Preflight Gate ✅

**`src/preflight-gate.js`** — runs after `ledger.start()` and before task execution:

Checks:
1. **Repo visibility** — target path exists and is a readable directory
2. **Required files** — key files/directories exist (inferred from task type)

Integration:
- Sprint worker calls `runPreflight(taskPayload)` after `ledger.start()`
- On failure: `ledger.block()` → escalation event → skip task execution
- Task type inference: coding/impl tasks need `src/`, `test/`, `package.json`

### Slice 3 — TTL Watchdog + Escalation ✅

**`src/escalation-publisher.js`** — lease watchdog:
- Scans all lanes on each supervisor cycle
- Marks lanes whose deadline has passed as `invalid`
- Publishes escalation events to `a2a:escalations` Redis channel

Escalation events include: `laneId`, `taskId`, `agent`, `reason`, `stateBefore`, `stateAfter`, `timestamp`

**Two-strike escalation** (sprint worker):
- First invalid: `retryCount=1`, log warning with `[retry-1]`
- Second invalid: `retryCount=2`, publish escalation event with `[ESCALATE — 2nd failure]`

---

## Files

| File | Change |
|---|---|
| `src/execution-ledger.js` | New — state machine implementation |
| `src/validation.js` | Extended — `validateCompletion()` |
| `src/escalation-publisher.js` | New — TTL watchdog + escalation publisher |
| `src/preflight-gate.js` | New — preflight checks |
| `scripts/hub-task.js` | Wired `ledger.create()` after enqueue |
| `scripts/hub-sprint-worker.js` | Wired ledger transitions + preflight + escalation |
| `scripts/hub-sprint-supervisor.js` | Wired escalation scan loop |
| `test/unit/execution-ledger.test.js` | 31 tests |
| `test/unit/preflight-gate.test.js` | 18 tests |

---

## Redis Key Layout

```
ledger:{laneId}   Hash   — lane state and metadata
a2a:escalations   PubSub — escalation events
```

---

## Verification

```bash
cd /f/ai-workspace/projects/openclaw-coordination-hub
npm test
# Expected: 356 tests pass, 18 test files
```

---

## Exit Criteria — ALL COMPLETE

- [x] `src/execution-ledger.js` implemented and tested
- [x] `validateCompletion()` added to `src/validation.js` and tested
- [x] `hub-task.js` wires ledger creation
- [x] `hub-sprint-worker.js` wires ledger transitions + preflight
- [x] `src/preflight-gate.js` implemented and tested
- [x] `src/escalation-publisher.js` implemented and wired
- [x] TTL watchdog + two-strike escalation implemented
- [x] `npm test` passes (356/356)
- [ ] PR #56 merged to `main` — **pending review approval**
