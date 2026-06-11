# Plan 12 Backup Pipeline Hardening Report

Status: stopped-at-gate; review findings accepted and fixed
Branch: improve/plan-12-backup-pipeline-hardening
Base: improve-v1 at 32c0e1c5

## Summary

Implemented and verified the backup pipeline hardening work that does not
require the explicit backupDir fallback decision:

- Plaintext backup tar archives are written in an OS tmpdir and cleaned in a
  finally path even when encryption fails.
- Encrypted artifacts are written to a same-filesystem temporary path and only
  renamed to the public `.tar.age` path after encryption succeeds, so failed
  encryption cannot publish a partial backup artifact.
- Restore decrypts into an OS tmpdir and cleans partial plaintext even when
  decrypt fails.
- Restore validates the manifest immediately after extraction and before any
  live directory mutation.
- Restore stages every incoming state/zone-files tree as sibling
  `*.incoming-*` directories before promoting any target. Promotion is
  rollback-aware across the whole restore set, so a later `zoneFilesDir`
  failure rolls back an already-promoted `stateDir`.
- Restore retains `*.pre-restore-*` directories for manual recovery after a
  fully successful restore that replaced existing directories.
- Restore CLI refuses to restore over a live gateway when the durable runtime
  record still matches a managed VM process identity. Missing or malformed
  runtime records, and matching non-managed process identities, require
  `--force`.

The plan remains stopped at task 3's explicit user decision:

- Change both legacy fallback sites to an external default, or
- Keep the legacy `stateDir/backups` fallback and rely on the new overlap
  assertion to force explicit `gateway.backupDir` for unconfigured legacy
  zones.

I did not change either fallback site:

- `packages/agent-vm/src/cli/backup-commands.ts`
- `packages/agent-vm/src/cli/commands/paths-definition.ts`

I also deferred the `backupDir` overlap assertion. A review pass caught that
adding the assertion while the legacy fallback still resolves to
`${stateDir}/backups` silently chooses the "keep fallback and fail until
configured" option before the user decision is made.

## Files Touched

- `packages/agent-vm/src/backup/backup-create-operation.ts`
- `packages/agent-vm/src/backup/backup-restore-operation.ts`
- `packages/agent-vm/src/backup/backup-operations.unit.test.ts`
- `packages/agent-vm/src/backup/backup-manager.host.e2e.test.ts`
- `packages/agent-vm/src/cli/backup-commands.ts`
- `packages/agent-vm/src/cli/backup-commands.unit.test.ts`

All touched files are inside the plan's declared write surfaces, except the
new unit test file which is the planned test surface enabled by the injectable
command seam.

## Red/Green Evidence

Red tests:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/backup/backup-operations.unit.test.ts`
  - Initial worktree run before `pnpm install`: exit 254, `vitest` not found.
  - After `pnpm install`: exit 1, 1 file / 2 tests failed.
    - Create path did not use the injectable archive command.
    - Restore path used `${backupPath}.decrypted.tar`.
  - After adding backupDir overlap test: exit 1, 1 file / 1 failed / 2 passed.
    - Function reached archive command instead of rejecting `backupDir` under
      `stateDir`.
  - After adding staged restore tests: exit 1, 1 file / 2 failed / 3 passed.
    - Restore copied new files into live state before failure.
    - Restore did not retain a `*.pre-restore-*` directory.
  - Review regression red run after adding the accepted findings:
    - exit 1
    - 1 file / 3 failed / 4 passed
    - Failed cases:
      - partial `.tar.age` remained after encryption wrote and threw.
      - invalid manifest restored new state before rejecting.
      - dual-directory restore left new state plus old zone-files when
        zone-files copy failed.
- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/cli/backup-commands.unit.test.ts`
  - exit 1, 1 file / 1 failed / 6 passed.
  - `assertRestoreTargetNotLive` did not exist.
  - Review regression red run after adding guard branch tests:
    - exit 1
    - 1 file / 2 failed / 9 passed
    - Failed cases:
      - usage text omitted `[--force]`.
      - missing runtime record allowed restore without `--force`.

