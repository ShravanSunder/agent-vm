# Plan 01 - Tool VM TCP Slot Quarantine Recovery

Date: 2026-06-11
Branch: `improve/plan-01-tool-vm-tcp-slot-quarantine-recovery`
Base branch: `improve-v1`
Implementation commit: `6e2b185 fix: recover quarantined tool vm tcp slots`
Push state: pushed to `origin/improve/plan-01-tool-vm-tcp-slot-quarantine-recovery`
PR URL: https://github.com/ShravanSunder/agent-vm/pull/new/improve/plan-01-tool-vm-tcp-slot-quarantine-recovery

## Scope

Implemented the reviewed plan at
`docs/superpowers/plans/2026-06-10-repo-improvements/01-tool-vm-tcp-slot-quarantine-recovery.md`.

Changed surfaces:

- `packages/agent-vm/src/controller/leases/lease-manager.ts`
- `packages/agent-vm/src/controller/leases/lease-manager.unit.test.ts`
- `packages/agent-vm/src/controller/controller-runtime.ts`
- `packages/agent-vm/src/controller/controller-runtime.unit.test.ts`

## Implementation Summary

- Tracked close-failure quarantines for committed Tool VM runtime records in the lease manager.
- Added same-process proof before reusing a quarantined TCP slot:
  - recover when the recorded QEMU PID is dead.
  - keep quarantine when the PID is alive with matching process identity.
  - recover when the PID is alive but identity is unreadable or mismatched.
- Kept partial create-failure quarantine unrecovered for the controller process lifetime because that path has no committed runtime record to prove PID death.
- Deleted the preserved runtime record during recovery when possible, while still releasing the quarantined slot if record deletion fails after process proof succeeds.
- Wired quarantine recovery into the existing controller lease reaper cadence after stale active-use and dead-idle reaping, and after attempting idle release. Idle release errors are still surfaced after quarantine recovery gets a same-tick chance to run.
- Kept the public `LeaseManager` interface stable by placing the recovery hook on the controller-private implementation type returned by `createLeaseManager`.

## Red Proof

Before implementation, the new quarantine-recovery tests failed against current code because no recovery method existed:

- Command: `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/leases`
- Exit: 1
- Result: 1 failed file, 5 failed tests, 112 passed tests
- Expected failure: tests attempted to call `leaseManager.reapQuarantinedTcpSlots()`, which was absent from the implementation.

## Review

Review swarm lanes:

- Lease manager/interface reviewer: 1 P1 and 1 P2 finding.
- Controller runtime wiring reviewer: 1 P2 finding.
- Safety/test coverage reviewer: 2 P2 findings.

Accepted fixes:

- Kept `reapQuarantinedTcpSlots()` off the exported `LeaseManager` interface to avoid making downstream interface implementers/mocks add a new required public member.
- Strengthened the controller-runtime test to capture all intervals, assert one 60s lease-reaper timer, drive PID-reuse recovery through injected `isProcessAlive` / `readProcessIdentity`, and prove idle release errors still surface after same-tick quarantine recovery.
- Added coverage for the `readProcessIdentity() === null` recovery path.
- Added coverage for recovery after an `evictLease()` close-failure quarantine.

Rejected / deferred finding:

- A reviewer proposed adding a host-port-owner/free check before `releaseQuarantined()`. I did not implement this in Plan 01 because the reviewed plan's safety boundary is exact process proof from the preserved runtime record. Adding independent host-port probing changes the recovery contract and belongs in a fresh design discussion rather than review cleanup.

## Proof Gates

- `pnpm fmt`
  - Exit: 0
  - Result: Oxfmt completed successfully.
- `mise run lint`
  - Exit: 0
  - Result: Oxlint found 0 warnings and 0 errors across 574 files.
- `pnpm test:taxonomy`
  - Exit: 0
  - Result: Test taxonomy audit passed.
- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/leases`
  - Exit: 0
  - Result: 8 files passed, 119 tests passed.
- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/controller-runtime.unit.test.ts -t 'reaps stale active uses before releasing expired idle leases'`
  - Exit: 0
  - Result: 1 test passed, 23 tests skipped.
- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller`
  - Exit: 0
  - Result: 38 files passed, 473 tests passed.
- `pnpm check`
  - Exit: 0
  - Result: 6 passed, 0 failed.
  - Sub-gates: package version sync, zod guard, taxonomy, format, type-aware lint, typecheck.
- `pnpm test:unit`
  - Exit: 0
  - Result: 197 files passed, 1809 tests passed.
- `pnpm test:integration`
  - Exit: 0
  - Result: 23 files passed, 327 tests passed.
- `git diff --check`
  - Exit: 0

## Notes

- The hook-reported `mise run lint` failure was a local trust preflight, not a lint error. I inspected `mise.toml`, trusted the coordinator and Plan 01 worktree configs, then reran `mise run lint` successfully.
- `pnpm check` emitted existing type-aware lint warnings in scripts, but the check gate summary was pass with 0 failed sub-gates. No infrastructure lint backlog was edited from this Plan 01 slice.
