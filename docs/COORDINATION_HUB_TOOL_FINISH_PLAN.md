# Coordination Hub Tool — Finish Plan

**Date:** 2026-04-05  
**Scope:** `~/.openclaw/extensions/coordination-hub-tool` + hub integration checks  
**Execution mode:** Async-first, hybrid UX (`wait_ms` optional)

---

## Objective

Ship a stable OpenClaw plugin (`dispatch_task`, `get_task_result`) that can run autonomous coordination loops safely, with deterministic stop criteria and clear human escalation.

---

## Non-Negotiables

1. **Safety first**: no destructive actions by default.
2. **Autonomous by default**: retry/fix/document loop handles normal failures.
3. **Human intervention only when stuck**.
4. **No blind restarts**: query active sessions/jobs before gateway restart.
5. **Deterministic completion**: explicit finish criteria and stop conditions.

---

## Phases

## Phase 1 — Plugin MVP completion (START NOW)

### Required outcomes

- `dispatch_task` and `get_task_result` tool contracts aligned to v1 spec.
- Deterministic task correlation (`id === taskId`).
- Stable status path:
  - enqueue -> `a2a:task:{taskId}` status hash
  - terminal result lookup (`a2a:audit:{taskId}` first)
- Idempotency is functional and returns current status/result when available.

### Implementation checklist

- [ ] Validate routing mode constraints (`direct` requires `agent_id`).
- [ ] Enforce known dispatcher task types for `routing=dispatcher`.
- [ ] Write plugin-owned status hash on enqueue (`queued`).
- [ ] On terminal lookup, update status hash (`completed|failed|dead_lettered|blocked`) with `updatedAt` and `resultRef`.
- [ ] Improve idempotency path to return existing terminal state (not always `queued`).
- [ ] Ensure `wait_ms` path returns terminal result payload when available.

### Phase 1 verification

- [ ] Async enqueue returns `queued` + `task_id`.
- [ ] Invalid type dead-letters correctly.
- [ ] `get_task_result` resolves terminal state via audit key.
- [ ] `wait_ms` returns `timeout_waiting` for long tasks.

---

## Phase 2 — Integration matrix

Run controlled test matrix against live hub:

- [ ] dispatcher route: `coding`, `github-ops`, `research`, `dev-ops`
- [ ] direct route: `a2a:inbox:{agentId}`
- [ ] async path (`wait_ms=0`)
- [ ] hybrid path (`wait_ms>0`)
- [ ] idempotency replay
- [ ] results list fallback when audit missing

Pass condition: all matrix cases green and no correlation drift.

---

## Phase 3 — Autonomous heartbeat orchestration loop

Run orchestrator loop every 10–15 minutes:

1. Observe queue/task health
2. Decide next action
3. Dispatch work
4. Verify outcomes
5. Retry/fix/document
6. Re-evaluate stop criteria

Heartbeat metrics:
- queue depth by priority
- stuck tasks count and age
- error/failure rate
- retry count
- completion ratio

---

## Phase 4 — Self-improvement and resilience

### Retry policy
- Transient failures: up to 3 retries with backoff (30s, 2m, 5m)
- Deterministic/schema failures: patch, do not blind-retry
- Same signature x3 => escalate

### Documentation policy
Every failure requires:
- incident entry
- fix summary
- checklist/runbook update

---

## Finish Goal (stop criteria)

Stop execution and mark `FINISHED` only when all are true:

1. Functional correctness: tool matrix passes.
2. Reliability: >=95% success over 50 dispatched tasks.
3. Safety: zero unintended destructive ops.
4. Observability: status + incidents + runbook updated.
5. Autonomy: common failures self-corrected without human.
6. Handoff quality: clear operate/troubleshoot/rollback docs.

---

## Human Intervention Triggers (final resort)

Escalate if any trigger occurs:

- same failure signature repeated 3 times after fix attempts
- queue backlog growing for >3 heartbeat cycles
- Redis unavailable >15 min
- task correlation inconsistency
- requested step requires destructive change or uncertain impact

---

## Gateway Restart Safety Gate

Before any gateway restart, run and confirm all are safe:

1. `sessions_list` -> no critical active sessions
2. `subagents list` -> no critical active subagents
3. `process list` -> no active critical exec jobs
4. Queue/in-flight check -> no high-risk running tasks

If unsafe:
- mark `restart_deferred`
- log reason
- retry gate check later

---

## Operational artifacts

- Plan: `docs/COORDINATION_HUB_TOOL_FINISH_PLAN.md`
- Orchestration template: `template/COORDINATION_HUB_TOOL_ORCHESTRATION_TEMPLATE.md`
- Runtime state: `reports/coordination-hub-tool/loop-state.json`
- Incidents: `reports/coordination-hub-tool/INCIDENTS.md`
- Status snapshots: `reports/coordination-hub-tool/STATUS.md`
