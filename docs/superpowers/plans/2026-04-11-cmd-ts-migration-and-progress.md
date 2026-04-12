# cmd-ts Migration + Controller Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual switch-statement CLI parser with proper cmd-ts subcommands (giving us --help, usage text, error suggestions for free), and add tasuku progress to controller start.

**Architecture:** cmd-ts provides `subcommands()` for nested command groups and `command()` for individual commands with typed args. Each command defines its options via `option()` and `flag()`. Help text, error messages, and typo suggestions are automatic. Tasuku wraps long-running steps with spinners.

**Tech Stack:** TypeScript, cmd-ts (already a dependency, currently unused), tasuku (already a dependency), Vitest

**Implementation repo:** `/Users/shravansunder/Documents/dev/project-dev/agent-vm/` (branch: `live-validation-2`)

---

## Why This Matters

The CLI currently uses a manual switch statement:

```typescript
const [commandGroup, subcommand, ...restArguments] = argv;
if (commandGroup === 'init') { ... }
if (commandGroup === 'build') { ... }
if (commandGroup !== 'controller') {
  throw new Error('Expected command group "controller".');
}
switch (subcommand) {
  case 'start': ...
  case 'stop': ...
}
throw new Error(`Unknown controller subcommand '${subcommand}'.`);
```

This means:
- `agent-vm --help` → "Expected command group controller" (useless)
- `agent-vm controller --help` → "Unknown controller subcommand '--help'" (broken)
- `agent-vm contorller start` → "Expected command group controller" (no typo suggestion)
- No usage text, no argument validation, no descriptions
- Every new command requires manual switch wiring

cmd-ts is **already in package.json**. It gives us all of this for free:

```
$ agent-vm --help
agent-vm v0.1.0 — Gondolin-based VM controller

COMMANDS:
  init <zone>              Scaffold a new agent-vm project
  build                    Build Docker + Gondolin VM images
  cache <list|clean>       Manage image cache
  backup <create|list|restore>  Encrypted zone data backup
  auth <provider>          Run model OAuth flow
  controller <subcommand>  Manage the VM controller

$ agent-vm contorller start
Error: Unknown command "contorller". Did you mean "controller"?
```

---

## Target CLI Shape (cmd-ts)

```typescript
const app = subcommands({
  name: 'agent-vm',
  version: '0.1.0',
  description: 'Gondolin-based VM controller for OpenClaw',
  cmds: {
    init: initCommand,
    build: buildCommand,
    cache: cacheSubcommands,
    backup: backupSubcommands,
    auth: authCommand,
    controller: controllerSubcommands,
  },
});

const controllerSubcommands = subcommands({
  name: 'controller',
  description: 'Manage the VM controller',
  cmds: {
    start: controllerStartCommand,
    stop: controllerStopCommand,
    status: controllerStatusCommand,
    doctor: controllerDoctorCommand,
    destroy: controllerDestroyCommand,
    upgrade: controllerUpgradeCommand,
    logs: controllerLogsCommand,
    credentials: controllerCredentialsCommand,
    'ssh-cmd': controllerSshCommand,
    lease: leaseSubcommands,
  },
});
```

---

## Execution Order

```
Task 1: Define cmd-ts command definitions for all existing commands
Task 2: Wire up the root subcommands and replace the manual switch
Task 3: Add tasuku progress to controller start
Task 4: Add image cache check before controller start
```

Task 1 and 2 are the cmd-ts migration. Task 3 and 4 are the progress indicators. They're independent but Task 3 is easier after cmd-ts because the command handler is cleaner.

---

## Task 1: Define cmd-ts commands

**Files:**
- Create: `packages/agent-vm/src/cli/commands/init-definition.ts`
- Create: `packages/agent-vm/src/cli/commands/build-definition.ts`
- Create: `packages/agent-vm/src/cli/commands/cache-definition.ts`
- Create: `packages/agent-vm/src/cli/commands/backup-definition.ts`
- Create: `packages/agent-vm/src/cli/commands/auth-definition.ts`
- Create: `packages/agent-vm/src/cli/commands/controller-definition.ts`

Each file defines a cmd-ts `command()` or `subcommands()` with typed args. The handler calls the existing implementation function (init-command.ts, build-command.ts, etc.). The definitions are thin — just arg parsing + delegation.

- [ ] **Step 1: Create init command definition**

