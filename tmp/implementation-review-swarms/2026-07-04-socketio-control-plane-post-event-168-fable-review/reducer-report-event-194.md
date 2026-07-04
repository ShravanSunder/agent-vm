Event 194 Reducer Report
========================

Goal:
- `2026-07-02-socketio-control-plane`

Input:
- Event 193 advanced the branch to implementation review.
- The subsequent implementation review found unresolved behavior in Worker
  cancel semantics, peer-side backpressure/latest-wins delivery, MCP-backed Tool
  Portal session scoping, and review packet inventory freshness.

Verdict:
- `not_ready`
- Route back to `shravan-dev-workflow:implementation-execute-plan`.
- Not PR-ready. Terminal OpenClaw, Worker, VM, default e2e, `pnpm check`, and
  live beta Discord/OpenClaw proof remain required after accepted review
  findings are fixed and a clean implementation review is recorded.

Accepted findings:

1. Worker control `operation_cancel` still creates a second task-close path.
   - The implementation returns `accepted`, but the Worker control path still
     invokes `closeTask()` through the VM-side application handler.
   - That can terminalize the task over the control socket even though this PR's
     accepted scope keeps Worker task submit/state/close on ingress HTTP.
   - Fix direction: hard-reject task cancellation over Worker control for this
     cutover and prove the HTTP task close path remains the only close path.

2. Worker control `operation_cancel` ignores active operation identity.
   - The control path can request cancellation with an arbitrary UUID while the
     implementation closes the active task.
   - Because this PR does not define control-socket task-close semantics or
     active-operation matching, keeping a permissive control cancel is unsafe.
   - Fix direction: same as finding 1; reject this operation for now rather than
     inventing a second close protocol.

3. Peer-side Gateway and Worker control services do not fully implement the
   latest-wins/backpressure contract.
   - Controller outbound handling has bounded/coalescing behavior, but peer
     services still send every outbound app message through acked emit paths.
   - Fix direction: add bounded peer-side delivery handling for latest-wins and
     droppable/advisory events or an equivalent control-service-level cap that
     proves stale advisory events cannot accumulate unboundedly.

4. MCP-backed Tool Portal calls collapse separate OpenClaw sessions into one
   agent-wide MCP scope.
   - The MCP backend scope keys only by agent identity, while Tool Portal
     session policy has session-aware scoping.
   - Fix direction: thread session provenance from managed Tool Portal runtime
     into the MCP provider backend scope so same-agent/different-session calls
     do not share upstream MCP sessions.

5. Review packet staged inventory is stale.
   - Live `git diff --cached --name-only origin/master | wc -l` reports 392
     files, while `staged-name-status.txt` reports 345 lines.
   - Fix direction: refresh staged inventory and review packet after the code
     fixes.

Evidence checked before accepting:
- Latest official workflow event is Event 193 and incorrectly points to
  implementation review after the new findings.
- Live worktree has no unstaged diff.
- Live staged diff against `origin/master` reports 392 files changed.
- Existing staged inventory artifact reports 345 paths, confirming the packet
  freshness gap.

phase_result: needs_revision
evidence: reducer report written at tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-194.md; accepted findings listed above; live staged inventory mismatch confirmed
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Accepted implementation review findings remain unresolved, so the official goal-backed workflow must route back to execution before another review or terminal proof run.
