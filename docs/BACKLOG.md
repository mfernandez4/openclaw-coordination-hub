# Coordination Hub Backlog

## Completed

### `shared/` — Cross-agent artifact sharing
**Status:** Done (introduced in PR #52)

`SharedStore` (`src/shared-store.js`) extends `ArtifactStore` with:
- `find({ agentId, tags, taskId, type, filename })` — query-based artifact discovery
- Redis pub/sub notification (`artifact_ready` → `a2a:agents`) on every write
- `A2AAdapter` handles `artifact_ready` and emits it as a Node.js event

Workers use `this.artifacts` (a `SharedStore` instance). Redis is wired in automatically after `connect()`.

## Pending

_No items currently pending._
