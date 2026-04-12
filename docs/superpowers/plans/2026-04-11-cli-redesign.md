# CLI Redesign: cmd-ts, Progress, Gateway Types

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the CLI properly with cmd-ts (--help, usage, typo suggestions), tasuku progress on all long-running operations, gateway type selection in init, and correct output contracts (progress to stderr, JSON to stdout).

**Implementation repo:** `/Users/shravansunder/Documents/dev/project-dev/agent-vm/` (branch: `live-validation-3`)

---

## Why This Needs to Happen

cmd-ts has been in `package.json` since the beginning. It was supposed to be the CLI framework. Instead, every agent (including me) kept adding `if (commandGroup === 'xxx')` blocks to a manual switch statement. The result:

- `agent-vm --help` → "Expected command group controller" (broken)
- `agent-vm controller --help` → "Unknown controller subcommand '--help'" (broken)
- `agent-vm contorller start` → cryptic error (no typo suggestion)
- No usage text, no argument descriptions, no discoverability
- `controller start` is silent for 2 minutes (no progress)
- Output mixes human text and JSON on stdout (no contract)
- `init` doesn't know about gateway types (openclaw vs coding)

This isn't polish. It's the foundation that everything else depends on. Every future command, every user interaction, every error message flows through the CLI parser. Getting this right now means every subsequent feature gets --help, validation, and progress for free.

---

## Design Decisions

### CLI hierarchy

```
agent-vm
├── init <zone> [--type openclaw|coding]   # scaffold project for a gateway type
├── build [--force]                        # build all images from config
├── doctor                                 # check prerequisites (offline)
├── cache list|clean [--confirm]           # manage image cache (offline)
│
├── controller                             # VM infrastructure lifecycle
│   ├── start                              # boot controller + gateway from config
│   ├── stop                               # shutdown
│   ├── status                             # what's running
│   ├── ssh [--zone <id>]                  # SSH into gateway VM
│   ├── destroy [--zone <id>] [--purge]    # tear down zone
│   ├── upgrade [--zone <id>]              # upgrade zone
│   ├── logs [--zone <id>]                 # gateway logs
│   ├── credentials refresh [--zone <id>]  # refresh secrets
│   └── lease list|release <id>            # manage tool VM leases
│
├── backup                                 # zone data backup (offline, needs 1P)
│   ├── create [--zone <id>]
│   ├── list [--zone <id>]
│   └── restore <path> [--zone <id>]
│
├── openclaw                               # OpenClaw-specific (needs running openclaw gateway)
│   └── auth <provider> [--zone <id>]      # model OAuth flow
│
└── coding                                 # coding-agent-specific (NOT IN THIS CHANGESET)
    ├── task create [options]               # reserved namespace — implemented when
    ├── task status <id>                    # agent-vm-coding merges from coding-agents branch
    ├── task list
    └── task cancel <id>
```

**What determines the gateway type:** `system.json` config, set at `init` time. Not a CLI flag on `controller start`. Build, start, stop, status — all read config. The `openclaw` and `coding` command groups are payload-specific and only work when that type is running.

### Preserving the testing seam

The current code has `runAgentVmCli(argv, io, dependencies)` which injects IO streams and all external dependencies. The validation review correctly flagged that the plan's cmd-ts examples hardcoded `process.stdout` and `loadSystemConfig` directly, destroying this seam.

The fix: **keep the factory pattern**. cmd-ts `command()` handlers receive parsed args. Those handlers call the existing implementation functions with injected dependencies. The root app is created by a factory:

```typescript
function createAgentVmApp(
	io: CliIo,
	dependencies: CliDependencies,
): ReturnType<typeof subcommands> {
	return subcommands({
		name: 'agent-vm',
		cmds: {
			init: createInitCommand(io, dependencies),
			build: createBuildCommand(dependencies),
			// ...
		},
	});
}
```

Tests call `createAgentVmApp(mockIo, mockDeps)` and pass argv to `run()`. Same seam, cmd-ts parsing on top.

### Output contract

**Rule: progress to stderr, structured output to stdout.**

