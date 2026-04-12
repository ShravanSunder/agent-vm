# Delta: Additional work beyond the original remaining-improvements plan

The full updated plan is at:
`/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/superpowers/plans/2026-04-11-remaining-improvements.md`

This file captures what changed AFTER you started implementing. Read the full plan for details — this is just the summary of what's new.

---

## New Tasks (not in original plan)

### Task 5: `agent-vm auth <plugin> --zone <id>`

New top-level CLI command. SSHs into gateway VM and runs `openclaw auth login <plugin>` with `stdio: 'inherit'`. One-command OAuth setup.

See full plan Task 5 for implementation.

### Task 6: Zero-friction init (Touch ID default, auto age key)

- Change `DEFAULT_SYSTEM_CONFIG` tokenSource from `{ type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' }` to `{ type: 'op-cli', ref: 'op://agent-vm/service-account/credential' }`
- Auto-generate `AGE_IDENTITY_KEY` via `age-keygen` during init, append to `.env.local`
- `.env.example` already updated by user (Touch ID default, OP_SERVICE_ACCOUNT_TOKEN commented out)

See full plan Task 6 for implementation.

---

## Changes to Existing Tasks

### Task 1 (cache + build): `--force` flag required

`agent-vm build --force` must pass `fullReset: true` through the build pipeline. This is the workaround for Dockerfile content changes not affecting the fingerprint.

Changes needed:

- `agent-vm-entrypoint.ts`: parse `--force` from argv
- `build-command.ts`: accept `forceRebuild` option, pass to `buildGondolinImage`
- `gondolin-image-builder.ts`: thread `fullReset` through to `buildImage()`

### Task 2 (cache clean): `computeFingerprintFromConfigPath` helper

**Do NOT use `buildGondolinImage()` to get fingerprints** — that triggers a real build on cold cache.

Add to `gondolin-image-builder.ts`:

```typescript
export async function computeFingerprintFromConfigPath(buildConfigPath: string): Promise<string> {
	const rawContents = await fs.readFile(buildConfigPath, 'utf8');
	const buildConfig: BuildConfig = JSON.parse(rawContents);
	return computeBuildFingerprint(buildConfig);
}
```

Cache clean behavior: default lists only, `--confirm` required to delete. Warn about running VMs.

### Task 4 (snapshot → backup): Additional doc files

These files also need "snapshot" → "backup" updates:

- `docs/PROJECT-STATUS.md` (lines 42, 61-63, 104, 154)
- `docs/E2E-VERIFICATION-CHECKLIST.md` (line 129)

### Task 4: Encryption source clarification

Backup encryption uses a **per-zone age key from 1Password**: `op://agent-vm/agent-${zoneId}-snapshot/password` (see `snapshot-commands.ts:38-42`). It does NOT use `AGE_IDENTITY_KEY` from `.env.local`. After rename, the 1P ref becomes `op://agent-vm/agent-${zoneId}-backup/password`.

`AGE_IDENTITY_KEY` in `.env.example` is labeled as "Local Encryption Key (optional)" for checkpoint helpers. Not for backups.

---

## TypeScript Rules Reminder

- No `as never`, no `as unknown`, no `any`
- Use `satisfies` for type validation without losing inference
- Use type guards at runtime boundaries
- ESM only — `import fs from 'node:fs'`, never `require()`
- Explicit return types on all functions
