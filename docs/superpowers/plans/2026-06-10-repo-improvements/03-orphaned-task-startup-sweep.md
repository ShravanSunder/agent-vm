# Orphaned Worker Task Startup Sweep

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 3 (correctness — tasks stuck non-terminal forever after controller crash)

## Problem

`executeWorkerTask` runs as a detached promise. If the controller process
dies mid-task (crash, OOM, operator kill), the cleanup sequence
(`gateway.vm.close()`, `postStopGateway`, resource-provider stop) never runs
and no terminal event is written. After restart:

- `GET /zones/:zoneId/tasks/:taskId` replays the event log and reports the
  last in-progress state (e.g. `work-agent`) forever — a permanently stuck
  task from the caller's perspective.
- The task's VM, Docker resource providers, and gitdirs are orphaned. Tool
  VM leases get Phase A startup recovery; worker-task VMs have no equivalent
  sweep.

The failure sentinel (`writeTaskFailureSentinel`) only covers the case where
`executeWorkerTask` itself throws — never a process death.

## Current Evidence

- `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts:510`
  — `void executeWorkerTask(prepared).catch(...)`; sentinel written only
  inside the catch (lines 515-538).
- `packages/agent-vm/src/controller/worker-task-runner.ts:931-976` — cleanup
  happens in the function's own epilogue; nothing survives process death.
- `packages/agent-vm/src/controller/active-task-registry.ts` — purely
  in-memory; rebuilt empty on restart.
- `packages/agent-vm/src/controller/task-state-reader.ts:99-113` — reads
  `stateDir/tasks/{taskId}/state/tasks/{taskId}.jsonl`; falls back to the
  `.failed` sentinel only when the log is missing/empty, so a partial log
  with no terminal event reports the stale in-progress state.
- Contrast: `packages/agent-vm/src/controller/leases/tool-vm-recovery.ts` —
  Phase A pattern (scan records, scope-fence, kill-by-identity, clean up)
  already exists for Tool VMs.

## Non-Goals

- Do not implement task *resumption* after controller restart (tasks are
  fail-fast by design; the goal is honest terminal state + resource cleanup).
- Do not persist the active-task registry.
- Do not change the event log format.

## Scope

Write surfaces:
- New module
  `packages/agent-vm/src/controller/worker-task-startup-recovery.ts` (name
  per repo conventions): scan each zone's `stateDir/tasks/*/` at controller
  startup, parse each task's event log, and for logs whose last event is
  non-terminal (not `task-completed`/`task-failed`/`task-closed`):
  1. append a `task-failed` event with reason
     `controller-restarted-mid-task` (or write the sentinel if the log is
     unreadable);
  2. attempt resource cleanup for that task root using the existing teardown
     helpers (gitdirs/work dir removal, resource-provider stop) with
     tolerate-and-warn semantics.
- `packages/agent-vm/src/controller/controller-runtime.ts`: invoke the sweep
  inside `startControllerRuntime` after zone config is parsed and before
  `runtimeReadiness.set('ready')` (line ~757). A safe insertion point is
  directly before `await reapToolVmLeases()` at line ~764. (The sweep needs
  only `systemConfig.zones[n].gateway.stateDir` — no running zone. The race
  with new submissions is benign either way: fresh task UUIDs cannot appear
  in the orphan scan — but the insertion point should still be explicit.)
- Unit tests adjacent to the new module.

Read-only context:
- `packages/agent-vm-worker/src/state/task-event-types.ts` and
  `packages/agent-vm-worker/src/state/task-state.ts` — terminal-event
  vocabulary and replay semantics (controller already shares this log
  format; check where the controller-side append helper lives in
  `worker-task-runner.ts:775-792`).
- `packages/agent-vm/src/controller/worker-task-runner.ts` — existing
  teardown helpers (`postStopGateway`, resource provider stop, cleanup
  aggregation) to reuse rather than duplicate.
- `packages/agent-vm/src/controller/leases/tool-vm-recovery.ts` — scope-fence
  pattern if VM-process killing is included.

## Task Sequence

1. Implement log scanning + non-terminal detection as a pure function
   (`classifyTaskLogForRecovery(events) -> 'terminal' | 'needs-failure-event'
   | 'unreadable'`) with unit tests. The classifier must wrap the log parse
   in try/catch and map ANY thrown error to `'unreadable'` —
   `loadTaskStateFromLog` can throw (e.g. `task-state-reader.ts:118`,
   "log is empty or does not begin with task-accepted"), and a single
   corrupt log must not abort the whole sweep.
2. Implement the sweep: append `task-failed` by calling
   `appendEvent(eventLogPath, event)` imported from
   `@agent-vm/agent-vm-worker` — the same exported helper
   `worker-task-runner.ts:7` imports (the `recordEvent` at
   `worker-task-runner.ts:780-781` is a non-exported closure over it).
   Tolerate per-task failures with warnings, return a summary
   `{ recoveredCount, warnings }`.
3. Resource cleanup pass per recovered task: best-effort, warn-don't-throw.
   If killing orphaned worker-VM QEMU processes requires runtime records the
   worker path doesn't write today, scope this step down to
   directory/provider cleanup and record the VM-kill gap explicitly in the
   sweep's warning output (a record-writing change is a follow-up plan).
4. Wire into `controller-runtime.ts` startup; log the summary.
5. Integration test: build a fake task stateDir with a non-terminal log,
   start the runtime (or call the sweep directly at integration level),
   assert `GET /zones/:zoneId/tasks/:taskId` now returns `failed` with the
   restart reason.

## Proof Gates

- Red/green proof: integration test above fails before (returns in-progress
  state), passes after.
- Focused validation (unit):
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller`
- Focused validation (integration — the step-5 test lives in the
  `integration` project, not `unit`):
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller`
- Taxonomy: run `pnpm test:taxonomy` after adding test files.
- Full validation: `pnpm check && pnpm test:unit && pnpm test:integration`

## Stop Conditions

- Stop if controller-side and worker-side event-log append paths turn out to
  diverge in schema (re-verify against `task-event-types.ts` before writing
  events from the sweep).
- Stop if startup-sweep ordering conflicts with zone gateway startup (e.g.
  the sweep needs zone config that is only available after gateway start) —
  reconverge on ordering before restructuring startup.

## Risks

- Sweeping a task whose VM is *still running* after a controller restart
  would mark a live task failed. This is acceptable and honest — without the
  controller's poll loop the task can never be completed/pushed — but the
  failure reason must say so explicitly. Document this in the event reason.
- Concurrent sweep vs. new task submission for the same taskId is not
  possible (task IDs are fresh UUIDs), so no locking is needed.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/03-orphaned-task-startup-sweep.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