- `controller start` → tasuku progress on stderr, final JSON on stdout
- `build` → tasuku progress on stderr (Docker output also goes to stderr naturally)
- `init` → scaffold result JSON on stdout, keychain prompt on stderr
- `status`, `doctor`, `lease list` → JSON on stdout only
- `cache clean` → progress messages on stderr

This means `agent-vm controller start | jq .ingress` works. Piping and scripting get clean JSON. Humans see progress in the terminal.

### Progress granularity

The validation review was right: one opaque "Starting gateway zone" spinner for 45 seconds still hides where time goes. The gateway orchestrator (`gateway-zone-orchestrator.ts`) already has explicit steps:

1. Resolve zone secrets
2. Build gateway image
3. Create gateway VM
4. Setup gateway runtime
5. Start OpenClaw + wait for readiness

Each should get its own tasuku task. The `runTask` callback gets threaded into the orchestrator, not wrapped around it from outside.

Same for `controller start` at the runtime level:

1. Resolve 1Password secrets → runTask
2. Start gateway zone → delegates to orchestrator (which has its own runTask calls)
3. Start controller HTTP API → runTask

### Gateway type in init

`agent-vm init <zone> --type openclaw` scaffolds:

- `system.json` with `gateway.type: "openclaw"`
- OpenClaw-specific Dockerfile (node:24-slim + openclaw package)
- OpenClaw config file
- OpenClaw secrets (DISCORD_BOT_TOKEN, etc.)

`agent-vm init <zone> --type coding` scaffolds:

- `system.json` with `gateway.type: "coding"`
- Coding-agent Dockerfile (node:24-slim + codex CLI + git)
- Coding agent config
- Coding secrets (GITHUB_PAT, model API keys)

Default is `openclaw` (personal use case). The `coding` type is for the agent-vm-coding package.

---

## Sequencing

These are 4 work streams. Order matters because each builds on the previous.

```
Stream 1: cmd-ts migration (foundation — everything depends on this)
  Task 1: Create command definition files with cmd-ts
  Task 2: Create app factory with dependency injection
  Task 3: Wire entrypoint to cmd-ts run()
  Task 4: Update all tests
  ↓ verifies: --help works, typo suggestions, arg validation

Stream 2: Output contract (needed before progress)
  Task 5: Separate stderr (progress) from stdout (JSON)
  ↓ verifies: piping works, scripting works
  Note: JSON is the default stdout format for all structured commands.
  No --json flag needed. Progress/status messages go to stderr only.

Stream 3: Tasuku progress (depends on Stream 1 + 2)
  Task 6: Thread runTask into gateway-zone-orchestrator (with RunTaskFn abstraction)
  Task 7: Add progress to controller start + cache-check warning
  ↓ verifies: user sees what's happening during startup

Stream 4: Gateway types (depends on Stream 1)
  Task 8: Add gateway.type to system-config schema + init scaffolds by type
  ↓ verifies: init --type coding produces a buildable project
```

**Why this order:**

1. **cmd-ts first** — every subsequent task needs clean command definitions to attach to. Progress and types are features of commands; commands need to exist properly first.

2. **Output contract before progress** — if we add tasuku before deciding where progress goes (stderr vs stdout), we'll mix them and have to fix it later. Decide the contract, then add progress to stderr.

3. **Progress after output contract** — now tasuku goes to stderr cleanly, JSON stays on stdout.

4. **Gateway types last** — it's a feature addition, not a fix. The CLI structure from Stream 1 accommodates it (the `openclaw` and `coding` subgroups), but the actual scaffolding can come after everything else works.

---

## Task 1: Create cmd-ts command definitions

**Files:**

- Create: `packages/agent-vm/src/cli/commands/init-definition.ts`
- Create: `packages/agent-vm/src/cli/commands/build-definition.ts`
- Create: `packages/agent-vm/src/cli/commands/doctor-definition.ts`
- Create: `packages/agent-vm/src/cli/commands/cache-definition.ts`
- Create: `packages/agent-vm/src/cli/commands/backup-definition.ts`
- Create: `packages/agent-vm/src/cli/commands/auth-definition.ts`
- Create: `packages/agent-vm/src/cli/commands/controller-definition.ts`

Each definition is a thin cmd-ts `command()` that:

