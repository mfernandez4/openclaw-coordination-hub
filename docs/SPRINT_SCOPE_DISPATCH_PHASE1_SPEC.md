# Sprint-Scoped Dispatch — Phase 1 Spec

_Draft v0.1 | 2026-04-08_

---

## Context

Current coordination-hub dispatches tasks independently. Sprint-scoped dispatch adds:
- Sprint metadata (sprint_id, epic, goal)
- Dependency tracking (depends_on)
- Sprint-level state store
- Dependency-aware routing

---

## Task Payload Schema Extension

```typescript
interface SprintTask extends BaseTask {
  // Sprint identity
  sprintId: string;        // e.g. "sprint-2026-W15-ci-hardening"
  epic: string;            // e.g. "CI gate reliability"
  goal: string;             // Human-readable goal statement

  // Dependency graph
  dependsOn?: string[];     // Task IDs that must complete first

  // Sprint context (readable by agents)
  context: {
    repo?: string;          // GitHub repo if applicable
    pr?: string;            // PR number if applicable
    owner?: string;         // Human owner
    [key: string]: any;     // Arbitrary context
  };

  // Routing (existing fields unchanged)
  inbox: string;
  task: string;
  priority: 'low' | 'normal' | 'high';
}
```

---

## Dependency-Aware Dispatch

### Blocked Key Pattern

When a task has `depends_on`, it is NOT dispatched immediately. Instead:

```
dispatch_task(task):
  if task.dependsOn?.length > 0:
    blockers = []
    for depId in task.dependsOn:
      depResult = get_task_result(depId)
      if depResult.status !== 'completed':
        blockers.push({ depId, status: depResult.status })
    
    if blockers.length > 0:
      # Task is blocked — store in Redis, don't dispatch
      redis.set(
        sprint:blocked:{task.id},
        JSON.stringify({ task, blockers, blockedAt: now }),
        'EX', 86400  # 24h TTL
      )
      return { status: 'blocked', blockers }

  # All deps met — dispatch normally
  redis.rpush(inbox(task.agent), task)
  return { status: 'dispatched', taskId: task.id }
```

### Dependency Watcher

A cron job (every 5 min) or Redis keyspace notification watches `sprint:blocked:*` and re-checks when dependencies complete:

```
watch_blocked():
  for key in redis.keys('sprint:blocked:*'):
    { task, blockers } = JSON.parse(redis.get(key))
    
    allDone = true
    for depId in task.dependsOn:
      result = get_task_result(depId)
      if result.status !== 'completed':
        allDone = false
        break
    
    if allDone:
      redis.delete(key)
      redis.rpush(inbox(task.agent), task)
```

---

## Sprint State Store

### Redis Keys

```
sprint:{sprintId}:meta        HASH   — sprint metadata
sprint:{sprintId}:tasks       HASH   — taskId → status
sprint:{sprintId}:findings    LIST   — agent findings
sprint:{sprintId}:resolution  STRING — final synthesis (when complete)
sprint:{sprintId}:events      LIST   — audit log of sprint events
```

### Sprint Meta Hash

```
sprint:{sprintId}:meta = {
  name: string,
  epic: string,
  goal: string,
  status: 'planning' | 'running' | 'review' | 'approved' | 'rejected' | 'escalated',
  owner: string,
  createdAt: ISO8601,
  updatedAt: ISO8601,
  taskCount: number,
  completedCount: number,
  failedCount: number
}
```

### Task Status Hash

```
sprint:{sprintId}:tasks = {
  taskId-1: 'pending' | 'blocked' | 'running' | 'completed' | 'failed',
  taskId-2: 'blocked',
  ...
}
```

### Events List

```
sprint:{sprintId}:events = [
  { ts, event: 'created', taskId },
  { ts, event: 'dispatched', taskId },
  { ts, event: 'blocked', taskId, blockers: [...] },
  { ts, event: 'unblocked', taskId },
  { ts, event: 'completed', taskId },
  ...
]
```

---

## Sprint Status Tool

Agents can call `sprint_status(sprintId)` to read sprint context:

```
sprint_status(sprintId):
  meta = redis.hgetall(sprint:{sprintId}:meta)
  tasks = redis.hgetall(sprint:{sprintId}:tasks)
  findings = redis.lrange(sprint:{sprintId}:findings, 0, -1)
  
  return { meta, tasks, findings, 
    taskCount: Object.keys(tasks).length,
    completed: Object.values(tasks).filter(s => s === 'completed').length,
    failed: Object.values(tasks).filter(s => s === 'failed').length
  }
```

---

## Findings Store

Agents write findings during task execution:

```
sprint_add_finding(sprintId, finding):
  redis.lpush(sprint:{sprintId}:findings, JSON.stringify({
    taskId, agent, finding, verdict, ts: now()
  }))
```

---

## Success Criteria

1. Task with `depends_on` is held in `sprint:blocked:{id}` until all deps complete
2. Dependency watcher re-dispatches within 5 minutes of dep completion
3. Sprint state is visible via `sprint_status` tool
4. All sprint events are logged to `sprint:{id}:events`
5. Sprint metadata reflects live task counts

---

## Test Scenario

1. Create sprint: `sprint-2026-W16-test`
2. Dispatch Task A (no deps) → A runs → A completes
3. Dispatch Task B (`depends_on: [A]`) → B is blocked
4. After A completes → B is re-dispatched → B completes
5. Verify: sprint state shows A=completed, B=completed

---

## Out of Scope (Phase 1)

- Synthesizer agent (Phase 3)
- Conflict detection (Phase 3)
- Human escalation (Phase 3)
- Sprint archival (Phase 5)

---

## Open Questions

1. Should blocked tasks show in sprint_status for visibility, or only in `sprint:blocked:*`?
2. What happens if a dependency fails? Should dependent tasks be marked `blocked-by-failure` or auto-cancelled?
3. Should sprint have a max blocked time before auto-escalation?
