# Coordination Hub Tool — Incidents

## 2026-04-06T05:04:00Z — result-processor offline (resolved)

- **Signature:** No audit entries written for completed tasks
- **Root cause:** result-processor.js was not running. Workers published to `a2a:coordination` channel but no subscriber was writing to `a2a:audit:*` keys.
- **Detection:** Phase 4 cycle 7 probes consumed by workers (LLEN=0) but no audit entries appeared within 12s timeout.
- **Fix applied:** Started result-processor manually: `node src/result-processor.js &`
- **Prevention:** Add result-processor to `start-workers.sh` or supervisor managed process group.
- **Status:** RESOLVED

## 2026-04-06T05:04:00Z — invalid task names in cycle script (resolved)

- **Signature:** Workers returning `{error: 'Unknown task'}` for github-ops and coding probes
- **Root cause:** Cycle script sent `task: 'list_repos'` and `task: 'list_files'` — not recognized by workers. GitHubOpsWorker supports `list-issues`, CodingWorker supports `list-files`.
- **Fix applied:** Corrected cycle script to use worker-supported task names (`analyze`, `status`, `list-issues`, `list-files`).
- **Prevention:** Add task-type validation to `dispatch_task` plugin tool boundary.
- **Status:** RESOLVED

## 2026-04-06T05:04:00Z — duplicate worker processes (resolved)

- **Signature:** Two sets of typed workers running simultaneously (hub restart + manual start)
- **Root cause:** Workers were not PID-tracked; multiple start invocations created duplicate processes.
- **Fix applied:** Killed duplicate worker PIDs (2148, 2208, 2283, 2284), retained original set (2021–2024).
- **Prevention:** Worker ctl script should track PIDs in a lock file.
- **Status:** RESOLVED

## 2026-04-06T07:14:00Z — Issue #29 chaos test CONFIRMED (RESOLVED 2026-04-06T20:33:00Z)

- **Test:** Dispatched sprint task (sleep 15, PID 2238) → waited 2s for BLPOP claim → `kill -9 2238` mid-execution → checked recovery
- **Result:** Task LOST. Sprint inbox=0 (BLPOP claimed), no audit entry written, task permanently gone.
- **Same vulnerability in typed workers:** Dev-ops worker (PID 2024) killed mid-task → same LPOP loss confirmed.
- **Root cause:** ALL workers use `BaseWorker.pollTask()` which calls `BLPOP` — atomically removes task from queue with no pending state. If worker dies after claim but before `publishResult()`, task is unrecoverable.
- **Fix approach:** Replace BLPOP with BRPOPLPUSH to a `sprint:pending:{taskId}` key with TTL. Add supervisor process that monitors stale pending keys and re-queues them. Alternative: in-process acknowledge-on-complete pattern.
- **Production impact:** Low if workers are stable. High if worker crashes are possible. Current finish criteria met through worker stability (50/50 tasks completed without crash).
- **Fix implemented (2026-04-06 20:33 UTC):** Sprint worker already has its own `sprint:pending:{taskId}` mechanism (TTL, heartbeat refresh). Supervisor updated to monitor these keys and `a2a:pending:*` (typed workers). Recovery criteria: TTL==-1 OR status==running AND lastHeartbeat >60s old. Typed workers: BaseWorker.pollTask() updated to BRPOPLPUSH → `a2a:pending:{agentId}:{ts}:{rand}` with 60s TTL.
- **Chaos test (PASSED):** Sprint task (sleep 20) → worker claimed (pending key created, TTL 140s) → `kill -9` worker → supervisor detected stale at 65s → re-queued → new worker completed task. Evidence: audit key `chaos-fix2-1775507435847` shows status=completed, duration=20004ms.
- **Status:** RESOLVED

- Signature: `timeout_waiting` on both probes (`dispatcher_github_ops_health_probe`, `direct_coding_list_files_probe`)
- Root cause: worker registry was empty after gateway restart; no active workers to consume queued tasks.
- Detection: cycle report `phase3-cycle4-2026-04-06T01-58-59-732Z.json` showed `registry: {}` and queued growth in inboxes.
- Fix applied: restarted all four workers (`coding`, `github-ops`, `research`, `dev-ops`) and re-ran cycle.
- Recovery result: PASS on recovery pass (`phase3-cycle4-2026-04-06T02-00-02-248Z.json`).
- Preventive note: after any gateway restart/config patch, verify worker registry before Phase 3 cycle dispatch.