1. Declares typed args via `option()`, `flag()`, `positional()`
2. Receives `CliIo` and `CliDependencies` from the factory (not hardcoded globals)
3. Calls the existing handler function (init-command.ts, build-command.ts, etc.)

**Behavioral preservation (from validation review):**

- `init` zone is optional, defaults to `'default'` (use `defaultValue`, not required positional)
- `--zone` defaults to first configured zone via `resolveZoneId` pattern (not hardcoded `'default'`)
- `controller credentials refresh` stays nested (credentials is a subcommand group with `refresh`)
- `--config` defaults to `'system.json'` everywhere

Example — init command:

```typescript
// packages/agent-vm/src/cli/commands/init-definition.ts
import { command, option, optional, positional, string } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';

export function createInitCommand(
	io: CliIo,
	dependencies: CliDependencies,
): ReturnType<typeof command> {
	return command({
		name: 'init',
		description: 'Scaffold a new agent-vm project',
		args: {
			zoneId: positional({
				displayName: 'zone-id',
				type: optional(string),
				description: 'Zone identifier (default: "default")',
			}),
			type: option({
				type: optional(string),
				long: 'type',
				description: 'Gateway type: openclaw (default) or coding',
			}),
		},
		handler: async ({ zoneId, type }) => {
			const resolvedZoneId = zoneId ?? 'default';
			// --type is parsed but scaffold always uses openclaw until Stream 4
			// adds type-specific Dockerfile/config templates. The flag is
			// forward-compatible — passing --type coding is accepted but
			// produces openclaw scaffolding until the templates exist.
			const result = (dependencies.scaffoldAgentVmProject ?? scaffoldAgentVmProject)({
				targetDir: dependencies.getCurrentWorkingDirectory?.() ?? process.cwd(),
				zoneId: resolvedZoneId,
			});
			const keychainStored = await (
				dependencies.promptAndStoreServiceAccountToken ?? promptAndStoreServiceAccountToken
			)();
			io.stdout.write(`${JSON.stringify({ ...result, keychainStored }, null, 2)}\n`);
		},
	});
}
```

Example — controller start:

```typescript
export function createControllerStartCommand(
	io: CliIo,
	dependencies: CliDependencies,
): ReturnType<typeof command> {
	return command({
		name: 'start',
		description: 'Boot the controller, resolve secrets, start gateway VM',
		args: {
			config: option({
				type: optional(string),
				long: 'config',
				short: 'c',
				description: 'Path to system.json',
				defaultValue: () => 'system.json',
			}),
		},
		handler: async ({ config }) => {
			const systemConfig = dependencies.loadSystemConfig(config ?? 'system.json');
			const firstZone = systemConfig.zones[0];
			if (!firstZone) {
				throw new Error('System config does not define any zones.');
			}
			const runtime = await dependencies.startControllerRuntime({
				systemConfig,
				zoneId: firstZone.id,
			});
			io.stdout.write(
				JSON.stringify(
					{
						controllerPort: runtime.controllerPort,
						ingress: runtime.gateway.ingress,
						vmId: runtime.gateway.vm.id,
						zoneId: firstZone.id,
					},
					null,
					2,
				) + '\n',
			);
		},
	});
}
```

