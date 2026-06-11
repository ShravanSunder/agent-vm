# Backup Pipeline Hardening

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 12 (security + correctness on the encrypted-backup path)

## Problem

Four defects in the backup/restore pipeline, all on one surface:

1. **Plaintext tar left on disk when encryption fails.** The tar of the full
   `stateDir` is written directly into `backupDir`, then encrypted, then
   unlinked — but the unlink only runs on the success path. An `age`/
   1Password failure, disk-full, or process death leaves the unencrypted
   state archive (tokens, agent session data) sitting in `backupDir`
   indefinitely.
2. **Restore decrypts next to the backup, not in tmpdir.** The decrypted tar
   lands at `${backupPath}.decrypted.tar` in persistent `backupDir`; SIGKILL
   between decrypt and the `finally` leaves plaintext behind. (The extract
   staging dir correctly uses `os.tmpdir()` — the decrypt path is the
   inconsistency. Note also: decrypt happens *before* the try block, so a
   partial decrypt failure has no cleanup at all.)
3. **Default `backupDir` lives inside `stateDir`, so backups include all
   previous backups.** `cp -a stateDir staging/state` copies the
   `backups/` subdirectory; backup N embeds backups 1…N-1. Archives grow
   roughly geometrically; the overlap assertion
   (`assertRuntimeDirOutsideBackupInputs`) checks `runtimeDir` against the
   inputs but never checks `backupDir`.
4. **Restore is non-atomic.** Entries are copied one-by-one into the live
   `stateDir`/`zoneFilesDir` with `Promise.all(cp -a ...)`; a mid-restore
   failure leaves a mixed old/new state with no rollback.

## Current Evidence

- `packages/agent-vm/src/backup/backup-create-operation.ts:68-74` — tar →
  encrypt → unlink with no try/finally around encrypt+unlink; staging
  `finally` (line 69-71) covers only the staging dir.
- `packages/agent-vm/src/backup/backup-restore-operation.ts:55-56` —
  `decryptedTarPath = \`${options.backupPath}.decrypted.tar\`` and decrypt
  outside the try; cleanup only in the `finally` at 74-77.
- `packages/agent-vm/src/cli/backup-commands.ts:25` —
  `backupDir = zone.gateway.backupDir ?? \`${zone.gateway.stateDir}/backups\``.
- `backup-create-operation.ts:46` — `cp -a stateDir → staging/state`
  (includes `backups/` when nested); `:132-158` —
  `assertRuntimeDirOutsideBackupInputs` has no backupDir checks; the
  `assertNoPathOverlap` helper it needs already exists (`:116-130`).
- `backup-restore-operation.ts:11-31,61-66` — per-entry `cp -a` into live
  dirs, no staging+swap.
- `docs/architecture/storage-model.md` — backups are positioned as the
  durable encrypted state path, so plaintext residue and unbounded growth
  contradict the documented model.

## Non-Goals

- No change to the encryption mechanism (age/1Password) itself.
- No incremental/differential backup features.
- No automatic migration of existing oversized backup archives (document the
  operator note instead).

## Scope

Write surfaces:
- `packages/agent-vm/src/backup/backup-create-operation.ts`:
  - write the intermediate tar under a `fs.mkdtemp(os.tmpdir())` path (OS
    cleans on reboot) and/or wrap encrypt+unlink in try/finally with
    unconditional `fs.rm(tarPath, { force: true })`;
  - extend `assertRuntimeDirOutsideBackupInputs` (rename accordingly) to
    assert `backupDir` does not overlap `stateDir`/`zoneFilesDir`.
- `packages/agent-vm/src/cli/backup-commands.ts` AND
  `packages/agent-vm/src/cli/commands/paths-definition.ts:99` (review
  finding: the same legacy fallback
  `zone.gateway.backupDir ?? \`${stateDir}/backups\`` exists in BOTH files —
  change them together or the `paths` command will display a location the
  backup command rejects): change the fallback default to a sibling outside
  `stateDir`, or keep it and rely on the new assertion to force explicit
  configuration — decide with the user at execution. Context for that
  decision (review-verified): `docs/architecture/storage-model.md:308`
  already documents backups at `~/.agent-vm-backups/<zone>/` (outside
  stateDir) and `init-command.ts:418` scaffolds an explicit external
  `backupDir` via `pathProfile.gatewayBackupDir(zoneId)` — the in-stateDir
  fallback is legacy and only hits unconfigured zones.