```typescript
// packages/agent-vm/src/cli/commands/init-definition.ts
import { command, positional, string } from 'cmd-ts';

import { promptAndStoreServiceAccountToken, scaffoldAgentVmProject } from '../init-command.js';

export const initCommand = command({
  name: 'init',
  description: 'Scaffold a new agent-vm project with config, images, and Keychain auth',
  args: {
    zoneId: positional({
      displayName: 'zone-id',
      type: string,
      description: 'Zone identifier (e.g., shravan)',
    }),
  },
  handler: async ({ zoneId }) => {
    const result = scaffoldAgentVmProject({
      targetDir: process.cwd(),
      zoneId,
    });
    const keychainStored = await promptAndStoreServiceAccountToken();
    process.stdout.write(
      `${JSON.stringify({ ...result, keychainStored }, null, 2)}\n`,
    );
  },
});
```

- [ ] **Step 2: Create build command definition**

```typescript
// packages/agent-vm/src/cli/commands/build-definition.ts
import { command, flag, option, optional, string } from 'cmd-ts';

import { loadSystemConfig } from '../../controller/system-config.js';
import { runBuildCommand } from '../build-command.js';

export const buildCommand = command({
  name: 'build',
  description: 'Build Docker OCI images and Gondolin VM assets',
  args: {
    config: option({
      type: optional(string),
      long: 'config',
      short: 'c',
      description: 'Path to system.json',
      defaultValue: () => 'system.json',
    }),
    force: flag({
      long: 'force',
      description: 'Force rebuild, ignoring cache',
    }),
  },
  handler: async ({ config, force }) => {
    const systemConfig = loadSystemConfig(config ?? 'system.json');
    await runBuildCommand({ forceRebuild: force, systemConfig });
  },
});
```

- [ ] **Step 3: Create auth command definition**

```typescript
// packages/agent-vm/src/cli/commands/auth-definition.ts
import { command, option, positional, string } from 'cmd-ts';

import { loadSystemConfig } from '../../controller/system-config.js';
import { runAuthCommand } from '../auth-command.js';

export const authCommand = command({
  name: 'auth',
  description: 'Run model provider OAuth flow inside the gateway VM',
  args: {
    provider: positional({
      displayName: 'provider',
      type: string,
      description: 'Provider name (e.g., openai-codex, anthropic, google)',
    }),
    zone: option({
      type: string,
      long: 'zone',
      short: 'z',
      description: 'Zone identifier',
      onMissing: () => 'default',
    }),
    config: option({
      type: string,
      long: 'config',
      short: 'c',
      description: 'Path to system.json',
      defaultValue: () => 'system.json',
    }),
  },
  handler: async ({ provider, zone, config }) => {
    const systemConfig = loadSystemConfig(config);
    await runAuthCommand({
      dependencies: (await import('../agent-vm-cli-support.js')).defaultCliDependencies,
      io: { stderr: process.stderr, stdout: process.stdout },
      pluginName: provider,
      systemConfig,
      zoneId: zone,
    });
  },
});
```

- [ ] **Step 4: Create cache, backup, and controller subcommand definitions**

Follow the same pattern for each. The controller subcommands nest: `controller → { start, stop, status, doctor, ... }`.

Key commands that need options:
- `controller start` → `--config`
- `controller stop` → `--config`
- `controller ssh-cmd` → `--zone`, `--print`, `--config`
- `controller destroy` → `--zone`, `--purge`, `--config`
- `backup create` → `--zone`, `--config`
- `backup restore` → positional `<path>`, `--zone`, `--config`
- `cache clean` → `--confirm`, `--config`

Each command definition is a thin wrapper that parses args with cmd-ts and delegates to the existing handler function.

- [ ] **Step 5: Run tests + commit**

```bash
git add packages/agent-vm/src/cli/commands/
git commit -m "feat: define cmd-ts command definitions for all CLI commands"
```

---

## Task 2: Wire root subcommands and replace manual switch

**Files:**
- Rewrite: `packages/agent-vm/src/cli/agent-vm-entrypoint.ts`
- Modify: `packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts`

Replace the manual switch with `run(app, process.argv.slice(2))` where `app` is the root `subcommands()` definition.

- [ ] **Step 1: Rewrite the entrypoint**