- [ ] Create all command definitions following this pattern
- [ ] Run: `pnpm vitest run` — existing tests should still pass (definitions aren't wired yet)
- [ ] Commit: `feat: create cmd-ts command definitions for all CLI commands`

---

## Task 2: Create app factory with DI

**Files:**

- Create: `packages/agent-vm/src/cli/commands/create-app.ts`

```typescript
import { subcommands } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { createInitCommand } from './init-definition.js';
import { createBuildCommand } from './build-definition.js';
// ... all imports

export function createAgentVmApp(
	io: CliIo,
	dependencies: CliDependencies,
): ReturnType<typeof subcommands> {
	const controllerCmds = subcommands({
		name: 'controller',
		description: 'Manage the VM controller',
		cmds: {
			start: createControllerStartCommand(io, dependencies),
			stop: createControllerStopCommand(io, dependencies),
			status: createControllerStatusCommand(io, dependencies),
			ssh: createSshCommand(io, dependencies),
			destroy: createDestroyCommand(io, dependencies),
			upgrade: createUpgradeCommand(io, dependencies),
			logs: createLogsCommand(io, dependencies),
			credentials: subcommands({
				name: 'credentials',
				description: 'Manage credentials',
				cmds: {
					refresh: createCredentialsRefreshCommand(io, dependencies),
				},
			}),
			lease: subcommands({
				name: 'lease',
				description: 'Manage tool VM leases',
				cmds: {
					list: createLeaseListCommand(io, dependencies),
					release: createLeaseReleaseCommand(io, dependencies),
				},
			}),
		},
	});

	return subcommands({
		name: 'agent-vm',
		version: '0.1.0',
		description: 'Gondolin-based VM controller for OpenClaw and coding agents',
		cmds: {
			init: createInitCommand(io, dependencies),
			build: createBuildCommand(io, dependencies),
			doctor: createDoctorCommand(io, dependencies),
			cache: createCacheSubcommands(io, dependencies),
			backup: createBackupSubcommands(io, dependencies),
			openclaw: createOpenClawSubcommands(io, dependencies),
			controller: controllerCmds,
		},
	});
}
```

- [ ] Create the factory
- [ ] Commit: `feat: create app factory with dependency injection for cmd-ts`

---

## Task 3: Wire entrypoint to cmd-ts

**Files:**

- Rewrite: `packages/agent-vm/src/cli/agent-vm-entrypoint.ts`

```typescript
#!/usr/bin/env node
function loadOptionalLocalEnvironmentFile(): void {
	try {
		process.loadEnvFile('.env.local');
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
			return;
		throw new Error(
			`Failed to load .env.local: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}
loadOptionalLocalEnvironmentFile();

import { run } from 'cmd-ts';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { createAgentVmApp } from './commands/create-app.js';

const app = createAgentVmApp(
	{ stderr: process.stderr, stdout: process.stdout },
	defaultCliDependencies,
);

run(app, process.argv.slice(2)).catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
```

The old `runAgentVmCli` function becomes a thin adapter for tests:

```typescript
export async function runAgentVmCli(
	argv: readonly string[],
	io: CliIo,
	dependencies: CliDependencies = defaultCliDependencies,
): Promise<void> {
	const app = createAgentVmApp(io, dependencies);
	await run(app, [...argv]);
}
```

- [ ] Rewrite entrypoint
- [ ] Keep `runAgentVmCli` for test compatibility
- [ ] Delete the manual switch statement
- [ ] Verify: `agent-vm --help` shows all commands
- [ ] Verify: `agent-vm controller --help` shows subcommands
- [ ] Verify: `agent-vm contorller start` suggests "controller"
- [ ] Commit: `feat: wire entrypoint to cmd-ts — --help, usage, typo suggestions`

---

## Task 4: Update tests

**Files:**

- Modify: `packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts`

Tests continue to use `runAgentVmCli(argv, io, dependencies)` — the adapter calls cmd-ts internally. Test assertions may need updating for cmd-ts error message format (more structured than our manual throws).

- [ ] **Step 1: Update existing routing tests**

Existing tests call `runAgentVmCli(['controller', 'start'], io, deps)` and assert the handler was called. These should still work — cmd-ts parses the args and calls the same handler. Update any assertions on error message text (cmd-ts formats errors differently).

- [ ] **Step 2: Add --help tests**

```typescript
it('prints usage text for --help', async () => {
	const stdoutOutput: string[] = [];
	const io = {
		stdout: {
			write: (s: string) => {
				stdoutOutput.push(s);
				return true;
			},
		},
		stderr: { write: () => true },
	};

	// cmd-ts exits with a help "error" — catch it
	await expect(runAgentVmCli(['--help'], io, dependencies)).rejects.toThrow(); // cmd-ts throws on --help

	// Or if cmd-ts writes help to stdout and resolves:
	// expect(stdoutOutput.join('')).toContain('agent-vm');
	// expect(stdoutOutput.join('')).toContain('controller');
	// expect(stdoutOutput.join('')).toContain('init');
	// expect(stdoutOutput.join('')).toContain('build');
});

