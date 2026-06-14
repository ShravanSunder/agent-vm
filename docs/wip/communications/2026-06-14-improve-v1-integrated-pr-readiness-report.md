# 2026-06-14 improve-v1 integrated PR readiness report

## Scope

This report tracks the single integrated `improve-v1` PR branch. The deliverable
is one reviewable branch containing the implemented repo-improvement plans and
accepted review fixes. This is not a consolidation of plan files.

## Integrated inputs

- Pulled `origin/master` into `improve-v1` before plan integration.
- Verified observability commit `0d6257cd` is contained by `improve-v1`.
- Merged the 14 repo-improvement plan branches into `improve-v1` in dependency
  order:
  `01`, `03`, `06`, `09`, `11`, `04`, `05`, `07`, `08`, `02`, `10`, `12`,
  `13`, `14`.
- Preserved the existing external/managed observability split from the
  observability branch while resolving integration conflicts.

## Accepted review fixes

- Hardened staged backup restore cleanup so failures after partial staging remove
  unpromoted `.incoming-*` directories.
- Kept default backup output outside `stateDir`, under
  `~/.agent-vm-backups/<projectNamespace>/<zoneId>`, while preserving explicit
  configured `backupDir`.
- Made task event SSE reject unknown task IDs before opening a stream.
- Scoped orphaned worker-task startup recovery to selected zones.
- Kept worker e2e inventory discoverable by registering skipped suites when the
  worker gate is closed.
- Tightened task event stream parsing so newline-terminated malformed final
  events are corruption, not an incomplete tail.
- Replaced stale docs/test vocabulary from `threadId` to `sessionRef`.

## Deferred or rejected findings

- Do not kill orphaned worker VMs at startup: the current runtime does not
  persist a safe worker VM identity. Cleanup that can signal VMs needs a
  separate ownership design.
- Do not reintroduce state-dir backup defaults: backup storage is intentionally
  outside durable zone state by default.

## Proof

Fresh proof after the final review fix:

- `pnpm check`: passed, 6 passed, 0 failed.
- `pnpm test:unit`: passed, 210 files, 1977 tests.
- `pnpm test:integration`: passed, 24 files, 347 tests.
- `pnpm test:e2e:inventory`: passed, 1 file passed, 15 files skipped by
  inventory gates; 1 test passed, 27 tests skipped.
- `mise exec -- pnpm test:e2e`: passed, 4 lanes passed, 3 gated lanes skipped,
  0 failed.
  - `e2e-host-docker`: passed, 1 test, 1 file.
  - `e2e-host`: passed, 165 tests, 20 files.
  - `e2e-vm`: passed, 10 tests, 6 files.
  - `e2e-vm-mediation`: passed, 3 tests, 2 files.
  - `e2e-openclaw`: skipped in default gate because
    `AGENT_VM_OPENCLAW_E2E=1` was absent.
  - `e2e-worker`: skipped because `AGENT_VM_WORKER_E2E=1` was absent.
  - `e2e-secrets`: skipped because `AGENT_VM_1PASSWORD_E2E=1` was absent.
- `git diff --check`: passed.

Additional gated proof from before the final backup-only cleanup fix:

- `AGENT_VM_OPENCLAW_E2E=1 mise exec -- pnpm test:e2e:openclaw`: passed,
  4 files, 8 tests, 0 skipped, 0 todo.

Focused red/green proof for the final review fix:

- Red: backup unit and backup host e2e tests reproduced leftover
  `state.incoming-*` directories after missing `zone-files`.
- Green:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/backup/backup-operations.unit.test.ts`
  passed, 1 file, 11 tests.
- Green:
  `pnpm vitest run --config vitest.config.ts --project e2e-host packages/agent-vm/src/backup/backup-manager.host.e2e.test.ts`
  passed, 1 file, 13 tests.

## Beta status

Beta validation remains a separate deployment proof step. The beta checkout was
already dirty before this integrated branch sync, and an existing beta
controller session was already running. Do not claim beta runtime proof until the
integrated tarballs are synced into beta and beta is rebuilt/restarted or an
equivalent live validation is run.

## Cleanup timing

Do not delete old plan worktrees or branches until the integrated `improve-v1`
branch is pushed, reviewed, and merged. After merge, clean up the stale per-plan
worktrees and branches as a separate repo hygiene step.
