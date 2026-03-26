# Coordination Hub — Technical Specification

**Version:** 0.1 (Draft)  
**Date:** 2026-03-08  
**Status:** In progress

---

## 1. Overview

The Coordination Hub provides real-time communication and coordination for OpenClaw sub-agents. It bridges the gap between stateless agent spawning and collaborative multi-agent workflows.

### 1.1 Goals

1. Enable real-time agent-to-agent communication
2. Support structured task workflows across agents
3. Enable modality-agnostic file sharing (A2A protocol)
4. Integrate with memory-system-v1 for persistence

### 1.2 Non-Goals

- Replace MCP (tools) — complements it
- Replace memory-system-v1 — persists to it
- Full agent runtime — runs within OpenClaw

---

## 2. Architecture

### 2.1 Component Overview

| Component | Responsibility | Dependencies |
|-----------|----------------|--------------|
| `RedisPubSub` | Real-time messaging | Redis |
| `TaskQueue` | Workflow management | Redis |
| `A2AAdapter` | Protocol handler | None (stateless) |
| `Mem0Client` | Persistence | Mem0 API or self-hosted |
| `MemoryBridge` | Write to memory-system-v1 | File system |

### 2.2 Data Flow

```
Main Agent
    │
    ├──► Spawns Sub-Agent A ──► Redis: Agent Status (online)
    │                              │
    │                              ├──► Publishes task to TaskQueue
    │                              │
    │                              ├──► Sub-Agent B subscribes
    │                              │
    │                              ├──► A2A: Share file/result
    │                              │
    │                              ├──► Mem0: Persist interaction
    │                              │
    │                              └──► MemoryBridge: Write to memory-system-v1
    │
    └──► Coordinates via Pub/Sub events
```

---

## 3. Redis Pub/Sub Layer

### 3.1 Agent Status

Stored in Redis hashes with TTL:

```
Key: agents:status:<agent-id>
Fields:
  - status: "online" | "busy" | "idle" | "error"
  - last_updated: ISO timestamp
  - active_tasks: JSON array
  - metadata: JSON object
TTL: 300 seconds (auto-refresh)
```

### 3.2 Channels

| Channel | Purpose | Payload |
|---------|---------|---------|
| `agents:events` | Status changes | `{ agent_id, status, timestamp }` |
| `tasks:events` | Task lifecycle | `{ task_id, status, assignee }` |
| `workflows:events` | Workflow progress | `{ workflow_id, progress, stage }` |

### 3.3 Commands

```javascript
// Publish status change
redis.publish('agents:events', JSON.stringify({
  agent_id: 'research-001',
  status: 'busy',
  timestamp: new Date().toISOString()
}))

// Subscribe
subscribe('agents:events', callback)
```

---

## 4. Task Queue

### 4.1 Task Schema

```json
{
  "id": "task-<uuid>",
  "type": "research | github-ops | exec | custom",
  "status": "pending | running | completed | failed",
  "assigned_to": "agent-id",
  "depends_on": ["task-id-1", "task-id-2"],
  "payload": {
    "query": "...",
    "context": {}
  },
  "result": null,
  "error": null,
  "created_at": "ISO timestamp",
  "updated_at": "ISO timestamp"
}
```

### 4.2 Queue Operations

- `LPUSH tasks:queue:<priority> <task-json>` — Enqueue
- `RPOP tasks:queue:<priority>` — Dequeue
- `LRANGE tasks:queue:<priority> 0 -1` — Peek

### 4.3 Workflow Orchestration

Supported patterns:
- **Sequential**: Task B depends on Task A
- **Parallel**: Task A and B run concurrently
- **Conditional**: Task C runs if Task A succeeds

---

## 5. A2A Protocol Adapter

### 5.1 What is A2A?

[Agent-to-Agent (A2A)](https://github.com/google/a2a-python) is Google's protocol for inter-agent communication, supporting:
- JSON-RPC messaging
- Any file format (images, code, documents)
- Streaming responses
- Authentication

### 5.2 Integration

The A2A Adapter provides:
- `send_message(agent_id, message, files[]) -> response`
- `stream_message(agent_id, message, files[]) -> AsyncIterator`
- `subscribe(agent_id, callback)`

### 5.3 Message Format

```json
{
  "jsonrpc": "2.0",
  "id": "msg-<uuid>",
  "method": "tasks/send",
  "params": {
    "message": {
      "role": "agent",
      "parts": [
        { "type": "text", "text": "Analysis complete" },
        { "type": "file", "file": { "uri": "blob://...", "mime": "image/png" } }
      ]
    },
    "taskId": "task-<uuid>"
  }
}
```

---

## 6. Mem0 Integration

### 6.2 Integration Points

```javascript
// After task completion
mem0.add({
  messages: [
    { role: "user", content: "Research the bug" },
    { role: "assistant", content: "Found issue in line 42" }
  ],
  user_id: "session-<id>",
  agent_id: "research-001"
})

// Before task start (context injection)
const context = mem0.search({
  query: "previous bug research",
  user_id: "session-<id>"
})
```

### 6.3 Configuration

```json
{
  "mem0": {
    "provider": "self-hosted | hosted",
    "url": "http://localhost:8000",
    "api_key": "optional for hosted"
  }
}
```

---

## 7. Memory-System-V1 Bridge

The Coordination Hub writes to memory-system-v1 for:
- Nightly review consolidation
- Long-term memory promotion
- Graph mirror updates

### 7.1 Write Contract

```javascript
// After significant agent interaction
memoryBridge.write({
  trace_id: "coord-hub-<uuid>",
  block: {
    content: "Agent research-001 completed bug analysis",
    tags: ["coordination", "research", "bug"],
    priority: "normal"
  }
})
```

---

## 8. Deployment

### 8.1 Requirements

- Redis (6+) — for pub/sub and task queues
- Node.js (20+) — runtime
- Optional: Mem0 (self-hosted or hosted)

### 8.2 Environment

```env
REDIS_HOST=localhost
REDIS_PORT=6379
MEM0_PROVIDER=self-hosted
MEM0_URL=http://localhost:8000
MEMORY_SYSTEM_V1_PATH=/path/to/memory-system-v1
```

---

## 9. Open Questions

- [ ] How does coordination hub discover available agents?
- [ ] What is the retry policy for failed tasks?
- [ ] How do we handle agent crashes during workflow?
- [ ] Do we need authentication between agents?

---

## 10. References

- [gsornsen/mycelium](https://github.com/gsornsen/mycelium) — Architecture reference
- [Google A2A Protocol](https://github.com/google/a2a-python)
- [Mem0](https://github.com/mem0ai/mem0)
- [openclaw-memory-system-v1](https://github.com/k2so-bot/openclaw-memory-system-v1)