Green focused tests:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/backup/backup-operations.unit.test.ts`
  - exit 0
  - 1 file passed
  - 7 tests passed
- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/cli/backup-commands.unit.test.ts`
  - exit 0
  - 1 file passed
  - 11 tests passed
- Latest current-code combined focused run:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/backup/backup-operations.unit.test.ts packages/agent-vm/src/cli/backup-commands.unit.test.ts`
  - exit 0
  - 2 files passed
  - 18 tests passed
- `pnpm vitest run --config vitest.config.ts --project e2e-host packages/agent-vm/src/backup`
  - first run after staged restore: exit 1, 3 files / 15 passed / 1 failed
  - old host assertion expected no restore siblings; the new
    `*.pre-restore-*` sibling is intentional.
  - final run: exit 0
  - 3 files passed
  - 16 tests passed

## Proof Gates

- `pnpm test:taxonomy`
  - exit 0
  - Test taxonomy audit passed.
- `pnpm typecheck`
  - exit 0
  - root typecheck plus 11 workspace package typechecks passed.
- `pnpm check`
  - first run: exit 1; format check failed on changed files.
  - after `pnpm fmt`: exit 0.
  - 6 passed / 0 failed:
    - package-versions
    - zod-version
    - test-taxonomy
    - format
    - type-aware-lint
    - typecheck
  - Latest current-code run: exit 0, 6 passed / 0 failed in 21.26s.
  - Type-aware lint reported existing repo warnings but 0 errors; the check
    gate passed.
- `pnpm test:unit`
  - exit 0
  - 198 files passed
  - 1814 tests passed
- `pnpm test:integration`
  - exit 0
  - 23 files passed
  - 327 tests passed
- Hook remediation:
  - `mise trust mise.toml` in `/Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1`
    - exit 0
  - `mise run lint` in `/Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1`
    - exit 0
    - Oxlint checked 574 files with 0 warnings and 0 errors.

## Review Findings

Accepted and fixed:

- Blocker: `backupDir` overlap assertion crossed the task 3 user gate while
  the legacy fallback still pointed under `stateDir`. The assertion and its
  unit claim were removed/deferred.
- Important: failed encryption could leave a partial public `.tar.age` file.
  Encryption now writes to a temporary same-filesystem path and renames only
  after success.
- Important: invalid manifests were validated after live restore mutation.
  Manifest validation now happens immediately after extraction.
- Important: restore was non-atomic across `stateDir` and `zoneFilesDir`.
  Restore now stages all requested targets before promotion and rolls back
  already-promoted targets if a later target fails.
- Important: a missing runtime record failed open. Missing runtime records now
  require `--force`; managed live VM matches still refuse restore.

Deferred follow-ups:

- Add a cross-process restore lock if concurrent restore becomes an operator
  concern.
- Revisit symlink-aware `backupDir` overlap rejection together with the task 3
  fallback decision.

## Notes

- `pnpm install` was needed in the new worktree before Vitest was available.
  It exited 0 with expected missing dist bin warnings before a workspace build.
- Type-aware lint still reports existing repository warnings outside this
  slice, but after local cleanup this branch did not add changed-file warnings.
- Restore logs retained pre-restore directories to stderr as:
  `[agent-vm backup] Retained pre-restore directory '<path>' for manual recovery.`

## Open Gate

Plan 12 task 3 remains a user decision:

1. Change the legacy fallback in both CLI sites to an external default,
   matching the documented `~/.agent-vm-backups/<zone>/` model.
2. Keep the legacy fallback and allow the new assertion to fail old
   unconfigured zones until they set `gateway.backupDir` explicitly.

Branch pushed to `origin/improve/plan-12-backup-pipeline-hardening`.
