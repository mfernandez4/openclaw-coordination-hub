# OpenClaw ↔ Coordination Hub Tool Contract (v1)

**Date:** 2026-04-05  
**Status:** Draft / implementation-ready  
**Decision:** Async-first with hybrid UX (`wait_ms` optional fast-path)

---

## Goals

- Add a plugin tool boundary in OpenClaw (`dispatch_task`) to enqueue work into Coordination Hub.
- Preserve non-blocking UX by default.
- Support short synchronous waits for quick tasks.
- Use deterministic task correlation (`id` + `taskId` aligned).

---

## Tool: `dispatch_task`

### Parameters JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "dispatch_task.parameters",
  "type": "object",
  "additionalProperties": false,
  "required": ["task_type", "payload"],
  "properties": {
    "task_type": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,63}$",
      "examples": ["coding", "github-ops", "research", "dev-ops"]
    },
    "payload": {
      "type": "object",
      "description": "Task-specific payload for worker"
    },
    "task_summary": {
      "type": "string",
      "maxLength": 500,
      "description": "Human-readable summary (maps to task.task)"
    },
    "priority": {
      "type": "string",
      "enum": ["high", "normal", "low"],
      "default": "normal"
    },
    "routing": {
      "type": "string",
      "enum": ["dispatcher", "direct"],
      "default": "dispatcher"
    },
    "agent_id": {
      "type": "string",
      "description": "Required when routing=direct"
    },
    "orchestrator_id": {
      "type": "string",
      "default": "main"
    },
    "wait_ms": {
      "type": "integer",
      "minimum": 0,
      "maximum": 60000,
      "default": 0
    },
    "idempotency_key": {
      "type": "string",
      "maxLength": 128
    },
    "metadata": {
      "type": "object",
      "additionalProperties": true
    }
  },
  "allOf": [
    {
      "if": { "properties": { "routing": { "const": "direct" } } },
      "then": { "required": ["agent_id"] }
    }
  ]
}
```

### Response JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "dispatch_task.response",
  "type": "object",
  "additionalProperties": false,
  "required": ["ok", "task_id", "status", "accepted_at"],
  "properties": {
    "ok": { "type": "boolean" },
    "task_id": { "type": "string" },
    "status": {
      "type": "string",
      "enum": ["queued", "completed", "failed", "dead_lettered", "timeout_waiting"]
    },
    "accepted_at": { "type": "string", "format": "date-time" },
    "queue_key": { "type": "string" },
    "result": { "type": ["object", "null"] },
    "next_poll_after_ms": { "type": "integer" }
  }
}
```

---

## Tool: `get_task_result`

### Parameters JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "get_task_result.parameters",
  "type": "object",
  "additionalProperties": false,
  "required": ["task_id"],
  "properties": {
    "task_id": { "type": "string" },
    "orchestrator_id": { "type": "string", "default": "main" },
    "wait_ms": { "type": "integer", "minimum": 0, "maximum": 60000, "default": 0 },
    "poll_interval_ms": { "type": "integer", "minimum": 100, "maximum": 5000, "default": 500 },
    "include_formatted": { "type": "boolean", "default": true }
  }
}
```

### Response JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "get_task_result.response",
  "type": "object",
  "additionalProperties": false,
  "required": ["ok", "task_id", "status"],
  "properties": {
    "ok": { "type": "boolean" },
    "task_id": { "type": "string" },
    "status": {
      "type": "string",
      "enum": ["queued", "completed", "failed", "dead_lettered", "blocked", "not_found", "timeout_waiting"]
    },
    "raw": { "type": ["object", "null"] },
    "formatted": { "type": ["string", "null"] },
    "found_in": {
      "type": ["string", "null"],
      "enum": [null, "audit_key", "results_list"]
    }
  }
}
```

---

## Enqueued Task Envelope Contract

```json
{
  "id": "task:1712345678901:ab12cd34",
  "taskId": "task:1712345678901:ab12cd34",
  "task": "short human summary",
  "type": "coding",
  "priority": "normal",
  "status": "pending",
  "orchestratorId": "main",
  "payload": {},
  "metadata": {},
  "createdAt": "2026-04-05T19:23:00.000Z",
  "source": "openclaw.dispatch_task.v1"
}
```

> **Critical:** set `id` and `taskId` to the same value.

---

## Result Key Contract (Redis)

### Existing keys (use now)

- `coordination:tasks:{high|normal|low}` (LIST)
- `a2a:inbox:{agentId}` (LIST)
- `a2a:results:{orchestratorId}` (PUB/SUB)
- `a2a:results:{orchestratorId}:list` (LIST)
- `a2a:audit:{taskId}` (STRING, TTL 24h)

### Recommended plugin-owned status key

- `a2a:task:{taskId}` (HASH, TTL 7d), fields:
  - `status`
  - `createdAt`
  - `updatedAt`
  - `queueKey`
  - `orchestratorId`
  - `taskType`
  - `idempotencyKey` (optional)
  - `resultRef` (e.g., `a2a:audit:{taskId}`)

---

## Lookup Order (`get_task_result`)

1. Check `a2a:task:{taskId}` (fast status)
2. Check `a2a:audit:{taskId}` (authoritative terminal)
3. Fallback scan `a2a:results:{orchestratorId}:list`
4. If `wait_ms > 0`, poll with `poll_interval_ms` until timeout

---

## Hybrid Behavior

For `dispatch_task(wait_ms > 0)`:

- Always enqueue first.
- Do bounded internal wait.
- If terminal result arrives in-window, return terminal status + result.
- Else return `queued` + `next_poll_after_ms`.

---

## Implementation Notes

- For dispatcher routing, `task_type` must map to worker queues (`coding`, `github-ops`, `research`, `dev-ops`).
- Prefer async-first for long tasks; use short waits only for quick operations.
- Treat pub/sub channels as ephemeral; use audit/list/status keys for durable retrieval.
