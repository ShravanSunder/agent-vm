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
- Fixed beta tarball sync overlay generation after beta proof exposed that the
  script still wrote multiline package manifests into `runAfterBase`, which the
  integrated managed-image guard correctly rejects.

## Deferred or rejected findings

- Do not kill orphaned worker VMs at startup: the current runtime does not
  persist a safe worker VM identity. Cleanup that can signal VMs needs a
  separate ownership design.
- Do not reintroduce state-dir backup defaults: backup storage is intentionally
  outside durable zone state by default.

## Proof

Fresh proof after the final review fix and beta sync generator fix:

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

Focused red/green proof for beta overlay generation:

- Red:
  `pnpm vitest run scripts/sync-local-tarballs-to-deployment.unit.test.ts`
  failed, 1 file, 2 tests failed, proving generated `runAfterBase` commands
  contained newline characters and lacked copied package manifests.
- Green:
  `pnpm vitest run scripts/sync-local-tarballs-to-deployment.unit.test.ts`
  passed, 1 file, 10 tests.

## Beta status

Beta validation passed after one repo fix to the tarball sync generator:

- `pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta`: passed and
  packed/refreshed all local `@agent-vm/*` tarballs from the integrated
  `improve-v1` checkout into beta.
- First `mise exec -- pnpm build` in beta failed because generated
  `runAfterBase[1]` contained line breaks. Root cause was fixed in
  `scripts/sync-local-tarballs-to-deployment.ts`.
- Re-run `pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta`: passed.
- Re-run `mise exec -- pnpm build` in beta: passed. Docker and Gondolin builds
  completed for `gateway/openclaw` and `toolVm/default`. Cache auto-prune was
  skipped because beta runtime records existed.
- `pnpm validate` in beta: passed with `"ok": true`.
- `pnpm stop` in beta: passed with `"ok": true`.
- Fresh tmux start:
  `tmux new-session -d -s shravan-claw-beta-controller -c ../shravan-claw-beta 'mise exec -- pnpm start'`.
- Controller health after restart:
  `GET http://127.0.0.1:18900/health` returned
  `{"ok":true,"port":18900,"state":"ready"}`.
- Controller zone health after restart:
  `GET http://127.0.0.1:18900/zones/beta/health` returned
  `{"ok":true,"observation":"http 200","path":"/readyz","port":18789,"statusCode":200,"zoneId":"beta"}`.
- Direct ingress checks after restart:
  `GET http://127.0.0.1:18891/readyz` returned `200 {"ready":true}`;
  `GET http://127.0.0.1:18891/health` returned
  `200 {"ok":true,"status":"live"}`;
  `GET http://127.0.0.1:18891/` returned `200` with OpenClaw Control HTML.

The beta checkout was already dirty before this integrated sync. The sync
updated beta package pins, lockfile/workspace overrides, generated manuals, and
local overlay tarball references as expected for deployment validation.

## Cleanup timing

Do not delete old plan worktrees or branches until the integrated `improve-v1`
branch is pushed, reviewed, and merged. After merge, clean up the stale per-plan
worktrees and branches as a separate repo hygiene step.