```typescript
// packages/agent-vm/src/cli/agent-vm-entrypoint.ts
#!/usr/bin/env node
function loadOptionalLocalEnvironmentFile(environmentFilePath: string = '.env.local'): void {
  try {
    process.loadEnvFile(environmentFilePath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw new Error(
      `Failed to load ${environmentFilePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

loadOptionalLocalEnvironmentFile();

import { run } from 'cmd-ts';
import { app } from './commands/root-definition.js';

async function main(): Promise<void> {
  await run(app, process.argv.slice(2));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Create root definition**

```typescript
// packages/agent-vm/src/cli/commands/root-definition.ts
import { subcommands } from 'cmd-ts';

import { authCommand } from './auth-definition.js';
import { backupSubcommands } from './backup-definition.js';
import { buildCommand } from './build-definition.js';
import { cacheSubcommands } from './cache-definition.js';
import { controllerSubcommands } from './controller-definition.js';
import { initCommand } from './init-definition.js';

export const app = subcommands({
  name: 'agent-vm',
  version: '0.1.0',
  description: 'Gondolin-based VM controller for OpenClaw',
  cmds: {
    init: initCommand,
    build: buildCommand,
    cache: cacheSubcommands,
    backup: backupSubcommands,
    auth: authCommand,
    controller: controllerSubcommands,
  },
});
```

- [ ] **Step 3: Update tests**

The existing entrypoint tests call `runAgentVmCli(argv, io, dependencies)`. With cmd-ts, the handler functions are called directly by cmd-ts. Tests should either:
- Test the command definitions directly by calling `handler({ ... })` with parsed args
- Or test the underlying handler functions (init-command, build-command, etc.) which don't change

The entrypoint test becomes simpler — verify that `run(app, ['init', 'shravan'])` invokes the init handler, etc.

- [ ] **Step 4: Verify help works**

Run: `agent-vm --help`
Expected: Lists all commands with descriptions

Run: `agent-vm controller --help`
Expected: Lists controller subcommands

Run: `agent-vm contorller start`
Expected: "Unknown command 'contorller'. Did you mean 'controller'?"

- [ ] **Step 5: Run full check + commit**

```bash
pnpm check
git add packages/agent-vm/src/cli/
git commit -m "feat: migrate CLI to cmd-ts — --help, usage text, typo suggestions for free"
```

---

## Task 3: Add tasuku progress to controller start

**Files:**
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts`

Same pattern as build-command.ts: injectable `runTask`, tasuku wraps each startup step.

- [ ] **Step 1: Add runTask to ControllerRuntimeDependencies**

```typescript
readonly runTask?: (title: string, fn: () => Promise<void>) => Promise<void>;
```

- [ ] **Step 2: Wrap startup steps in tasuku tasks**

```typescript
import task from 'tasuku';

async function defaultRunTask(title: string, fn: () => Promise<void>): Promise<void> {
  await task(title, async ({ startTime, setTitle }) => {
    startTime();
    await fn();
    setTitle(`${title} done`);
  });
}

export async function startControllerRuntime(...) {
  const runTaskStep = dependencies.runTask ?? defaultRunTask;

  let secretResolver!: SecretResolver;
  await runTaskStep('Resolving secrets', async () => {
    secretResolver = await createSecretResolverFromSystemConfig(...);
  });

  let gateway!: ...;
  await runTaskStep('Starting gateway zone', async () => {
    gateway = await startGatewayZone(...);
  });

  await runTaskStep(`Controller API on :${port}`, async () => {
    serverRef.current = await startControllerHttpServer(...);
  });
}
```

- [ ] **Step 3: Add `runTask` bypass to tests**

```typescript
runTask: async (_title: string, fn: () => Promise<void>) => fn(),
```

- [ ] **Step 4: Test live + commit**

```bash
agent-vm controller start  # should show progress
git commit -m "feat: tasuku progress on controller start"
```

---

## Task 4: Warn if images not cached on controller start

**Files:**
- Modify: `packages/agent-vm/src/cli/commands/controller-definition.ts` (or wherever the start handler lives)

- [ ] **Step 1: Check cache before starting**

```typescript
import { computeFingerprintFromConfigPath } from '../../build/gondolin-image-builder.js';
import fs from 'node:fs';
import path from 'node:path';

// In the start command handler, before calling startControllerRuntime:
const fingerprint = await computeFingerprintFromConfigPath(systemConfig.images.gateway.buildConfig);
const cachePath = path.join(systemConfig.cacheDir, 'images', 'gateway', fingerprint);
if (!fs.existsSync(path.join(cachePath, 'manifest.json'))) {
  process.stderr.write(
    '[start] Gateway image not cached. Run `agent-vm build` first for faster startup.\n' +
    '[start] Building inline...\n',
  );
}
```

- [ ] **Step 2: Test + commit**

```bash
git commit -m "feat: warn if images not cached on controller start"
```

---

## Summary

| Task | What | Why |
|------|------|-----|
| 1 | cmd-ts command definitions | Typed args, --help, descriptions for every command |
| 2 | Replace manual switch with cmd-ts root | --help works, typo suggestions, usage text |
| 3 | Tasuku on controller start | No more frozen terminal during 15-120s startup |
| 4 | Cache check before start | User knows to run `agent-vm build` first |

**Execution order:** 1 → 2 → 3 → 4

After all tasks:
```
agent-vm --help              # shows all commands
agent-vm controller --help   # shows controller subcommands
agent-vm controller start    # shows progress steps
pnpm check                   # all tests pass
```