- Restore live-zone guard (review finding — confirmed ABSENT today:
  `backup-commands.ts:82-96` calls `restoreBackup()` with no zone-running
  check): add a precondition in the restore CLI path that refuses to
  restore while the zone's gateway process is alive (read the on-disk
  gateway runtime record and check the PID via the existing
  identity-verified liveness helpers), with a clear operator message. If no
  reliable liveness signal exists for a zone type, refuse unless an explicit
  `--force` acknowledgement is passed.
- `packages/agent-vm/src/backup/backup-restore-operation.ts`:
  - decrypt into a `mkdtemp` tmpdir, cleanup in finally including the
    decrypt-failure path;
  - make restore staged: copy into `stateDir.incoming-<ts>` then swap
    (rename current → `stateDir.pre-restore-<ts>`, rename incoming →
    `stateDir`), with the pre-restore directory retained for manual
    recovery and a clear log line.
- Tests — taxonomy-resolved strategy (review blocker: ALL existing backup
  tests are `*.host.e2e.test.ts`; zero unit tests exist in
  `packages/agent-vm/src/backup/`, and `audit-test-taxonomy.ts` forbids
  unit tests importing `node:child_process`/`execa`, while both operations
  use a module-level non-injectable `execFileAsync`):
  1. add an injectable `execFileAsync` dependency (optional param
     defaulting to the real `promisify(execFile)`) to
     `backup-create-operation.ts` and `backup-restore-operation.ts` —
     mirroring the established DI pattern in
     `secret-management/redacted-exec-file.ts` — so the residue/cleanup
     logic gets true unit tests (`encryption` is already an injected
     object);
  2. keep the staged-swap end-to-end behavior proof in a new
     `*.host.e2e.test.ts` alongside the existing backup e2e files.
- `docs/architecture/storage-model.md`: one paragraph documenting backup
  dir placement rules if the default changes.

Read-only context:
- `packages/agent-vm/src/backup/backup-encryption.ts`,
  `backup-archive-layout.ts`, `backup-manager.ts` — path construction and
  encryption contract.
- `packages/agent-vm/src/cli/backup-commands.ts` callers — where
  stateDir/zoneFilesDir come from. (Live-zone collision already resolved:
  no precondition exists today; adding the guard is task 5.)

## Task Sequence

0. Add the injectable `execFileAsync` seam to both backup operations (pure
   refactor — existing `*.host.e2e.test.ts` suite stays green; this unlocks
   the unit tests in steps 1-5).
1. Tar-residue fix + unit test (mock `encryption.encrypt` to throw → assert
   no plaintext tar remains anywhere).
2. Decrypt-to-tmpdir fix + unit test (assert decrypted path under tmpdir;
   assert cleanup when decrypt itself fails midway).
3. `backupDir` overlap assertion + unit test (backupDir inside stateDir →
   throws with actionable message); decide and implement the default-dir
   change in BOTH fallback sites with a doc update.
4. Staged-swap restore + tests (unit: failure injected mid-copy → stateDir
   is either fully old or fully new, pre-restore dir exists; host e2e: real
   swap behavior alongside the existing backup e2e files).
5. Live-zone restore guard + unit test (gateway runtime record shows a live
   PID → restore refuses with an actionable message; `--force` overrides
   only where no reliable liveness signal exists).
6. Run backup unit + e2e-host suites + `pnpm check`.

## Proof Gates

- Red/green proof: tests in steps 1-5 fail before, pass after.
- Focused validation (new unit tests, enabled by the DI seam):
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/backup`
- Focused validation (existing + new host e2e — the pre-existing backup
  suite lives here, NOT in the unit project):
  `pnpm vitest run --config vitest.config.ts --project e2e-host packages/agent-vm/src/backup`
- Taxonomy: run `pnpm test:taxonomy` after adding test files.
- Full validation: `pnpm check && pnpm test:unit && pnpm test:integration`

## Stop Conditions

- (Pre-verified 2026-06-11: restore CAN run against a live zone today — no
  precondition exists in `backup-commands.ts:82-96`. The guard is therefore
  IN SCOPE as task 5, not a stop condition. Stop only if step 5 finds no
  reliable liveness signal AND the `--force` escape hatch is judged
  insufficient — that needs a user decision.)
- Stop at the default-backupDir decision if changing it breaks documented
  operator workflows — surface the tradeoff (loud assertion vs. new
  default) instead of choosing silently.

## Risks

- Cross-device rename (tmpdir on a different filesystem than stateDir)
  breaks atomic swap: stage the incoming dir as a sibling of stateDir, not
  in tmpdir (only the decrypted tar goes to tmpdir).
- Disk headroom: staged restore temporarily needs ~2× state size; document
  it.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/12-backup-pipeline-hardening.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