it('prints controller subcommand help', async () => {
	const stdoutOutput: string[] = [];
	// ... same pattern with ['controller', '--help']
	// expect output to contain 'start', 'stop', 'status', 'ssh'
});
```

Note: cmd-ts may throw on `--help` or write to stdout and resolve — check the actual behavior. The test should verify the help text contains expected command names.

- [ ] **Step 3: Add typo suggestion test**

```typescript
it('suggests correct command on typo', async () => {
	await expect(runAgentVmCli(['contorller', 'start'], io, dependencies)).rejects.toThrow(
		/controller/u,
	); // cmd-ts suggests "controller"
});
```

- [ ] **Step 4: Test unknown subcommand**

```typescript
it('errors on unknown controller subcommand', async () => {
	await expect(runAgentVmCli(['controller', 'nonexistent'], io, dependencies)).rejects.toThrow();
});
```

- [ ] **Step 5: Test each top-level command routes correctly**

Verify that `['init', 'shravan']`, `['build']`, `['doctor']`, `['cache', 'list']`, `['backup', 'list']`, `['openclaw', 'auth', 'codex']`, `['controller', 'start']` all route to the correct handler.

- [ ] **Step 6: Run full check**

Run: `pnpm check`
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git commit -m "test: update CLI tests for cmd-ts migration"
```

---

## Task 5: Output contract — stderr for progress, stdout for JSON

**Files:**

- Modify: `packages/agent-vm/src/cli/commands/controller-definition.ts`
- Modify: any command handler that writes progress to stdout

**Rule:** `io.stdout` is for structured output only. `io.stderr` is for progress, warnings, prompts.

Currently `build-command.ts` uses tasuku which writes to its own stdout. Tasuku needs to be configured to write to stderr, or its output needs to go to stderr via the muted-output pattern.

- [ ] Audit all command handlers for stdout/stderr usage
- [ ] Move all progress/status messages to stderr
- [ ] Keep JSON output on stdout
- [ ] Commit: `fix: separate progress (stderr) from structured output (stdout)`

---

## Task 6: Thread runTask into gateway orchestrator

**Files:**

- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-support.ts` (add runTask to options)
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`

The orchestrator has 5 explicit steps. Each gets a `runTask` call:

```typescript
export async function startGatewayZone(
  options: StartGatewayZoneOptions & { readonly runTask?: RunTaskFn },
  dependencies: GatewayManagerDependencies = {},
): Promise<GatewayZoneStartResult> {
  const runTaskStep = options.runTask ?? (async (_title: string, fn: () => Promise<void>) => fn());

  const zone = findGatewayZone(options.systemConfig, options.zoneId);

  let resolvedSecrets!: Record<string, string>;
  await runTaskStep('Resolving zone secrets', async () => {
    resolvedSecrets = await resolveZoneSecrets({ ... });
  });

  let image!: BuildImageResult;
  await runTaskStep('Building gateway image', async () => {
    image = await buildGatewayImage({ ... });
  });

  let managedVm!: ManagedVm;
  await runTaskStep('Booting gateway VM', async () => {
    managedVm = await createGatewayVm({ ... });
  });

  await runTaskStep('Configuring gateway', async () => {
    await setupGatewayVmRuntime({ ... });
  });

  let ingress!: { host: string; port: number };
  await runTaskStep('Starting OpenClaw', async () => {
    ingress = await startOpenClawInGateway({ ... });
  });

  return { image, ingress, vm: managedVm, zone };
}
```

- [ ] **Step 1: Add RunTaskFn to StartGatewayZoneOptions**

In `gateway-zone-support.ts`:

```typescript
export type RunTaskFn = (title: string, fn: () => Promise<void>) => Promise<void>;

export interface StartGatewayZoneOptions {
	// ... existing fields
	readonly runTask?: RunTaskFn;
}
```

- [ ] **Step 2: Wrap each orchestrator step**

In `gateway-zone-orchestrator.ts`, wrap each step as shown in the code block above.

- [ ] **Step 3: Write tests**

