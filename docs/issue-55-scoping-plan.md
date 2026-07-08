# Issue #55 — Scoped Implementation Plan
## Enforce no-silent-failure execution contract in coordination-hub

---

## Context

Issue #55 requires runtime enforcement of delivery reliability for multi-step sub-agent execution. The full scope covers 7 checklist items. This PR covers the **first vertical slice**:

1. **Completion schema validation** — reject completion without commit hash / changed files / verification output
2. **Execution ledger** — state machine (`pending → running → done|blocked|invalid`) with per-lane tracking in Redis

Subsequent slices (preflight gate, TTL watchdog, escalation, lane presets) build on this foundation and are tracked as follow-up work.

---

## Architecture

### Execution Ledger (`src/execution-ledger.js`)

A thin Redis-backed state machine. Each lane is a key:

```
ledger:{laneId} → Hash
  state:        pending | running | done | blocked | invalid
  startedAt:    ISO timestamp
  updatedAt:   ISO timestamp
  taskId:      coordination task ID
  commitHash:  populated when done
  changedFiles:JSON array of changed files
  errors:       JSON array of error messages
  retryCount:  number
```

State transitions are **append-only** (only `state` and `updatedAt` change after creation).

```
pending → running  (lane started)
running → done     (commit hash + changed files validated)
running → blocked  (preflight failed)
running → invalid  (completion schema check failed, >2 retries)
```

**Ledger API:**
- `create(redis, laneId, taskId)` → writes `pending` state
- `start(redis, laneId)` → transitions to `running`
- `complete(redis, laneId, { commitHash, changedFiles })` → transitions to `done`
- `block(redis, laneId, reason)` → transitions to `blocked`
- `invalidate(redis, laneId, reason)` → transitions to `invalid`
- `get(redis, laneId)` → returns current state + metadata
- `allLanes(redis)` → returns all lanes (for supervisor use)

### Completion Schema Validation (`src/validation.js` — extension)

Extend the existing `validateTask()` to also validate **completion payloads**:

```js
validateCompletion(completion) → { valid: true } | { valid: false, error: string }
```

Required fields on a `done` completion:
- `commitHash` — non-empty string, 7–40 hex chars
- `changedFiles` — array of non-empty strings
- `verification` — object with at least one passing key (e.g. `{ tests: 'pass', lint: 'pass' }`)

Optional on `blocked`/`invalid`:
- `blocker` — human-readable reason
- `mitigation` — recommended next step

### Wiring

- `hub-task.js` calls `ledger.create()` immediately after enqueueing
- Sprint worker calls `ledger.start()` when it picks up a task, `ledger.complete()` or `ledger.invalidate()` on finish
- Dispatcher logs ledger state changes for observability

---

## Files to add / change

| File | Change |
|---|---|
| `src/execution-ledger.js` | **New** — state machine implementation |
| `src/validation.js` | Extend — add `validateCompletion()` |
| `test/unit/execution-ledger.test.js` | **New** — unit tests for ledger |
| `test/unit/validation.test.js` | Extend — add completion schema tests |
| `scripts/hub-task.js` | Wire `ledger.create()` after enqueue |
| `scripts/hub-sprint-worker.js` | Wire `ledger.start/complete/invalidate()` calls |

---

## Redis key layout

```
ledger:{laneId}   Hash   — lane state and metadata
```

No new channels or sorted sets in this slice. TTL: none (cleaned up by supervisor in a later slice).

---

## Verification

```bash
cd /f/ai-workspace/projects/openclaw-coordination-hub
npm test
```

Required:
- All existing tests pass
- All new ledger tests pass
- `validateCompletion()` rejects missing `commitHash`, empty `changedFiles`, no `verification`
- `validateCompletion()` accepts a properly-formed done payload

---

## Follow-up slices (tracked separately)

- **Slice 2:** `src/preflight-gate.js` — repo visibility, required files, write access checks; wired into sprint worker pre-execution
- **Slice 3:** TTL watchdog + escalation — lease watchdog in BaseWorker, escalation event publishing on stall/invalid

---

## Exit criteria for this slice

- [ ] `src/execution-ledger.js` implemented and tested
- [ ] `validateCompletion()` added to `src/validation.js` and tested
- [ ] `hub-task.js` wires ledger creation
- [ ] `hub-sprint-worker.js` wires ledger transitions
- [ ] `npm test` passes (100%)
- [ ] PR merged to `main`
