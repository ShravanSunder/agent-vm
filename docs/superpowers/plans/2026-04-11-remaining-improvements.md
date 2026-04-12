# Remaining Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining improvements to make agent-vm zero-friction on any Mac: shared image cache with cleanup, tool VM bake, snapshot→backup rename, `agent-vm auth` command, Touch ID-first setup (no env var editing), and WebSocket proxy test.

**Architecture:** Seven tasks. Cache redesign moves images to shared `./cache/images/` with fingerprint dedup and explicit cleanup. Tool VM bake removes redundant runtime exec. Snapshot→backup is a rename + CLI promotion. Auth command wraps SSH + plugin auth in one step. Init defaults to `op-cli` (Touch ID) and auto-generates age key. WebSocket test validates PR#83.

**Tech Stack:** TypeScript (ES modules, Node 24), Gondolin SDK (locally linked, includes PR#83), Vitest

**Implementation repo:** `/Users/shravansunder/Documents/dev/project-dev/agent-vm/` (branch: `live-validation-2`)

---

## Design Decisions

### Why not checkpoints?

We investigated Gondolin checkpoints (`vm.checkpoint()` → `VmCheckpoint.load().resume()`). They capture **disk state only** — no memory, no running processes. With postBuild baking, boot is already fast. The 15-30s OpenClaw startup (process state, not disk) is the bottleneck, and checkpoints don't help. Deferred until Gondolin adds memory checkpoints.

### What preserves user setup: encrypted backups

The user's setup work (OAuth tokens, channel auth, workspace) persists via VFS mounts automatically. The backup system archives it as an encrypted tar for disaster recovery.

**Encryption source (grounded in actual code):** The backup encryption key is resolved from **1Password** per zone: `op://agent-vm/agent-${zoneId}-snapshot/password` (see `snapshot-commands.ts:38-42`). It is NOT the `AGE_IDENTITY_KEY` from `.env.local` — that was a documentation error. The key is stored in 1Password, resolved at backup time via the same secret resolver the rest of the system uses. The `AGE_IDENTITY_KEY` in `.env.local` and `.env.example` should be removed to avoid confusion, or repurposed for a local fallback. The plan takes the simpler path: keep the 1Password-based key resolution as-is and fix the docs.

After rename, the 1Password ref becomes `op://agent-vm/agent-${zoneId}-backup/password`.

### Shared image cache

Images are identical across zones — same Dockerfile, same build-config.json, same fingerprint. Shared cache at `./cache/images/{type}/{fingerprint}/` with no per-zone duplication.

**Fingerprint algorithm** (already implemented in `build-pipeline.ts:79-88`):
```
input  = stableSerialize(buildConfig) + "|" + gondolinVersion
output = SHA256(input)[0..16]
```

`stableSerialize` sorts object keys alphabetically, filters `undefined`, recurses into nested objects. Deterministic for identical configs.

**Known gap:** Dockerfile content changes don't change the fingerprint (it hashes build-config.json, not the Dockerfile). Workaround: `agent-vm build --force` passes `fullReset: true`. This flag is added in Task 1 alongside the cache path changes.

### Stale image cleanup

`agent-vm cache clean` compares directory names under `cache/images/{type}/` against the current fingerprint. Non-matching dirs are stale. The command warns that running VMs may reference these images, then requires `--confirm` to delete (not `--dry-run` to preview — the default should be safe). Without `--confirm`, it only lists.

### Zero-friction setup (no env var editing)

Default to `op-cli` token source (Touch ID) instead of `env` (service account token). The user needs 1Password CLI installed (`brew install 1password-cli`) and that's it — `controller start` prompts for Touch ID. No `.env.local` editing required.

`agent-vm init` auto-generates an age identity key via `age-keygen` if `age` is installed, writes it to `.env.local`. The `*_REF` defaults are copied from `.env.example`. The only manual step is having a 1Password vault with the expected items.

### Auth command

`agent-vm auth <plugin> --zone <id>` SSHs into the gateway VM and runs `openclaw auth login <plugin>` with `stdio: 'inherit'`. The user sees the auth prompt directly in their terminal.

---

## Execution Order

```
Task 1: Shared image cache + cacheDir config
Task 2: Cache clean/list command
Task 3: Bake tool VM runtime into Dockerfile
Task 4: Rename snapshot → backup (+ fix encryption docs)
Task 5: Auth command
Task 6: Zero-friction init (Touch ID default, auto age key)
Task 7: Test WebSocket through Gondolin proxy
```

---

## Task 1: Shared image cache with cacheDir

**Files:**
- Modify: `packages/agent-vm/src/controller/system-config.ts`
- Modify: `system.json`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
- Modify: `packages/agent-vm/src/cli/build-command.ts`
- Modify: `packages/agent-vm/src/cli/agent-vm-entrypoint.ts` (parse `--force` flag)
- Modify: `packages/agent-vm/src/build/gondolin-image-builder.ts` (thread `fullReset`)
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`

- [ ] **Step 1: Add cacheDir to system config schema**

In `packages/agent-vm/src/controller/system-config.ts`:

```typescript
const systemConfigSchema = z.object({
  host: z.object({ ... }),
  cacheDir: z.string().min(1).default('./cache'),
  images: z.object({ ... }),
  // ... rest unchanged
});
```

In `resolveRelativePaths`, add: `cacheDir: resolvePath(config.cacheDir),`

- [ ] **Step 2: Update system.json**

Add `"cacheDir": "./cache"` at top level.

- [ ] **Step 3: Update gateway-zone-orchestrator.ts — shared path**

Old: `cacheDir: \`${zone.gateway.stateDir}/images/gateway\``
New: `cacheDir: path.join(options.systemConfig.cacheDir, 'images', 'gateway')`

No zone prefix — images are shared.

- [ ] **Step 4: Update tool-vm-lifecycle.ts — replace zoneGatewayStateDirectory**

Replace `zoneGatewayStateDirectory` with `cacheDir` in options. Update build call:
`cacheDir: path.join(options.cacheDir, 'images', 'tool')`

- [ ] **Step 5: Update controller-runtime.ts caller**

Pass `cacheDir: options.systemConfig.cacheDir` instead of `zoneGatewayStateDirectory`.

- [ ] **Step 6: Update build-command.ts — shared cache + --force flag**

Images are shared, so build once not per-zone. Move Gondolin build outside zone iteration. Add `--force` flag that passes `fullReset: true` to `buildImage()` (already supported by `build-pipeline.ts:97`), which deletes the cached fingerprint dir and rebuilds:

```typescript
export async function runBuildCommand(
  options: {
    readonly systemConfig: SystemConfig;
    readonly forceRebuild?: boolean;
  },
  // ...
```

Update the Gondolin build call:
```typescript
for (const imageTarget of imageTargets) {
  const cacheDirectory = path.join(options.systemConfig.cacheDir, 'images', imageTarget.name);
  const buildResult = await buildGondolinImage({
    buildConfigPath: imageTarget.buildConfigPath,
    cacheDir: cacheDirectory,
    fullReset: options.forceRebuild,
  });
  // ...
}
```

In `agent-vm-entrypoint.ts`, parse the flag:
```typescript
if (commandGroup === 'build') {
  const forceRebuild = restArguments.includes('--force');
  // pass to runBuildCommand
}
```

The `buildGondolinImage` in `gondolin-image-builder.ts` needs to thread `fullReset` through to `buildImage()`. Add it to the options interface:

```typescript
export async function buildGondolinImage(
  options: {
    readonly buildConfigPath: string;
    readonly cacheDir: string;
    readonly fullReset?: boolean;
  },
```

- [ ] **Step 7: Update init template and test fixtures**

Add `cacheDir: './cache'` to scaffold template and `cacheDir: '/tmp/test-cache'` to all test SystemConfig fixtures.

- [ ] **Step 8: Run tests + commit**

Run: `pnpm vitest run`
Commit: `feat: shared image cache at cacheDir — deduplicated, outside stateDir`

---

## Task 2: Cache clean/list command

**Files:**
- Create: `packages/agent-vm/src/build/stale-image-cleaner.ts`
- Create: `packages/agent-vm/src/build/stale-image-cleaner.test.ts`
- Create: `packages/agent-vm/src/cli/cache-commands.ts`
- Modify: `packages/agent-vm/src/build/gondolin-image-builder.ts` (add `computeFingerprintFromConfigPath`)
- Modify: `packages/agent-vm/src/cli/agent-vm-entrypoint.ts`

**Critical: this is an ESM repo.** All file reads must use `import fs from 'node:fs'`, never `require('node:fs')`. The existing `snapshot-encryption.ts:18` already hit this bug.

**Required prerequisite:** Add `computeFingerprintFromConfigPath()` to `packages/agent-vm/src/build/gondolin-image-builder.ts`. This loads the build config and computes its fingerprint **without triggering a build**. The cache clean command needs fingerprints to compare against cached directories — using `buildGondolinImage()` for this is wrong because it would trigger a real build on a cold cache.

```typescript
// Add to packages/agent-vm/src/build/gondolin-image-builder.ts
import { computeBuildFingerprint, type BuildConfig } from 'gondolin-core';

export async function computeFingerprintFromConfigPath(
  buildConfigPath: string,
): Promise<string> {
  const rawContents = await fs.readFile(buildConfigPath, 'utf8');
  const buildConfig: BuildConfig = JSON.parse(rawContents) satisfies Record<string, unknown> as BuildConfig;
  return computeBuildFingerprint(buildConfig);
}
```

Note: The `JSON.parse` → `BuildConfig` assignment is a boundary with the filesystem. Gondolin's `buildAssets()` validates the config at build time. For fingerprinting we accept the parsed JSON as-is — if it's malformed, `computeBuildFingerprint` will produce a fingerprint that matches nothing in the cache, which is safe (stale detection treats everything non-matching as stale).

- [ ] **Step 1: Write stale-image-cleaner.ts**

```typescript
// packages/agent-vm/src/build/stale-image-cleaner.ts
import fs from 'node:fs';
import path from 'node:path';

export interface StaleImageEntry {
  readonly absolutePath: string;
  readonly imageType: 'gateway' | 'tool';
  readonly name: string;
  readonly sizeBytes: number;
}

function getDirectorySizeBytes(dirPath: string): number {
  let totalSize = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isFile()) {
        totalSize += fs.statSync(path.join(dirPath, entry.name)).size;
      }
    }
  } catch {
    // Cannot stat — report 0
  }
  return totalSize;
}

export function findStaleImageDirectories(options: {
  readonly cacheDir: string;
  readonly currentFingerprints: { readonly gateway: string; readonly tool: string };
}): readonly StaleImageEntry[] {
  const staleEntries: StaleImageEntry[] = [];

  for (const imageType of ['gateway', 'tool'] as const) {
    const typeDir = path.join(options.cacheDir, 'images', imageType);
    if (!fs.existsSync(typeDir)) {
      continue;
    }

    const currentFingerprint = options.currentFingerprints[imageType];

    for (const entry of fs.readdirSync(typeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === currentFingerprint) {
        continue;
      }

      const absolutePath = path.join(typeDir, entry.name);
      staleEntries.push({
        absolutePath,
        imageType,
        name: entry.name,
        sizeBytes: getDirectorySizeBytes(absolutePath),
      });
    }
  }

  return staleEntries;
}

export function deleteStaleImageDirectories(entries: readonly StaleImageEntry[]): void {
  for (const entry of entries) {
    fs.rmSync(entry.absolutePath, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Write stale-image-cleaner tests** (see previous version — 3 cases: finds stale, empty when current, handles missing dir)

- [ ] **Step 3: Write cache-commands.ts**

Use `import fs from 'node:fs/promises'` (ESM, not require). Resolve current fingerprints using Zod-validated config loading, not raw `JSON.parse as BuildConfig`:

```typescript
// packages/agent-vm/src/cli/cache-commands.ts
import fs from 'node:fs/promises';
import path from 'node:path';

import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import type { SystemConfig } from '../controller/system-config.js';
import {
  deleteStaleImageDirectories,
  findStaleImageDirectories,
} from '../build/stale-image-cleaner.js';
import type { CliIo } from './agent-vm-cli-support.js';

async function resolveCurrentFingerprints(
  systemConfig: SystemConfig,
): Promise<{ gateway: string; tool: string }> {
  return {
    gateway: await computeFingerprintFromConfigPath(systemConfig.images.gateway.buildConfig),
    tool: await computeFingerprintFromConfigPath(systemConfig.images.tool.buildConfig),
  };
}
```

**Cache clean behavior:**
- Default (no `--confirm`): list stale entries with sizes, do NOT delete
- With `--confirm`: delete stale entries
- Warn: "Running VMs may reference these images. Stop the controller before cleaning."

```typescript
export async function runCacheCommand(
  options: {
    readonly subcommand: string;
    readonly systemConfig: SystemConfig;
    readonly confirm?: boolean;
  },
  io: CliIo,
): Promise<void> {
  const currentFingerprints = await resolveCurrentFingerprints(options.systemConfig);

  if (options.subcommand === 'list') {
    // ... list all entries, mark current
    return;
  }

  if (options.subcommand === 'clean') {
    const stale = findStaleImageDirectories({
      cacheDir: options.systemConfig.cacheDir,
      currentFingerprints,
    });

    if (stale.length === 0) {
      io.stderr.write('[cache] No stale images found.\n');
      return;
    }

    io.stderr.write(`[cache] ${stale.length} stale image(s):\n`);
    for (const entry of stale) {
      io.stderr.write(`  ${entry.imageType}/${entry.name} (${formatBytes(entry.sizeBytes)})\n`);
    }

    if (!options.confirm) {
      io.stderr.write('\n[cache] Run with --confirm to delete. Stop the controller first.\n');
      return;
    }

    deleteStaleImageDirectories(stale);
    io.stderr.write(`[cache] Deleted ${stale.length} stale image(s).\n`);
    return;
  }

  throw new Error(`Unknown cache subcommand '${options.subcommand}'.`);
}
```

- [ ] **Step 4: Wire into CLI entrypoint**

- [ ] **Step 5: Run tests + commit**

Commit: `feat: agent-vm cache list/clean — fingerprint-based stale image cleanup`

---

## Task 3: Bake tool VM runtime into Dockerfile

**Files:**
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts:80-84`

Delete the redundant runtime exec. Dockerfile already has everything.

- [ ] **Step 1: Remove runtime exec, run tests, commit**

Commit: `fix: remove redundant tool VM runtime setup — already baked into Dockerfile`

---

## Task 4: Rename snapshot → backup (+ fix encryption docs)

**Files to rename:** All files under `packages/agent-vm/src/snapshots/` → `packages/agent-vm/src/backup/` with `snapshot` → `backup` in filenames and types. CLI command promoted from `controller snapshot` to top-level `backup`.

**Critical fix:** Update the 1Password ref from `op://agent-vm/agent-${zoneId}-snapshot/password` to `op://agent-vm/agent-${zoneId}-backup/password` in the backup commands. (The user will need to update their 1Password vault item name, or we keep the old ref as a transitional alias.)

**Docs to update (hard cutover — all refs to "snapshot" must become "backup"):**
- `docs/SETUP.md:35` — remove `AGE_IDENTITY_KEY` as snapshot encryption, explain backup encryption comes from 1Password
- `docs/E2E-VERIFICATION-CHECKLIST.md:129` — `controller snapshot` → `backup`
- `docs/PROJECT-STATUS.md:42,61-63,104,154` — 5 references to "snapshot" including CLI examples and known issues
- `shravan-claw/docs/05-secrets-security-model.md` — update backup encryption description
- `shravan-claw/docs/01-architecture-v4.md` — any snapshot references
- `.env.example` — clarify `AGE_IDENTITY_KEY` purpose (checkpoint encryption helper, not backup encryption)

- [ ] **Step 1: Move files with git mv**
- [ ] **Step 2: Rename all types and functions**
- [ ] **Step 3: Update all imports**
- [ ] **Step 4: Promote to top-level CLI command, hard cutover (remove `controller snapshot`)**
- [ ] **Step 5: Update all docs in both repos**
- [ ] **Step 6: Run tests + commit**

Commit: `refactor: rename snapshot → backup — encrypted zone data backup, not VM snapshots`

---

## Task 5: Auth command

**Files:**
- Create: `packages/agent-vm/src/cli/auth-command.ts`
- Create: `packages/agent-vm/src/cli/auth-command.test.ts`
- Modify: `packages/agent-vm/src/cli/agent-vm-entrypoint.ts`

`agent-vm auth <plugin> --zone <id>` SSHs into the gateway VM and runs `openclaw auth login <plugin>` with interactive stdio.

- [ ] **Step 1: Write auth-command.ts**

```typescript
// packages/agent-vm/src/cli/auth-command.ts
import type { SystemConfig } from '../controller/system-config.js';
import type { CliDependencies, CliIo } from './agent-vm-cli-support.js';

export async function runAuthCommand(options: {
  readonly dependencies: CliDependencies;
  readonly io: CliIo;
  readonly pluginName: string;
  readonly systemConfig: SystemConfig;
  readonly zoneId: string;
}): Promise<void> {
  const controllerClient = options.dependencies.createControllerClient({
    baseUrl: `http://127.0.0.1:${options.systemConfig.host.controllerPort}`,
  });

  const sshResponse = await controllerClient.enableZoneSsh(options.zoneId);
  // Validate response shape (Zod, same as ssh-commands.ts)

  if (!sshResponse.host || !sshResponse.port) {
    throw new Error(
      `Cannot auth: controller returned incomplete SSH access for zone '${options.zoneId}'. Is the gateway running?`,
    );
  }

  const runInteractiveProcess =
    options.dependencies.runInteractiveProcess ??
    (async (command: string, args: readonly string[]): Promise<void> => {
      const { execa } = await import('execa');
      await execa(command, args, { stdio: 'inherit' });
    });

  const sshArgs = [
    ...(sshResponse.identityFile ? ['-i', sshResponse.identityFile] : []),
    '-p',
    String(sshResponse.port),
    `${sshResponse.user ?? 'root'}@${sshResponse.host}`,
    'openclaw',
    'auth',
    'login',
    options.pluginName,
  ];

  try {
    await runInteractiveProcess('ssh', sshArgs);
  } catch (error) {
    throw new Error(
      `Auth failed for ${options.pluginName} in zone '${options.zoneId}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
```

- [ ] **Step 2: Wire into CLI entrypoint**

```typescript
if (commandGroup === 'auth') {
  const pluginName = subcommand;
  if (!pluginName) {
    throw new Error('Usage: agent-vm auth <plugin> --zone <id>');
  }
  const systemConfig = dependencies.loadSystemConfig(resolveConfigPath(restArguments));
  const zoneId = resolveZoneId(systemConfig, restArguments);
  await runAuthCommand({ dependencies, io, pluginName, systemConfig, zoneId });
  return;
}
```

- [ ] **Step 3: Write tests, run, commit**

Commit: `feat: agent-vm auth <plugin> — one-command OAuth setup`

---

## Task 6: Zero-friction init (Touch ID default, auto age key)

**Files:**
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `.env.example`
- Modify: `docs/SETUP.md`

- [ ] **Step 1: Change default tokenSource to op-cli**

In `init-command.ts`, update `DEFAULT_SYSTEM_CONFIG`:

Old:
```typescript
tokenSource: {
  type: 'env',
  envVar: 'OP_SERVICE_ACCOUNT_TOKEN',
},
```

New:
```typescript
tokenSource: {
  type: 'op-cli',
  ref: 'op://agent-vm/service-account/credential',
},
```

User authenticates with Touch ID. No env var needed.

- [ ] **Step 2: Auto-generate age identity key**

In `scaffoldAgentVmProject`, after writing `.env.local`, try to generate an age key:

```typescript
import { execFileSync } from 'node:child_process';

// After writing .env.local:
try {
  const result = execFileSync('age-keygen', [], { encoding: 'utf8' });
  const identityLine = result.split('\n').find((line) => line.startsWith('AGE-SECRET-KEY-'));
  if (identityLine) {
    // Append to .env.local
    fs.appendFileSync(envFilePath, `AGE_IDENTITY_KEY=${identityLine.trim()}\n`);
  }
} catch {
  // age not installed — user can add key manually later
}
```

- [ ] **Step 3: Update .env.example — make OP_SERVICE_ACCOUNT_TOKEN optional**

```
# === 1Password Authentication ===
# Default: Touch ID via 1Password CLI (no env var needed).
# Only set this if using a service account instead of Touch ID:
# OP_SERVICE_ACCOUNT_TOKEN=

# === Secret References (1Password op:// URIs) ===
DISCORD_BOT_TOKEN_REF=op://agent-vm/agent-discord-app/bot-token
PERPLEXITY_API_KEY_REF=op://agent-vm/agent-perplexity/credential
OPENCLAW_GATEWAY_TOKEN_REF=op://agent-vm/agent-shravan-claw-gateway/password

# === Local Encryption Key (optional) ===
# Used by checkpoint encryption helpers. NOT used for zone backups
# (those use a per-zone key from 1Password).
# Auto-generated by agent-vm init if age is installed.
# AGE_IDENTITY_KEY=
```

- [ ] **Step 4: Update SETUP.md**

```markdown
## Quick Start

### 1. Initialize
agent-vm init <your-zone-id>

### 2. Build images
agent-vm build

### 3. Start
agent-vm controller start
# Touch ID prompt → 1Password resolves secrets → gateway boots

### 4. Auth (if needed)
agent-vm auth codex --zone <id>

### 5. Verify
agent-vm controller doctor
```

No `.env.local` editing step.

- [ ] **Step 5: Run tests + commit**

Commit: `feat: zero-friction init — Touch ID default, auto age key generation`

---

## Task 7: Test WebSocket through Gondolin proxy (PR#83)

**Files:** No code changes — validation experiment.

- [ ] **Step 1: Run WebSocket test through HTTP mediation**
- [ ] **Step 2: Document findings in shravan-claw docs**
- [ ] **Step 3: Commit docs**

---

## Summary

| Task | What | Complexity |
|------|------|------------|
| 1 | Shared image cache with `cacheDir` | Medium (7 files) |
| 2 | `agent-vm cache clean/list` with fingerprint cleanup | Medium (new command) |
| 3 | Bake tool VM runtime | Trivial (delete 5 lines) |
| 4 | Rename snapshot → backup + fix encryption docs | Medium (file moves + doc fixes) |
| 5 | `agent-vm auth <plugin>` command | Small (new command) |
| 6 | Zero-friction init (Touch ID, auto age key) | Small (init changes) |
| 7 | Test WebSocket proxy | Experiment |

**CLI shape after all tasks:**
```
agent-vm init <zone>                    # Scaffold (Touch ID default, auto age key)
agent-vm build                          # Build Docker + Gondolin images
agent-vm build --force                  # Rebuild ignoring cache
agent-vm cache list                     # Show cached fingerprints
agent-vm cache clean                    # List stale images
agent-vm cache clean --confirm          # Delete stale images
agent-vm auth <plugin> --zone <id>      # One-command OAuth setup
agent-vm backup create --zone <id>      # Encrypted zone data backup
agent-vm backup list                    # List backups
agent-vm backup restore --from <file>   # Restore from backup
agent-vm controller start               # Boot (Touch ID → 1P → gateway)
agent-vm controller stop                # Stop
agent-vm controller doctor              # Health check
agent-vm controller ssh-cmd --zone <id> # SSH into gateway (advanced)
agent-vm controller status              # Runtime status
```

**Zero-to-claw on any Mac:**
```
brew install qemu age 1password-cli docker
agent-vm init shravan
agent-vm build
agent-vm controller start       # Touch ID prompt
agent-vm auth codex --zone shravan
```
