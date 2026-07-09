# Coordination Hub Tool — Orchestration Template

Use this template for **any autonomous task loop** to produce consistent, auditable results.

---

## 1) Mission Definition

- **Mission ID:** `<mission-id>`
- **Primary goal:** `<single measurable goal>`
- **Scope in:** `<explicit>`
- **Scope out:** `<explicit>`
- **Owner/orchestrator:** `<agent/session>`
- **Start time (UTC):** `<timestamp>`

### Success criteria (must be measurable)

1. `<criterion 1>`
2. `<criterion 2>`
3. `<criterion 3>`

### Stop criteria (hard stop)

- Mission complete (all success criteria true)
- Mission blocked + escalation trigger hit
- Safety gate violation

---

## 2) Safety & Policy Gate (pre-flight)

- [ ] No destructive actions planned by default
- [ ] Rollback path identified
- [ ] Data safety checks complete
- [ ] Human escalation path defined

### Escalation triggers

- repeated same error signature >= 3
- queue backlog increases for >= 3 cycles
- infrastructure unavailable beyond threshold
- destructive action required but not approved

---

## 3) Inputs / Outputs Contract

### Inputs

```json
{
  "task_type": "<coding|github-ops|research|dev-ops>",
  "payload": {},
  "priority": "<high|normal|low>",
  "routing": "<dispatcher|direct>",
  "wait_ms": 0
}
```

### Expected outputs

```json
{
  "ok": true,
  "task_id": "task:...",
  "status": "<queued|completed|failed|dead_lettered|timeout_waiting>",
  "result": null
}
```

---

## 4) Autonomous Loop (repeat every N minutes)

**Cadence:** `<10-15 min>`

### Step A — Observe

Capture:
- queue depth
- in-flight tasks
- stuck tasks (age threshold)
- error signatures
- completion ratio

### Step B — Decide

Choose one:
- dispatch next task
- retry failed task
- patch/fix issue
- pause and escalate

### Step C — Act

- call `dispatch_task`
- if needed call `get_task_result`
- apply bounded retries

### Step D — Verify

- did status reach terminal?
- does result satisfy acceptance checks?
- does telemetry improve?

### Step E — Document

- append status snapshot
- append incident/fix note if failure
- update loop state

---

## 5) Retry/Fix Strategy

### Retry matrix

- **Transient** -> retry with backoff: 30s, 2m, 5m (max 3)
- **Deterministic/schema** -> fix now, no blind retry
- **Unknown** -> 1 probe retry then classify

### Fix protocol

1. isolate failing component
2. implement minimal fix
3. re-run focused test
4. update docs/checklist

---

## 6) Human Intervention Protocol

Escalate only when triggered:

- **Reason:** `<trigger>`
- **Context:** `<what was attempted>`
- **Proposed options:**
  1. `<safe option>`
  2. `<faster/riskier option>`
- **Recommended next step:** `<single recommendation>`

---

## 7) Restart Guard (mandatory before gateway restart)

Run all checks:
- [ ] sessions query: no critical active sessions
- [ ] subagents query: no critical active subagents
- [ ] process query: no critical active jobs
- [ ] queue check: no high-risk in-flight tasks

If any check fails -> `restart_deferred` and schedule re-check.

---

## 8) Reporting Block (per cycle)

```markdown
### Cycle <n> — <UTC timestamp>
- Goal state: <on-track|blocked|complete>
- Action taken: <dispatch|retry|fix|escalate>
- Result: <status>
- Key metrics: <queue depth, completion ratio, stuck count>
- Next action: <single next step>
```

---

## 9) Finalization Checklist

- [ ] All success criteria met
- [ ] Stop criteria reached by completion (not timeout)
- [ ] Incidents documented
- [ ] Runbook/checklist updated
- [ ] Handoff summary generated

### Final summary template

```markdown
## Mission Complete: <mission-id>
- Outcome: <success|partial|failed>
- Evidence: <tests/results links>
- Reliability: <metrics>
- Safety incidents: <count>
- Lessons learned: <top 3>
- Follow-ups: <if any>
```