```typescript
// packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts

it('calls runTask for each gateway startup step', async () => {
	const taskTitles: string[] = [];
	const runTask = async (title: string, fn: () => Promise<void>): Promise<void> => {
		taskTitles.push(title);
		await fn();
	};

	await startGatewayZone(
		{ secretResolver, systemConfig, zoneId: 'shravan', runTask },
		{ buildImage, createManagedVm, loadBuildConfig },
	);

	expect(taskTitles).toEqual([
		'Resolving zone secrets',
		'Building gateway image',
		'Booting gateway VM',
		'Configuring gateway',
		'Starting OpenClaw',
	]);
});

it('works without runTask (silent mode)', async () => {
	// Existing tests don't pass runTask — verify they still pass
	const result = await startGatewayZone(
		{ secretResolver, systemConfig, zoneId: 'shravan' },
		{ buildImage, createManagedVm, loadBuildConfig },
	);
	expect(result.ingress.port).toBe(18791);
});
```

- [ ] **Step 4: Update all existing orchestrator tests with runTask bypass**

Add `runTask: async (_t, fn) => fn()` to any test that was already passing — this ensures existing behavior is preserved.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/gateway/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: thread progress callback into gateway orchestrator — 5 steps visible"
```

---

## Task 7: Tasuku progress on controller start

**Files:**

- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts`

```typescript
import task from 'tasuku';

async function defaultRunTask(title: string, fn: () => Promise<void>): Promise<void> {
  await task(title, async ({ startTime, setTitle }) => {
    startTime();
    await fn();
    setTitle(`${title} done`);
  });
}

export async function startControllerRuntime(options, dependencies) {
  const runTaskStep = dependencies.runTask ?? defaultRunTask;

  await runTaskStep('Resolving 1Password secrets', async () => {
    secretResolver = await createSecretResolverFromSystemConfig(...);
  });

  // Pass runTask down to the orchestrator for sub-step progress
  await runTaskStep('Starting gateway zone', async () => {
    gateway = await startGatewayZone({
      ...options,
      runTask: runTaskStep,  // threaded down
    });
  });

  await runTaskStep(`Controller API on :${port}`, async () => {
    serverRef.current = await startControllerHttpServer(...);
  });
}
```

**Important: tasuku writes to stdout via ink. No option to redirect to stderr.** (Verified via deepwiki + live test.) When stdout is piped (not a TTY), ink falls back to static output but still on stdout.

This means we CANNOT call tasuku directly from runtime/orchestrator code — it would mix with JSON output. Instead, all progress goes through a CLI-owned runner abstraction:

```typescript
export type RunTaskFn = (title: string, fn: () => Promise<void>) => Promise<void>;

export async function createRunTask(io: CliIo): Promise<RunTaskFn> {
	if (process.stdout.isTTY) {
		// Interactive terminal — tasuku spinners on stdout (acceptable, user is watching)
		const { default: task } = await import('tasuku');
		return async (title, fn) => {
			await task(title, async ({ startTime }) => {
				startTime();
				await fn();
			});
		};
	}

	// Piped/non-TTY — plain text to stderr, stdout stays clean for JSON
	return async (title, fn) => {
		io.stderr.write(`  ${title}...\n`);
		await fn();
		io.stderr.write(`  ${title} done\n`);
	};
}
```

This runner is created at the CLI layer (command handler) and threaded down to the orchestrator via `runTask` option. Runtime code never imports tasuku directly.

- [ ] **Step 1: Create RunTaskFn type and createRunTask factory**

Create `packages/agent-vm/src/cli/run-task.ts`:

```typescript
export type RunTaskFn = (title: string, fn: () => Promise<void>) => Promise<void>;
```

The factory (`createRunTask`) uses tasuku when TTY, plain stderr when piped.

- [ ] **Step 2: Add cache-check before controller start**

In the controller start command handler, before calling `startControllerRuntime`:

```typescript
const fingerprint = await computeFingerprintFromConfigPath(systemConfig.images.gateway.buildConfig);
const cachePath = path.join(
	systemConfig.cacheDir,
	'images',
	'gateway',
	fingerprint,
	'manifest.json',
);
if (!fs.existsSync(cachePath)) {
	io.stderr.write(
		'[start] Gateway image not cached. Run `agent-vm build` first for faster startup.\n',
	);
	io.stderr.write('[start] Building inline — this may take a few minutes...\n');
}
```

