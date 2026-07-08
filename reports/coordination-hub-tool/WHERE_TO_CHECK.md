# Where to Check Status (Coordination Hub Tool)

Use these three files as your status dashboard.

## 1) Current state (single source of truth)

`reports/coordination-hub-tool/loop-state.json`

Key fields:
- `status`
- `phase`, `phaseName`
- `phase3.cyclesCompleted`
- `phase3.lastCycleStatus`
- `nextAction`
- `updatedAt`

## 2) Human-readable timeline

`reports/coordination-hub-tool/STATUS.md`

Look for blocks like:
- `### Cycle 1 — ...`
- `### Cycle 2 — ...`
- `### Cycle 3 — ...`

## 3) Raw evidence per cycle

`reports/coordination-hub-tool/phase3-cycle<N>-<timestamp>.json`

Each file contains:
- observe metrics (before/after)
- dispatch+verify probe details
- pass/fail summary

---

## How to know "Phase 3 cycle 3" is done

Cycle 3 is complete when ALL are true:
1. `loop-state.json` has `phase3.cyclesCompleted >= 3`
2. `STATUS.md` includes a `### Cycle 3 —` block
3. A file exists matching `phase3-cycle3-*.json`

Optional confidence check:
- `phase3.lastCycleStatus` is `on-track`

---

## Current quick check commands

```bash
# 1) current phase + cycles
python3 - <<'PY'
import json
p='/f/ai-workspace/projects/openclaw-coordination-hub/reports/coordination-hub-tool/loop-state.json'
j=json.load(open(p))
print('status:',j.get('status'))
print('phase:',j.get('phase'), j.get('phaseName'))
print('cyclesCompleted:',j.get('phase3',{}).get('cyclesCompleted'))
print('lastCycleStatus:',j.get('phase3',{}).get('lastCycleStatus'))
print('updatedAt:',j.get('updatedAt'))
print('nextAction:',j.get('nextAction'))
PY

# 2) latest cycle blocks
 tail -n 80 /f/ai-workspace/projects/openclaw-coordination-hub/reports/coordination-hub-tool/STATUS.md

# 3) list cycle evidence files
ls -1 /f/ai-workspace/projects/openclaw-coordination-hub/reports/coordination-hub-tool/phase3-cycle*.json
```
