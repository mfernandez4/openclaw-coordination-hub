# Coordination Hub — Roadmap

_Last updated: 2026-04-07_
_Status: Active development_

---

## Vision

The coordination hub is the orchestration nervous system for OpenClaw multi-agent workflows. It moves beyond single-task dispatch into **collaborative sprint execution** — multiple agents working in parallel, aware of shared context, able to debate and resolve differences autonomously.

---

## Current State

### What's working (v1 — shipped 2026-04-06)

- [x] `dispatch_task` / `get_task_result` plugin tools
- [x] 5 typed workers: sprint, coding, github-ops, research, dev-ops
- [x] Redis-backed task queue with typed inboxes
- [x] Result processor with audit logging
- [x] Worker self-healing via pending-key TTL + supervisor
- [x] 50/50 task reliability with 0 failures
- [x] Chaos-tested crash recovery (Issue #29 resolved)
- [x] Sprint worker crash recovery verified

### Operational gaps

- [ ] No systemd/init supervision — workers don't auto-restart on host reboot
- [ ] No sprint-scoped dispatch (tasks are independent, no dependency graph)
- [ ] No cross-agent awareness (each agent only sees its own task)
- [ ] No collaborative resolution (agents don't debate or reach consensus)

---

## Sprint Collaboration Architecture (v2)

### Problem Statement

Currently, agents operate in isolation. Dispatch a task → agent does it → done. Real sprints require:

- Parallel workstreams with known dependencies
- Agents aware of what other agents are doing
- Shared context across the sprint
- Consensus or escalation when findings conflict

### Proposed Capabilities

#### 1. Sprint-Scoped Dispatch

Tasks are tagged with sprint metadata:

```
task = {
  sprint_id: "sprint-2026-W15-pr46-hardening",
  epic: "CI gate reliability",
  depends_on: ["task-id-of-prereq"],   // optional
  priority: "high",
  context: {
    pr: "mfernandez4/openclaw#46",
    goal: "harden CI gate before merge"
  }
}
```

Inbox key remains `a2a:inbox:{agent}` but task payload carries sprint context.

#### 2. Dependency-Aware Routing

**Dispatch rule:** A task with `depends_on` is held in a `sprint:blocked:{taskId}` Redis key until all dependencies are `completed` or `failed`.

```
dispatch_task(task):
  if task.depends_on:
    for dep in task.depends_on:
      if get_task_result(dep).status != 'completed':
        redis.set(sprint:blocked:{task.id}, JSON.stringify(task), 'EX', 3600)
        return { status: 'blocked', blocking: dep }
  # All deps met — dispatch normally
  redis.rpush(a2a:inbox:{task.agent}, task)
```

A background **dependency watcher** polls `sprint:blocked:*` keys and re-dispatches when prereqs complete.

#### 3. Sprint State Store

Redis hashes for sprint-level state:

```
sprint:{sprintId}:meta        — { name, epic, status, startedAt, owner }
sprint:{sprintId}:tasks      — { taskId -> status } hash
sprint:{sprintId}:findings    — list of agent findings/recommendations
sprint:{sprintId}:resolution  — final synthesis when sprint completes
```

Status transitions: `planning → running → blocked → review → approved|rejected|escalated`

#### 4. Cross-Agent Awareness

Agents read sprint context before and during task execution:

```javascript
// At task start
const sprintMeta = await redis.hgetall(`sprint:${task.sprintId}:meta`);
const otherFindings = await redis.lrange(`sprint:${task.sprintId}:findings`, 0, -1);
const taskGraph = await redis.hgetall(`sprint:${task.sprintId}:tasks`);
```

Agents can write findings to the sprint store and read what other agents found.

#### 5. Collaborative Resolution

After parallel agents complete, a **synthesizer agent** (github-ops or dedicated) reads all findings and produces a sprint resolution:

```
Sprint Resolution {
  sprintId, epic,
  findings: [ { agent, task, result, verdict } ],
  synthesis: "PR #46 is APPROVED with 3 suggestions...",
  decision: "approved | rejected | needs-human | needs-rework",
  blockers: [ ... ],
  next_steps: [ ... ]
}
```

If verdicts conflict, the synthesizer flags the conflict and proposes resolution.

---

## Implementation Phases

### Phase 1 — Sprint Dispatch (minimal)
- [ ] Extend task payload schema to include `sprint_id`, `epic`, `depends_on`, `context`
- [ ] Add `sprint:blocked:{taskId}` Redis keys with TTL
- [ ] Add dependency-check in dispatch path (or as pre-check tool)
- [ ] Add dependency watcher (cron or Redis keyspace notifications)
- [ ] Sprint state Redis hashes: `sprint:{id}:meta`, `sprint:{id}:tasks`
- [ ] Test with PR #46 mini-sprint (3 agents + 1 synthesizer)

### Phase 2 — Cross-Agent Awareness
- [ ] Sprint context reader tool (`sprint_status`)
- [ ] Sprint findings writer tool (`sprint_add_finding`)
- [ ] Sprint findings reader (`sprint_get_findings`)
- [ ] Agents read other agents' findings before posting
- [ ] Test: parallel review of PR #46, agents cite each other's findings

### Phase 3 — Collaborative Resolution
- [ ] Synthesizer agent task type
- [ ] Conflict detection (contradicting findings)
- [ ] Resolution store: approved / rejected / escalated
- [ ] Human escalation trigger
- [ ] Test: full PR #46 sprint with approval flow

### Phase 4 — Supervisor Integration
- [ ] Sprint supervisor: monitors sprint-level health
- [ ] Auto-escalate if sprint blocked > N minutes
- [ ] Sprint-level metrics: total time, agent utilization, blocked time
- [ ] Integration with existing hub-sprint-supervisor

### Phase 5 — Production Hardening
- [ ] Systemd unit files for all workers + supervisor
- [ ] Host-level restart on boot
- [ ] Sprint archival (completed sprints → JSON blob in Redis)
- [ ] Sprint replay (re-run a sprint from archived state)

---

## Active Sprints

### sprint-2026-W15-pr46-hardening
**Epic:** CI gate reliability  
**Goal:** Ship PR #46 (add production-style CI checks on PRs/pushes to main)  
**Status:** `running`  
**Agents:** github-ops (security review), coding (test gaps), research (benchmark check)  
**Dependency graph:**
```
A: github-ops review → [approval]
B: coding test gaps  → [approval]
C: research benchmark → [approval]
D: github-ops synthesize → [approved|rejected]
```

### sprint-2026-W15-memoryv1-path1
**Epic:** memory-system-v1 Path 1 shipping  
**Goal:** Complete remaining checklist items for commercial launch  
**Status:** `planning`

### sprint-2026-W15-orchestrator-cleanup
**Epic:** orchestrator-first audit closeout  
**Goal:** Close PRs #21, #22, #35  
**Status:** `planning`

---

## Open Issues

| # | Title | Priority | Phase |
|---|-------|----------|-------|
| #29 | LPOP self-healing | P0 ✅ Resolved | v1 |
| #30 | Sprint-scoped dispatch | P1 | Phase 1 |
| #31 | Cross-agent awareness | P1 | Phase 2 |
| #32 | Collaborative resolution | P1 | Phase 3 |
| #33 | systemd supervision | P2 | Phase 5 |
| #34 | Sprint archival | P2 | Phase 5 |

---

## References

- Finish plan: `docs/COORDINATION_HUB_TOOL_FINISH_PLAN.md`
- Tool contract: `docs/OPENCLAW_DISPATCH_TASK_TOOL_CONTRACT.md`
- Status: `reports/coordination-hub-tool/STATUS.md`
- Incidents: `reports/coordination-hub-tool/INCIDENTS.md`