- [ ] **Step 3: Add runTask to ControllerRuntimeDependencies and wrap startup steps**

Thread `runTask` into `startControllerRuntime` and down to `startGatewayZone`. Each orchestrator step gets its own progress call.

- [ ] **Step 4: Write tests**

```typescript
// Test: runTask is called for each startup step
it('calls runTask for secrets, gateway, and controller API', async () => {
	const taskTitles: string[] = [];
	await startControllerRuntime(options, {
		...dependencies,
		runTask: async (title, fn) => {
			taskTitles.push(title);
			await fn();
		},
	});
	expect(taskTitles).toContain('Resolving 1Password secrets');
	expect(taskTitles).toContain('Starting gateway zone');
	expect(taskTitles.some((t) => t.includes('Controller API'))).toBe(true);
});

// Test: orchestrator steps each get their own progress
it('calls runTask for each gateway orchestrator step', async () => {
	const taskTitles: string[] = [];
	await startGatewayZone(
		{
			...options,
			runTask: async (title, fn) => {
				taskTitles.push(title);
				await fn();
			},
		},
		dependencies,
	);
	expect(taskTitles).toContain('Resolving zone secrets');
	expect(taskTitles).toContain('Building gateway image');
	expect(taskTitles).toContain('Booting gateway VM');
	expect(taskTitles).toContain('Configuring gateway');
	expect(taskTitles).toContain('Starting OpenClaw');
});

// Test: cache check warns when not cached
it('warns on stderr when gateway image is not cached', async () => {
	const stderrOutput: string[] = [];
	// ... run start with empty cache dir
	expect(stderrOutput.some((s) => s.includes('not cached'))).toBe(true);
});

// Test: RunTaskFn non-TTY mode writes to stderr only
it('writes progress to stderr when stdout is not a TTY', async () => {
	const stderrOutput: string[] = [];
	const runTask = createRunTaskForPipe({
		write: (s) => {
			stderrOutput.push(s);
			return true;
		},
	});
	await runTask('test step', async () => {});
	expect(stderrOutput).toContain('  test step...\n');
	expect(stderrOutput).toContain('  test step done\n');
});
```

- [ ] **Step 5: Run full check**

Run: `pnpm check`
Expected: all tests pass

- [ ] **Step 6: Verify live**

Run: `agent-vm controller start` — verify per-step progress with spinners.
Run: `agent-vm controller start | jq .ingress` — verify JSON output is clean (no tasuku mixing).

- [ ] **Step 7: Commit**

```bash
git commit -m "feat: tasuku progress on controller start + cache-check warning"
```

---

## Task 8: Gateway type in init

**Files:**

- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/controller/system-config.ts`
- Modify: `packages/agent-vm/src/cli/commands/init-definition.ts`

Add `gateway.type` to system config schema. Init scaffolds different Dockerfiles and configs based on type. Wire the `--type` flag (already parsed in Task 1) through to the scaffold function.

- [ ] **Step 1: Add gatewayType to system config schema**

In `system-config.ts`:

```typescript
const zoneGatewaySchema = z.object({
	type: z.enum(['openclaw', 'coding']).default('openclaw'),
	memory: z.string().min(1),
	// ... rest unchanged
});
```

- [ ] **Step 2: Add gatewayType to scaffold options**

In `init-command.ts`, update `ScaffoldAgentVmProjectOptions`:

```typescript
export interface ScaffoldAgentVmProjectOptions {
	readonly targetDir: string;
	readonly zoneId: string;
	readonly gatewayType?: 'openclaw' | 'coding';
}
```

Add type-specific templates:

```typescript
const gatewayDockerfileByType = {
	openclaw: defaultGatewayDockerfile, // existing — node:24-slim + openclaw
	coding: `FROM node:24-slim\n\nRUN apt-get update && \\\n    apt-get install -y --no-install-recommends \\\n      openssh-server ca-certificates git curl python3 && \\\n    rm -rf /var/lib/apt/lists/* && \\\n    update-ca-certificates && \\\n    npm install -g @openai/codex-cli && \\\n    useradd -m -s /bin/bash coder && \\\n    mkdir -p /workspace /run/sshd && \\\n    chown coder:coder /workspace && \\\n    ln -sf /proc/self/fd /dev/fd 2>/dev/null || true\n`,
};
```

Use `options.gatewayType ?? 'openclaw'` to select templates.

- [ ] **Step 3: Wire --type flag in init command definition**

In `init-definition.ts`, the `--type` arg (already parsed) now passes through:

```typescript
handler: async ({ zoneId, type }) => {
  const result = scaffoldAgentVmProject({
    targetDir: process.cwd(),
    zoneId: zoneId ?? 'default',
    gatewayType: (type ?? 'openclaw') as 'openclaw' | 'coding',
  });
  // ...
},
```

- [ ] **Step 4: Write tests**

```typescript
// packages/agent-vm/src/cli/init-command.test.ts

