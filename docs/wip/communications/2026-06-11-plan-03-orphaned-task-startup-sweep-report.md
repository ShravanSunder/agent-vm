# Plan 03: Orphaned Task Startup Sweep Report

Date: 2026-06-11
Repo: `/Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1`
Worktree: `/Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-plan-03-orphaned-task-startup-sweep`
Branch: `improve/plan-03-orphaned-task-startup-sweep`
Base branch: `improve-v1`
Source plan: `docs/superpowers/plans/2026-06-10-repo-improvements/03-orphaned-task-startup-sweep.md`
Plan coverage: full file loaded, 151 lines.
Push state: pending.

## Summary

Implemented controller startup recovery for orphaned worker tasks. On controller restart, the runtime now sweeps configured gateway zones before starting selected gateway zones and before readiness, classifies historical worker task logs, marks non-terminal tasks failed with reason `controller-restarted-mid-task`, and performs best-effort cleanup of task runtime directories, task resource directories, and reconstructed repo resource providers.

Unreadable task logs are handled by writing a `.failed` sentinel and quarantining the unreadable JSONL file so the existing task-state route can surface a terminal failed task instead of being hidden behind the bad log. Cleanup remains warning-only and does not block controller startup.

## Changed Files

- `packages/agent-vm/src/controller/controller-runtime.ts`
- `packages/agent-vm/src/controller/controller-runtime.unit.test.ts`
- `packages/agent-vm/src/controller/worker-task-startup-recovery.ts`
- `packages/agent-vm/src/controller/worker-task-startup-recovery.unit.test.ts`
- `packages/agent-vm/src/controller/worker-task-startup-recovery.integration.test.ts`
- `packages/agent-vm/src/resources/repo-resource-provider-runner.ts`

## Design Notes

- Recovery runs before `registry.startSelectedZones()` so a gateway boot failure cannot prevent old non-terminal task logs from being closed.
- Event-log classification streams the JSONL file and requires the final byte to be a newline. Truncated or malformed logs are treated as unreadable instead of appending behind corrupt content.
- Classification replays accepted event records through the task reducer, so a terminal task followed by controller git events remains terminal.
- Task directory discovery only considers UUID-shaped task directory names.
- Cleanup validates expected directories with `lstat` and realpath containment before invoking the existing `postStopGateway` cleanup path, so symlinked task/resource/runtime paths are skipped with warnings instead of followed.
- Repo resource provider cleanup reconstructs compose project handles from persisted `repo-metadata/<repoId>` runtime directories and the exported deterministic compose project-name helper.
- Worker VM process termination is still a known gap because worker VM runtime identities are not persisted. Recovery logs a warning when no runtime identity exists and still removes known filesystem/resource state.

## Review Findings Addressed

Accepted and fixed reviewer findings:

- Unreadable JSONL plus sentinel was not user-visible through the route; fixed by quarantining bad logs so sentinel fallback is used.
- Truncated final JSONL line could cause a failed append to land after corrupt content; fixed by treating non-newline-terminated logs as unreadable.
- Cleanup was coupled to recoverable accepted config; fixed so cleanup still runs even when marking terminal fails.
- Completed tasks followed by controller git events were misclassified as non-terminal; fixed by reducer-backed classification.
- Symlinked cleanup paths could escape the task/runtime roots; fixed by UUID filtering and lstat/realpath validation.
- Event-log reads were unbounded; fixed by streaming classification and streaming accepted-config recovery.
- Repo resource providers were not stopped during startup recovery; fixed by reconstructing provider handles and passing them through `postStopGateway`.
- Recovery was originally after gateway startup; moved before selected-zone startup.
- Route-level visibility was not proven; added integration coverage through `createControllerService`.

Residual tradeoff:

- Startup recovery intentionally runs before readiness, so very large historical task directories can still affect cold-start time. The implementation bounds this by scanning only UUID-shaped directories, skipping terminal state quickly, and streaming logs rather than whole-file reads.

## Proof Gates

All commands were run from the Plan 03 worktree unless noted.

- `mise run lint` from `/Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1`
  - Exit code: 0
  - Result: Oxlint found 0 warnings and 0 errors on 574 files.
  - Purpose: hook-path sanity check after the `mise.toml` trust blocker.
- `mise run lint`
  - Exit code: 0
  - Result: Oxlint found 0 warnings and 0 errors on 577 files.
- `pnpm fmt`
  - Exit code: 0
  - Result: Oxfmt completed on 624 files.
- `pnpm fmt:check` after adding this report
  - Exit code: 0
  - Result: all matched files use the correct format.
- `git diff --check`
  - Exit code: 0
  - Result: no whitespace errors.
- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/controller-runtime.unit.test.ts packages/agent-vm/src/controller/worker-task-startup-recovery.unit.test.ts`
  - Exit code: 0
  - Result: 2 test files passed, 36 tests passed.
- `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/worker-task-startup-recovery.integration.test.ts`
  - Exit code: 0
  - Result: 1 test file passed, 5 tests passed.
- `pnpm check`
  - Exit code: 0
  - Result: check gate 6 passed, 0 failed in 21.98s.
  - Notes: package versions synced at 0.0.95, taxonomy passed, format passed, type-aware lint reported existing warnings with 0 errors, typecheck passed.
- `pnpm test:unit`
  - Exit code: 0
  - Result: taxonomy passed, 198 unit test files passed, 1814 tests passed.
- `pnpm test:integration`
  - Exit code: 0
  - Result: 24 integration test files passed, 332 tests passed.

No e2e lane was run for this slice because the plan's required proof is controller startup recovery behavior with unit/integration coverage and no named live VM/OpenClaw lane.
