#!/bin/bash
# Phase 4: Cycles 7-13 (7 cycles × 2 probes = 14 tasks)
# Pattern: github-ops/dispatcher + coding/direct | research/dispatcher + dev-ops/direct (alternating)

HUB="/f/ai-workspace/projects/openclaw-coordination-hub"
cd "$HUB"

dispatch_and_wait() {
  local label=$1
  local type=$2
  local task=$3
  echo "[DISPATCH] $label -> type=$type task='$task'"
  result=$(node scripts/hub-task.js --task "$task" --type "$type" 2>&1)
  echo "$result"
  taskId=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('taskId',''))" 2>/dev/null)
  if [ -z "$taskId" ]; then
    echo "[DISPATCH FAIL] Could not extract taskId for $label"
    echo "$result"
    return 1
  fi
  echo "[WAIT] $label taskId=$taskId"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    status=$(node scripts/hub-task.js task_result "$taskId" wait_ms=3000 2>&1)
    echo "$status"
    if echo "$status" | grep -q '"status":"completed"'; then
      echo "[PASS] $label completed"
      return 0
    fi
    if echo "$status" | grep -q '"status":"timeout_waiting"'; then
      echo "[RETRY] $label timed out, retrying..."
      sleep 2
      status=$(node scripts/hub-task.js task_result "$taskId" wait_ms=3000 2>&1)
      echo "$status"
      if echo "$status" | grep -q '"status":"completed"'; then
        echo "[PASS] $label completed on retry"
        return 0
      fi
      echo "[FAIL] $label still timed out after retry"
      return 1
    fi
  done
  echo "[FAIL] $label never reached terminal state"
  return 1
}

direct_and_wait() {
  local label=$1
  local agent=$2
  local task=$3
  echo "[DIRECT] $label -> agent=$agent task='$task'"
  result=$(node scripts/hub-task.js --task "$task" --agent "$agent" 2>&1)
  echo "$result"
  taskId=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('taskId',''))" 2>/dev/null)
  if [ -z "$taskId" ]; then
    echo "[DISPATCH FAIL] Could not extract taskId for $label"
    echo "$result"
    return 1
  fi
  echo "[WAIT] $label taskId=$taskId"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    status=$(node scripts/hub-task.js task_result "$taskId" wait_ms=3000 2>&1)
    echo "$status"
    if echo "$status" | grep -q '"status":"completed"'; then
      echo "[PASS] $label completed"
      return 0
    fi
    if echo "$status" | grep -q '"status":"timeout_waiting"'; then
      echo "[RETRY] $label timed out, retrying..."
      sleep 2
      status=$(node scripts/hub-task.js task_result "$taskId" wait_ms=3000 2>&1)
      echo "$status"
      if echo "$status" | grep -q '"status":"completed"'; then
        echo "[PASS] $label completed on retry"
        return 0
      fi
      echo "[FAIL] $label still timed out after retry"
      return 1
    fi
  done
  echo "[FAIL] $label never reached terminal state"
  return 1
}

REPORTS="$HUB/reports/coordination-hub-tool"
mkdir -p "$REPORTS"

echo "=============================================="
echo "PHASE 4 CYCLE SCRIPT — Starting cycles 7-13"
echo "=============================================="

# Cycle 7: github-ops/dispatcher + coding/direct
# Cycle 8: research/dispatcher + dev-ops/direct
# Cycle 9: github-ops/dispatcher + coding/direct
# Cycle 10: research/dispatcher + dev-ops/direct
# Cycle 11: github-ops/dispatcher + coding/direct
# Cycle 12: research/dispatcher + dev-ops/direct
# Cycle 13: github-ops/dispatcher + coding/direct

cycle=7
while [ $cycle -le 13 ]; do
  TS=$(date +%Y-%m-%dT%H-%M-%S)
  echo ""
  echo "===== CYCLE $cycle ====="
  
  if [ $((cycle % 2)) -eq 1 ]; then
    # Odd cycles: github-ops/dispatcher + coding/direct
    dispatch_and_wait "github-ops-list-prs" "github-ops" "list-prs"
    r1=$?
    direct_and_wait "coding-list-files" "coding" "list-files"
    r2=$?
  else
    # Even cycles: research/dispatcher + dev-ops/direct
    dispatch_and_wait "research-list-files" "research" "list-files"
    r1=$?
    direct_and_wait "devops-status" "dev-ops" "status"
    r2=$?
  fi
  
  probes_pass=$((2 - r1 - r2))
  probes_fail=$((r1 + r2))
  probes_total=2
  
  # Get metrics
  qdepth=$(node scripts/hub-task.js --status 2>&1)
  echo "[METRICS] queue: $qdepth"
  
  # Build cycle report
  cat > "$REPORTS/phase3-cycle${cycle}-${TS}.json" << EOF
{
  "cycle": $cycle,
  "phase": 4,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "probes": {
    "total": $probes_total,
    "passed": $probes_pass,
    "failed": $probes_fail
  },
  "dispatch_results": $(echo "{}" | python3 -c "
import sys,json
d={'cycle':$cycle,'phase':4,'timestamp':'$(date -u +%Y-%m-%dT%H:%M:%SZ)','probes':{'total':$probes_total,'passed':$probes_pass,'failed':$probes_fail}}
print(json.dumps(d,indent=2))"),
  "queueDepth": "$qdepth",
  "cyclePattern": "$([ $((cycle % 2)) -eq 1 ] && echo 'github-ops/dispatcher + coding/direct' || echo 'research/dispatcher + dev-ops/direct')"
}
EOF

  echo "[CYCLE $cycle COMPLETE] pass=$probes_pass fail=$probes_fail"
  cycle=$((cycle + 1))
done

echo ""
echo "=============================================="
echo "ALL 7 CYCLES DONE (7-13)"
echo "=============================================="