it('scaffolds openclaw gateway by default', () => {
	const targetDir = createTestDirectory();
	scaffoldAgentVmProject({ targetDir, zoneId: 'test' }, noAgeKeyDeps);
	const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8'));
	expect(config.zones[0].gateway.type).toBe('openclaw');
	const dockerfile = fs.readFileSync(path.join(targetDir, 'images/gateway/Dockerfile'), 'utf8');
	expect(dockerfile).toContain('openclaw@');
});

it('scaffolds coding gateway when type is coding', () => {
	const targetDir = createTestDirectory();
	scaffoldAgentVmProject({ targetDir, zoneId: 'test', gatewayType: 'coding' }, noAgeKeyDeps);
	const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8'));
	expect(config.zones[0].gateway.type).toBe('coding');
	const dockerfile = fs.readFileSync(path.join(targetDir, 'images/gateway/Dockerfile'), 'utf8');
	expect(dockerfile).toContain('codex-cli');
	expect(dockerfile).not.toContain('openclaw@');
});

it('scaffolds different OpenClaw config for openclaw vs no config for coding', () => {
	const openclawDir = createTestDirectory();
	scaffoldAgentVmProject({ targetDir: openclawDir, zoneId: 'test' }, noAgeKeyDeps);
	expect(fs.existsSync(path.join(openclawDir, 'config/test/openclaw.json'))).toBe(true);

	const codingDir = createTestDirectory();
	scaffoldAgentVmProject(
		{ targetDir: codingDir, zoneId: 'test', gatewayType: 'coding' },
		noAgeKeyDeps,
	);
	// Coding gateway doesn't need openclaw.json — has its own config
	expect(fs.existsSync(path.join(codingDir, 'config/test/coding.json'))).toBe(true);
});
```

- [ ] **Step 5: Run full check**

Run: `pnpm check`
Expected: all tests pass

- [ ] **Step 6: Verify live**

```bash
rm -rf /tmp/test-openclaw && mkdir /tmp/test-openclaw && cd /tmp/test-openclaw
agent-vm init test-zone
# Verify: Dockerfile contains openclaw, system.json has type: openclaw

rm -rf /tmp/test-coding && mkdir /tmp/test-coding && cd /tmp/test-coding
agent-vm init test-zone --type coding
# Verify: Dockerfile contains codex-cli, system.json has type: coding
```

- [ ] **Step 7: Commit**

```bash
git commit -m "feat: init supports gateway types — openclaw (default) or coding"
```

---

## Summary

| Stream           | Tasks | What it delivers                                                            |
| ---------------- | ----- | --------------------------------------------------------------------------- |
| cmd-ts migration | 1-4   | --help, usage text, typo suggestions, typed args, clean command definitions |
| Output contract  | 5     | Progress to stderr, JSON to stdout, piping works                            |
| Tasuku progress  | 6-7   | Per-step visibility during controller start (no more frozen terminal)       |
| Gateway types    | 8     | `init --type coding` scaffolds coding agent projects                        |

**Execution order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

After all tasks:

```
agent-vm --help                    # shows all commands
agent-vm controller start          # shows per-step progress
agent-vm controller start | jq .   # JSON output works
agent-vm init shravan --type coding # scaffolds coding project
pnpm check                         # all tests pass
```
