# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                             # unit tests — no Redis required, fast
npm run test:integration                             # integration tests — requires live Redis
npm run test:coverage                                # unit tests + v8 coverage report
npx vitest run test/unit/<file>.test.js              # single test file

docker exec openclaw-coordination-hub npm test       # preferred in dev (runs inside the container)

npm start                                            # start the hub (requires Redis)
```

Environment for integration tests: `REDIS_HOST` (default `redis`) and `REDIS_PORT` (default `6379`).

## Architecture

### Task flow

Tasks move through four stages, each implemented in a separate file:

1. **Enqueue** — `scripts/hub-task.js` (or `src/task-queue.js`) LPUSHes to `coordination:tasks:{high,normal,low}`
2. **Dispatch** — `src/dispatcher.js` BRPOPs from those priority queues, routes by `task.type` → RPUSHes to `a2a:inbox:{agentId}` (RPUSH+BLPOP = FIFO)
3. **Process** — workers (`workers/*.js`) BLPOP their inbox, call `processTask()`, publish result JSON to `a2a:coordination` pub/sub
4. **Handle results** — `src/result-processor.js` subscribes to `a2a:coordination`, applies policies from `config/result-policies.json`, re-publishes to `a2a:results:main`

### Worker pattern

All specialist workers extend `BaseWorker` (`workers/base-worker.js`). Subclasses override:
- `processTask(payload)` — task handler
- `getCapabilities()` — list of task types this worker handles

For unit tests, inject Redis and SharedStore via constructor options to avoid live connections:
```js
new SomeWorker('agent-id', { redis: mockRedis, artifactStore: mockSharedStore })
```

### Agent registry & liveness

Two Redis structures work together (spans `workers/base-worker.js` ↔ `src/a2a-adapter.js`):

| Key | Type | Purpose |
|-----|------|---------|
| `a2a:registry` | Hash | `agentId → {status, capabilities, lastSeen, startedAt}` |
| `a2a:registry:{agentId}:ttl` | Key | TTL sentinel; expires at `heartbeatInterval × 3` seconds |

Both are written by `BaseWorker.register()` and refreshed on every `sendHeartbeat()` tick. When an agent stops, its sentinel expires and `lastSeen` goes stale. `A2AAdapter.syncRegistryFromRedis()` batch-checks all sentinels via MGET and prunes hash fields where the sentinel is gone **and** `lastSeen` exceeds `staleAgentMs` (default 90 000 ms, configurable via constructor option). The hub never prunes itself — it has no sentinel.

### A2A pub/sub channels

| Channel | Transport | Usage |
|---------|-----------|-------|
| `a2a:agents` | pub/sub | Broadcast (to=`*`) |
| `a2a:coordination` | pub/sub | Peer negotiation + worker results |
| `a2a:inbox:{agentId}` | Redis list | Directed task delivery |
| `a2a:heartbeats` | pub/sub | Worker heartbeats |

### Optional memory layer

`src/mem0-adapter.js` wraps an external Mem0 service (opt-in: `MEM0_ENABLED=true`). When disabled or unreachable it falls back to `src/memory-bridge.js`, which appends events to `openclaw-memory-system-v1/journal.jsonl`.

### Shared artifacts

`src/shared-store.js` (`SharedStore`) is the cross-agent artifact layer used by all workers. It extends `ArtifactStore` with two additions:

- **`find(query)`** — scan manifests and filter by `{ agentId, tags, taskId, type, filename }`
- **`artifact_ready` notifications** — on every `writeArtifact()` call, publishes `{ type: 'artifact_ready', artifactId, agentId, filename, tags, taskId }` to the `a2a:agents` broadcast channel (fire-and-forget; requires Redis to be injected via `store.redis = this.redis` after `connect()`)

`A2AAdapter` handles `artifact_ready` messages in `handleBroadcast()` and re-emits them as an `'artifact_ready'` Node.js event for hub/worker subscribers.

Artifacts are stored under `shared/artifacts/` (configurable via `SHARED_ARTIFACT_PATH` env var). Each artifact gets its own directory: `{basePath}/{artifactId}/manifest.json` + the content file.
