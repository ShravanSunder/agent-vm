# Backup Pipeline Hardening

> **Partially superseded:** Preserve the plaintext-temporary-file hardening as
> historical substrate only. The accepted contract in
> `docs/specs/2026-07-20-tool-portal-pr-wrapup/2026-07-20-tool-portal-pr-wrapup.md`
> keeps the implicit `<stateDir>/backups` default through nested exclusion and
> keeps restore as a simple additive copy. Its staged-swap restore, live-zone
> guard, runtime coordination, and default-directory redesign are not current work.

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
- `packages/agent-vm/src/cli/backup-commands.ts`: change the default
  `backupDir` to a sibling outside `stateDir` (coordinate with
  `storage-model.md` vocabulary) or keep the default but rely on the new
  assertion to force explicit configuration — decide with the user at
  execution; the assertion makes the current default fail loudly.
- `packages/agent-vm/src/backup/backup-restore-operation.ts`:
  - decrypt into a `mkdtemp` tmpdir, cleanup in finally including the
    decrypt-failure path;
  - make restore staged: copy into `stateDir.incoming-<ts>` then swap
    (rename current → `stateDir.pre-restore-<ts>`, rename incoming →
    `stateDir`), with the pre-restore directory retained for manual
    recovery and a clear log line.
- Unit tests adjacent to all three files.
- `docs/architecture/storage-model.md`: one paragraph documenting backup
  dir placement rules if the default changes.

Read-only context:
- `packages/agent-vm/src/backup/backup-encryption.ts`,
  `backup-archive-layout.ts`, `backup-manager.ts` — path construction and
  encryption contract.
- `packages/agent-vm/src/backup/backup-commands.ts` callers — where
  stateDir/zoneFilesDir come from, to know what the swap may collide with
  (running zone? assert the zone is stopped before restore if not already
  enforced — verify and encode).

## Task Sequence

1. Tar-residue fix + test (mock `encryption.encrypt` to throw → assert no
   plaintext tar remains anywhere).
2. Decrypt-to-tmpdir fix + test (assert decrypted path under tmpdir; assert
   cleanup when decrypt itself fails midway).
3. `backupDir` overlap assertion + test (backupDir inside stateDir →
   throws with actionable message); decide and implement the default-dir
   change with a doc update.
4. Staged-swap restore + tests (failure injected mid-copy → stateDir is
   either fully old or fully new; pre-restore dir exists).
5. Run backup unit suites + `pnpm check`.

## Proof Gates

- Red/green proof: tests in steps 1-4 fail before, pass after.
- Focused validation:
  `pnpm vitest run --root . --config vitest.config.ts --project unit packages/agent-vm/src/backup`
- Full validation: `pnpm check && pnpm test:unit && pnpm test:integration`

## Stop Conditions

- Stop if restore can run against a *live* zone (swap under a running
  gateway would be destructive); verify the CLI's preconditions first and
  add the guard before the swap if absent.
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
