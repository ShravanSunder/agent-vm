# CLI Gateway Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the gateway abstraction at the CLI layer — auth becomes type-aware with provider discovery from the lifecycle, init scaffolds type-appropriate secrets, the hardcoded `openclaw` subcommand group is removed, and all blind `zones[0]` defaults are eliminated.

**Architecture:** The `GatewayLifecycle` interface gains an optional `authConfig` property (not on process spec — it's static, not runtime). Each gateway package owns its auth knowledge. The CLI loads the lifecycle by type and reads `authConfig` generically — agent-vm never mentions OpenClaw in CLI code. All zone-scoped commands require `--zone` explicitly — no implicit zone selection, ever.

**Tech Stack:** TypeScript, cmd-ts, zod, gateway-interface, vitest

**Prior work:** The gateway abstraction (lifecycle interface, orchestrator, packages) is done. `gatewayType` in `controller status` and Zod error formatting are already implemented. This plan finishes the CLI layer.

---

## Why This Work Exists

The gateway abstraction refactored the controller/orchestrator layer so it's gateway-agnostic — it receives specs from a `GatewayLifecycle` interface and executes them generically. But the CLI layer was not refactored. It still has:

1. **`agent-vm openclaw auth codex`** — auth is nested under an `openclaw` subcommand. The SSH command inside hardcodes `openclaw models auth login`. If the zone is a coding gateway, this SSHes in and runs a command that doesn't exist.

2. **Blind `zones[0]` everywhere** — `resolveZoneId()` grabs the first zone when `--zone` is missing. `controller start` grabs `zones[0]`. SSH, logs, destroy, upgrade all do the same. If you have multiple zones, commands silently operate on the wrong one. This is not a default — it's a bug.

3. **Init scaffolds OpenClaw secrets for coding gateways** — `agent-vm init --type coding` creates `DISCORD_BOT_TOKEN`, `PERPLEXITY_API_KEY`, and `OPENCLAW_GATEWAY_TOKEN` in the secrets section. A coding gateway has nothing to do with Discord or OpenClaw tokens.

4. **`parseGatewayType` silently defaults to `'openclaw'`** — even though `--type` is required on init, the function returns `'openclaw'` when called without a type. Dead code that sends the wrong signal.

### Design Principles for This Plan

**`--zone` is always required.** No implicit zone selection. Not even "if there's only one zone, use it." The user must always say which zone they mean. This prevents silent wrong-zone bugs and makes CLI output unambiguous for both humans and agents consuming the CLI programmatically.

**agent-vm never mentions OpenClaw in CLI dispatch code.** The `openclaw-gateway` package owns all OpenClaw-specific knowledge (commands, paths, auth flows). The CLI loads the lifecycle by `zone.gateway.type` via `loadGatewayLifecycle()` and reads generic properties off it. If someone adds a third gateway type with auth, they add `authConfig` to their lifecycle and the CLI works without changes.

**Auth discovery comes from the lifecycle, not hardcoded in the CLI.** This is an intentional interface expansion, not just a bugfix. We are choosing to make auth a first-class part of the lifecycle abstraction because: (a) the auth commands are gateway-type-specific shell commands that only the gateway package knows, (b) hardcoding them in the CLI re-couples agent-vm to OpenClaw, defeating the abstraction, and (c) new gateway types that support auth should work by adding `authConfig` to their lifecycle — zero CLI changes required. `GatewayAuthConfig` is a static property on the lifecycle object (not a method, not on the process spec) — it describes what shell commands to run for listing providers and running login. The `openclaw-gateway` package provides these. The `worker-gateway` package omits it (no auth). The CLI checks `lifecycle.authConfig` — if present, auth works; if absent, clear error.

**Init scaffolding is type-specific.** Each gateway type gets its own secrets, allowed hosts, websocket bypass, and `.env.local` template. OpenClaw gets Discord/Perplexity/gateway token. Coding gets Anthropic/OpenAI API keys. No cross-contamination.

---

## File Structure

### Modified in gateway-interface

| File                                                  | Change                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/gateway-interface/src/gateway-lifecycle.ts` | Add `GatewayAuthConfig` type and optional `authConfig` property to `GatewayLifecycle` |
| `packages/gateway-interface/src/index.ts`             | Re-export `GatewayAuthConfig`                                                         |

### Modified in openclaw-gateway

| File                                                       | Change                    |
| ---------------------------------------------------------- | ------------------------- |
| `packages/openclaw-gateway/src/openclaw-lifecycle.ts`      | Add `authConfig` property |
| `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts` | Test `authConfig`         |

### New in agent-vm

| File                                                                | Responsibility                          |
| ------------------------------------------------------------------- | --------------------------------------- |
| `packages/agent-vm/src/cli/auth-interactive-command.ts`             | Type-aware auth with provider discovery |
| `packages/agent-vm/src/cli/auth-interactive-command.test.ts`        | Tests                                   |
| `packages/agent-vm/src/cli/commands/auth-interactive-definition.ts` | cmd-ts command definition               |

### Modified in agent-vm

| File                                                          | Change                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/agent-vm/src/cli/commands/create-app.ts`            | Replace `openclaw:` with top-level `auth-interactive:`          |
| `packages/agent-vm/src/cli/agent-vm-cli-support.ts`           | Delete `resolveZoneId`, add `requireZone` (strict, no defaults) |
| `packages/agent-vm/src/cli/commands/controller-definition.ts` | Use `requireZone` instead of `zones[0]`                         |
| `packages/agent-vm/src/cli/controller-operation-commands.ts`  | Use `requireZone` instead of `zones[0]`                         |
| `packages/agent-vm/src/cli/init-command.ts`                   | Per-type secret/env templates                                   |
| `packages/agent-vm/src/cli/init-command.test.ts`              | Test per-type scaffolding                                       |

### Deleted

| File                                                    | Reason                                       |
| ------------------------------------------------------- | -------------------------------------------- |
| `packages/agent-vm/src/cli/auth-command.ts`             | Replaced by `auth-interactive-command.ts`    |
| `packages/agent-vm/src/cli/auth-command.test.ts`        | Replaced                                     |
| `packages/agent-vm/src/cli/commands/auth-definition.ts` | Replaced by `auth-interactive-definition.ts` |

---

### Task 1: Add `GatewayAuthConfig` to the Lifecycle Interface

Auth config is a **static property on the lifecycle object**, not on the process spec. It describes what commands to run for auth — available without a running VM, before `buildProcessSpec` is called. This is where gateway-type-specific auth knowledge lives, keeping agent-vm decoupled.

**Files:**

- Modify: `packages/gateway-interface/src/gateway-lifecycle.ts`
- Modify: `packages/gateway-interface/src/index.ts`

- [ ] **Step 1: Define the auth config type and add to lifecycle**

In `packages/gateway-interface/src/gateway-lifecycle.ts`, add before the `GatewayLifecycle` interface:

```ts
/**
 * Describes how to run interactive auth for a gateway type.
 * Static property — available without a running VM.
 * The CLI uses this to query providers and dispatch login via SSH.
 */
export interface GatewayAuthConfig {
	/** Shell command to list available auth providers inside the VM.
	 *  Should output one provider name per line to stdout. */
	readonly listProvidersCommand: string;

	/** Build the shell command for interactive auth login.
	 *  The CLI passes this as the SSH remote command with -t (TTY). */
	readonly buildLoginCommand: (provider: string) => string;
}
```

Add `authConfig` to `GatewayLifecycle`:

```ts
export interface GatewayLifecycle {
	buildVmSpec(
		zone: GatewayZoneConfig,
		resolvedSecrets: Record<string, string>,
		controllerPort: number,
		tcpPool: { readonly basePort: number; readonly size: number },
	): GatewayVmSpec;

	buildProcessSpec(
		zone: GatewayZoneConfig,
		resolvedSecrets: Record<string, string>,
	): GatewayProcessSpec;

	prepareHostState?(zone: GatewayZoneConfig, secretResolver: SecretResolver): Promise<void>;

	/** How to run interactive auth for this gateway type.
	 *  Absent means the gateway type does not support interactive auth. */
	readonly authConfig?: GatewayAuthConfig | undefined;
}
```

- [ ] **Step 2: Re-export from index.ts**

```ts
export type {
	GatewayAuthConfig,
	GatewayLifecycle,
	GatewayZoneConfig,
} from './gateway-lifecycle.js';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter gateway-interface typecheck`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway-interface/
git commit -m "$(cat <<'EOF'
feat: add GatewayAuthConfig to lifecycle interface — static auth discovery per gateway type
EOF
)"
```

---

### Task 2: Add authConfig to OpenClaw Lifecycle

The `openclaw-gateway` package owns the knowledge that auth uses `openclaw models auth list` and `openclaw models auth login`. agent-vm never sees these strings.

**Files:**

- Modify: `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- Modify: `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `openclaw-lifecycle.test.ts` top-level describe:

```ts
describe('authConfig', () => {
	it('provides a list-providers command', () => {
		expect(openclawLifecycle.authConfig).toBeDefined();
		expect(openclawLifecycle.authConfig!.listProvidersCommand).toBe(
			'openclaw models auth list --format plain 2>/dev/null || echo ""',
		);
	});

	it('builds a login command for a given provider', () => {
		expect(openclawLifecycle.authConfig!.buildLoginCommand('codex')).toBe(
			'openclaw models auth login --provider codex',
		);
		expect(openclawLifecycle.authConfig!.buildLoginCommand('openai-codex')).toBe(
			'openclaw models auth login --provider openai-codex',
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`
Expected: FAIL — `authConfig` is undefined.

- [ ] **Step 3: Add authConfig to the lifecycle object**

In `packages/openclaw-gateway/src/openclaw-lifecycle.ts`, add the `authConfig` property to `openclawLifecycle`:

```ts
export const openclawLifecycle: GatewayLifecycle = {
	authConfig: {
		listProvidersCommand: 'openclaw models auth list --format plain 2>/dev/null || echo ""',
		buildLoginCommand: (provider: string): string =>
			`openclaw models auth login --provider ${provider}`,
	},

	buildVmSpec(/* ... existing ... */) {
		/* ... */
	},
	buildProcessSpec(/* ... existing ... */) {
		/* ... */
	},
	async prepareHostState(/* ... existing ... */) {
		/* ... */
	},
};
```

- [ ] **Step 4: Verify worker-gateway has no authConfig**

Add to `packages/worker-gateway/src/worker-lifecycle.test.ts`:

```ts
it('does not support interactive auth', () => {
	expect(workerLifecycle.authConfig).toBeUndefined();
});
```

Run: `pnpm vitest run packages/worker-gateway/src/worker-lifecycle.test.ts`
Expected: PASS — `workerLifecycle` doesn't define `authConfig`.

- [ ] **Step 5: Run all lifecycle tests**

Run: `pnpm vitest run packages/openclaw-gateway/ packages/worker-gateway/`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-gateway/ packages/worker-gateway/
git commit -m "$(cat <<'EOF'
feat: openclaw lifecycle provides authConfig — list + login commands for model providers

worker-gateway has no authConfig — interactive auth not supported.
EOF
)"
```

---

### Task 3: Require `--zone` Everywhere — No Implicit Zone Selection

Delete `resolveZoneId` (blind `zones[0]`). Add `requireZone` that always requires `--zone`. **Every** zone-scoped CLI command must pass it — no exceptions, not even for single-zone configs.

**`agent-vm controller start` without `--zone` is an error.** Even if the config has one zone. The user must always be explicit. This applies equally to single-zone and multi-zone configs.

**Every zone-scoped command that needs updating:**

| Command                          | Current behavior                                            | File                                           |
| -------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `controller start`               | `zones[0]` with single-zone guard                           | `controller-definition.ts:88-98`               |
| `controller ssh`                 | `--zone` optional, passed through                           | `controller-definition.ts:131-153`             |
| `controller logs`                | `--zone` optional via `createControllerOperationSubcommand` | `controller-definition.ts:165-169`             |
| `controller destroy`             | `--zone` optional via `createControllerOperationSubcommand` | `controller-definition.ts:154-159`             |
| `controller upgrade`             | `--zone` optional via `createControllerOperationSubcommand` | `controller-definition.ts:160-164`             |
| `controller credentials refresh` | `--zone` optional                                           | `controller-definition.ts:174-189`             |
| `controller stop`                | No zone needed (stops the whole controller)                 | Not affected                                   |
| `controller status`              | No zone needed (shows all zones)                            | Not affected                                   |
| `controller lease list/release`  | No zone needed (global)                                     | Not affected                                   |
| Old `openclaw auth`              | `resolveZoneId` blind default                               | Being replaced by `auth-interactive` in Task 5 |
| `backup create/restore/list`     | Uses `--zone` via `resolveZoneId`                           | `backup-definition.ts`                         |

The `createControllerOperationSubcommand` helper at `controller-definition.ts:24-57` generates commands with optional `--zone` via `supportsZone`. This helper passes `--zone` through to `runControllerOperationCommand` which calls `resolveZoneId`. Fix: make `--zone` required on all zone-scoped subcommands generated by this helper, and pass through `requireZone` instead of the old `resolveZoneId`.

**Files:**

- Modify: `packages/agent-vm/src/cli/agent-vm-cli-support.ts`
- Modify: `packages/agent-vm/src/cli/commands/controller-definition.ts`
- Modify: `packages/agent-vm/src/cli/controller-operation-commands.ts`
- Modify: `packages/agent-vm/src/cli/ssh-commands.ts`
- Modify: `packages/agent-vm/src/cli/commands/backup-definition.ts`
- Modify: `packages/agent-vm/src/cli/backup-commands.ts`

- [ ] **Step 1: Replace `resolveZoneId` with `requireZone`**

In `packages/agent-vm/src/cli/agent-vm-cli-support.ts`, delete `resolveZoneId` and add:

```ts
/**
 * Require a zone to be specified explicitly.
 * Never defaults to zones[0]. If --zone is missing, throws with available zone names.
 */
export function requireZone(
	systemConfig: SystemConfig,
	zoneFlag: string | undefined,
): SystemConfig['zones'][number] {
	if (zoneFlag) {
		return findZone(systemConfig, zoneFlag);
	}

	const zoneNames = systemConfig.zones.map((z) => z.id).join(', ');
	throw new Error(`--zone is required. Available zones: ${zoneNames}`);
}
```

- [ ] **Step 2: Update `controller start` — add `--zone`, remove single-zone guard**

`controller start` currently has no `--zone` arg (line 85-87) and uses a `zones.length !== 1` guard + `zones[0]`. Replace with `requireZone`:

```ts
start: command({
	name: 'start',
	description: 'Boot the controller and gateway',
	args: {
		config: createConfigOption(),
		zone: createZoneOption(),
	},
	handler: async ({ config, zone: zoneFlag }) => {
		const systemConfig = await loadSystemConfigFromOption(config, dependencies);
		const zone = requireZone(systemConfig, zoneFlag);

		await warnIfGatewayImageCacheIsCold(io, systemConfig);
		const runTask = await createRunTask(io);
		const runtime = await dependencies.startControllerRuntime(
			{ systemConfig, zoneId: zone.id },
			{ runTask },
		);
		// ... output JSON with zone.id
	},
}),
```

Delete the `zones.length !== 1` guard and the `zones[0]` grab entirely.

- [ ] **Step 3: Update `createControllerOperationSubcommand` helper**

This helper at line 24-57 conditionally adds `--zone` via `supportsZone`. Change it so zone-scoped commands always require `--zone` via `requireZone`. The helper passes zone through `appendZoneArgument` to `runControllerOperationCommand` — replace that path with direct `requireZone` validation.

- [ ] **Step 4: Update `ssh`, `logs`, `destroy`, `upgrade`, `credentials refresh`**

Each of these passes `--zone` optionally. Make it required by using `requireZone(systemConfig, zoneFlag)` at the command handler level. The list:

- `ssh` (line 131-153) — already has `zone: createZoneOption()`, add `requireZone` call
- `logs` (line 165-169) — via helper, needs `supportsZone` path to use `requireZone`
- `destroy` (line 154-159) — via helper
- `upgrade` (line 160-164) — via helper
- `credentials refresh` (line 174-189) — has `zone: createZoneOption()`, add `requireZone` call

- [ ] **Step 5: Update backup commands**

`backup-definition.ts` uses `--zone` via `resolveZoneId`. Replace with `requireZone`.

- [ ] **Step 3: Update `controller-operation-commands.ts`**

Replace `systemConfig.zones[0]` in the `start` case with `requireZone(systemConfig, zoneFlag)`. Thread the `--zone` arg through from the caller.

- [ ] **Step 4: Grep for any remaining `zones[0]`**

```bash
grep -rn "zones\[0\]" packages/agent-vm/src/ --include="*.ts" | grep -v ".test.ts" | grep -v node_modules | grep -v dist
```

Expected: zero matches in non-test source files.

- [ ] **Step 5: Grep for any remaining `resolveZoneId`**

```bash
grep -rn "resolveZoneId" packages/agent-vm/src/ --include="*.ts" | grep -v node_modules | grep -v dist
```

Expected: zero matches.

- [ ] **Step 6: Update tests**

Tests that previously relied on implicit zone selection need `--zone` added to their command args. Tests should verify:

- With `--zone shravan`: works
- Without `--zone`: throws with "Available zones: ..."

- [ ] **Step 7: Run full suite**

Run: `pnpm vitest run`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-vm/src/cli/
git commit -m "$(cat <<'EOF'
fix: require --zone on all zone-scoped commands — no implicit zone selection

Delete resolveZoneId. Add requireZone that throws with available zone
names when --zone is missing. Zero zones[0] references remain.
EOF
)"
```

---

### Task 4: Build Type-Aware `auth-interactive` Command

The command:

1. Requires `--zone` (via `requireZone`)
2. Loads the lifecycle for that zone's gateway type
3. Checks `lifecycle.authConfig` — throws if absent
4. Without provider arg: queries the running VM for available providers via `authConfig.listProvidersCommand`, displays them
5. With provider arg: SSHs in and runs `authConfig.buildLoginCommand(provider)` interactively

**Files:**

- Create: `packages/agent-vm/src/cli/auth-interactive-command.ts`
- Create: `packages/agent-vm/src/cli/auth-interactive-command.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/agent-vm/src/cli/auth-interactive-command.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { listAuthProviders, runAuthInteractiveCommand } from './auth-interactive-command.js';

describe('listAuthProviders', () => {
	it('queries the VM and parses provider names from stdout', async () => {
		const execInZone = vi.fn(async () => ({
			exitCode: 0,
			stdout: 'codex\nopenai-codex\nanthropic\n',
			stderr: '',
		}));

		const providers = await listAuthProviders({
			controllerClient: { execInZone } as never,
			listProvidersCommand: 'list-cmd',
			zoneId: 'shravan',
		});

		expect(providers).toEqual(['codex', 'openai-codex', 'anthropic']);
		expect(execInZone).toHaveBeenCalledWith('shravan', 'list-cmd');
	});

	it('returns empty array when command produces no output', async () => {
		const execInZone = vi.fn(async () => ({
			exitCode: 0,
			stdout: '',
			stderr: '',
		}));

		const providers = await listAuthProviders({
			controllerClient: { execInZone } as never,
			listProvidersCommand: 'list-cmd',
			zoneId: 'z1',
		});

		expect(providers).toEqual([]);
	});
});

describe('runAuthInteractiveCommand', () => {
	it('throws when the lifecycle has no authConfig', async () => {
		await expect(
			runAuthInteractiveCommand({
				authConfig: undefined,
				dependencies: { createControllerClient: vi.fn(), runInteractiveProcess: vi.fn() } as never,
				io: { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } },
				provider: 'codex',
				systemConfig: { host: { controllerPort: 18800 } } as never,
				zoneId: 'test',
			}),
		).rejects.toThrow(/does not support interactive auth/i);
	});

	it('lists providers when no provider argument is given', async () => {
		const writes: string[] = [];
		const execInZone = vi.fn(async () => ({
			exitCode: 0,
			stdout: 'codex\nanthropic\n',
			stderr: '',
		}));

		await runAuthInteractiveCommand({
			authConfig: {
				listProvidersCommand: 'list-cmd',
				buildLoginCommand: (p: string) => `login ${p}`,
			},
			dependencies: {
				createControllerClient: vi.fn(() => ({
					enableZoneSsh: vi.fn(),
					execInZone,
				})) as never,
				runInteractiveProcess: vi.fn(),
			} as never,
			io: { stdout: { write: (s: string) => writes.push(s) }, stderr: { write: vi.fn() } },
			provider: undefined,
			systemConfig: { host: { controllerPort: 18800 } } as never,
			zoneId: 'test',
		});

		expect(execInZone).toHaveBeenCalledWith('test', 'list-cmd');
		expect(writes.join('')).toContain('codex');
		expect(writes.join('')).toContain('anthropic');
	});

	it('runs interactive SSH with the login command when provider is given', async () => {
		const runInteractiveProcess = vi.fn(async () => {});
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			port: 2222,
			identityFile: '/tmp/key',
			user: 'root',
		}));

		await runAuthInteractiveCommand({
			authConfig: {
				listProvidersCommand: 'list-cmd',
				buildLoginCommand: (p: string) => `login --provider ${p}`,
			},
			dependencies: {
				createControllerClient: vi.fn(() => ({
					enableZoneSsh,
					execInZone: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
				})) as never,
				runInteractiveProcess,
			} as never,
			io: { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } },
			provider: 'codex',
			systemConfig: { host: { controllerPort: 18800 } } as never,
			zoneId: 'shravan',
		});

		expect(enableZoneSsh).toHaveBeenCalledWith('shravan');
		expect(runInteractiveProcess).toHaveBeenCalledWith(
			'ssh',
			expect.arrayContaining(['-t', 'root@127.0.0.1', 'login --provider codex']),
		);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/agent-vm/src/cli/auth-interactive-command.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `auth-interactive-command.ts`**

```ts
import type { GatewayAuthConfig } from 'gateway-interface';

import type { SystemConfig } from '../config/system-config.js';
import {
	type CliDependencies,
	type CliIo,
	resolveControllerBaseUrl,
} from './agent-vm-cli-support.js';
import { zoneSshAccessResponseSchema } from './ssh-commands.js';

export async function listAuthProviders(options: {
	readonly controllerClient: {
		readonly execInZone: (zoneId: string, command: string) => Promise<{ readonly stdout: string }>;
	};
	readonly listProvidersCommand: string;
	readonly zoneId: string;
}): Promise<readonly string[]> {
	const result = await options.controllerClient.execInZone(
		options.zoneId,
		options.listProvidersCommand,
	);
	return result.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export async function runAuthInteractiveCommand(options: {
	readonly authConfig: GatewayAuthConfig | undefined;
	readonly dependencies: Pick<CliDependencies, 'createControllerClient' | 'runInteractiveProcess'>;
	readonly io: CliIo;
	readonly provider: string | undefined;
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
}): Promise<void> {
	if (!options.authConfig) {
		throw new Error(
			`Zone '${options.zoneId}' does not support interactive auth. ` +
				'Only gateway types that provide authConfig (e.g. openclaw) support this command.',
		);
	}

	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});

	if (!options.provider) {
		const providers = await listAuthProviders({
			controllerClient,
			listProvidersCommand: options.authConfig.listProvidersCommand,
			zoneId: options.zoneId,
		});
		if (providers.length === 0) {
			options.io.stdout.write('No auth providers available.\n');
			return;
		}
		options.io.stdout.write('Available auth providers:\n');
		for (const provider of providers) {
			options.io.stdout.write(`  ${provider}\n`);
		}
		return;
	}

	const sshResponse = zoneSshAccessResponseSchema.parse(
		await controllerClient.enableZoneSsh(options.zoneId),
	);
	if (!sshResponse.host || !sshResponse.port) {
		throw new Error(
			`Cannot auth: controller returned incomplete SSH access for zone '${options.zoneId}'.`,
		);
	}

	const loginCommand = options.authConfig.buildLoginCommand(options.provider);
	const sshArguments = [
		'-t',
		'-o',
		'StrictHostKeyChecking=no',
		'-o',
		'UserKnownHostsFile=/dev/null',
		...(sshResponse.identityFile ? ['-i', sshResponse.identityFile] : []),
		'-p',
		String(sshResponse.port),
		`${sshResponse.user ?? 'root'}@${sshResponse.host}`,
		loginCommand,
	];

	const runInteractiveProcess =
		options.dependencies.runInteractiveProcess ??
		(async (command: string, arguments_: readonly string[]): Promise<void> => {
			const { execa } = await import('execa');
			await execa(command, arguments_, { stdio: 'inherit' });
		});

	try {
		await runInteractiveProcess('ssh', sshArguments);
	} catch (error) {
		throw new Error(
			`Auth failed for ${options.provider} in zone '${options.zoneId}': ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/cli/auth-interactive-command.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/cli/auth-interactive-command.ts packages/agent-vm/src/cli/auth-interactive-command.test.ts
git commit -m "$(cat <<'EOF'
feat: auth-interactive command — type-aware auth with provider discovery

Reads authConfig from the lifecycle interface. No openclaw references.
Lists providers when no argument given. SSHs in for interactive login.
EOF
)"
```

---

### Task 5: Wire `auth-interactive` into CLI and Delete Old Auth

**Files:**

- Create: `packages/agent-vm/src/cli/commands/auth-interactive-definition.ts`
- Modify: `packages/agent-vm/src/cli/commands/create-app.ts`
- Delete: `packages/agent-vm/src/cli/auth-command.ts`
- Delete: `packages/agent-vm/src/cli/auth-command.test.ts`
- Delete: `packages/agent-vm/src/cli/commands/auth-definition.ts`

- [ ] **Step 1: Create the cmd-ts command definition**

`packages/agent-vm/src/cli/commands/auth-interactive-definition.ts`:

```ts
// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, optional, positional, string } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { requireZone, resolveControllerBaseUrl } from '../agent-vm-cli-support.js';
import { runAuthInteractiveCommand } from '../auth-interactive-command.js';
import { loadGatewayLifecycle } from '../../gateway/gateway-lifecycle-loader.js';
import {
	createConfigOption,
	createZoneOption,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

export function createAuthInteractiveCommand(io: CliIo, dependencies: CliDependencies) {
	return command({
		name: 'auth-interactive',
		description:
			'Run interactive auth for a gateway zone. Lists providers when called without a provider argument.',
		args: {
			config: createConfigOption(),
			provider: positional({
				displayName: 'provider',
				type: optional(string),
				description: 'Provider name (e.g. codex). Omit to list available providers.',
			}),
			zone: createZoneOption(),
		},
		handler: async ({ config, provider, zone: zoneFlag }) => {
			const systemConfig = await loadSystemConfigFromOption(config, dependencies);
			const zone = requireZone(systemConfig, zoneFlag);
			const lifecycle = loadGatewayLifecycle(zone.gateway.type);

			await runAuthInteractiveCommand({
				authConfig: lifecycle.authConfig,
				dependencies,
				io,
				provider: provider ?? undefined,
				systemConfig,
				zoneId: zone.id,
			});
		},
	});
}
```

- [ ] **Step 2: Update `create-app.ts`**

Replace `openclaw: createOpenClawSubcommands(io, dependencies)` with `'auth-interactive': createAuthInteractiveCommand(io, dependencies)`. Remove the `createOpenClawSubcommands` import, add `createAuthInteractiveCommand` import.

- [ ] **Step 3: Delete old auth files**

```bash
rm packages/agent-vm/src/cli/auth-command.ts
rm packages/agent-vm/src/cli/auth-command.test.ts
rm packages/agent-vm/src/cli/commands/auth-definition.ts
```

- [ ] **Step 4: Remove stale imports and update tests**

```bash
grep -rn "auth-command\|auth-definition\|createOpenClawSubcommands" packages/agent-vm/src/ --include="*.ts" | grep -v node_modules | grep -v dist
```

Remove all found. Update `agent-vm-entrypoint.test.ts`: remove tests for the old `openclaw auth` path, add tests for `auth-interactive`.

- [ ] **Step 5: Run full suite**

Run: `pnpm vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A packages/agent-vm/src/cli/
git commit -m "$(cat <<'EOF'
feat: replace openclaw subcommand with top-level auth-interactive

auth-interactive loads the lifecycle, reads authConfig, dispatches
generically. agent-vm CLI has zero openclaw command references.
EOF
)"
```

---

### Task 6: Per-Type Init Scaffolding

Init scaffolds OpenClaw-specific secrets (`DISCORD_BOT_TOKEN`, `OPENCLAW_GATEWAY_TOKEN`) for both types. Fix so each type gets appropriate defaults.

**Files:**

- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/agent-vm/src/cli/init-command.test.ts`:

```ts
it('scaffolds coding-appropriate secrets for coding type', async () => {
	const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-coding-'));
	createdDirectories.push(targetDir);

	await scaffoldAgentVmProject({ gatewayType: 'coding', targetDir, zoneId: 'test-coding' });

	const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8'));
	const secrets = config.zones[0].secrets;

	expect(secrets).not.toHaveProperty('DISCORD_BOT_TOKEN');
	expect(secrets).not.toHaveProperty('OPENCLAW_GATEWAY_TOKEN');
	expect(secrets).toHaveProperty('ANTHROPIC_API_KEY');
});

it('scaffolds openclaw-appropriate secrets for openclaw type', async () => {
	const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-oc-'));
	createdDirectories.push(targetDir);

	await scaffoldAgentVmProject({ gatewayType: 'openclaw', targetDir, zoneId: 'test-oc' });

	const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8'));
	const secrets = config.zones[0].secrets;

	expect(secrets).toHaveProperty('DISCORD_BOT_TOKEN');
	expect(secrets).toHaveProperty('OPENCLAW_GATEWAY_TOKEN');
	expect(secrets).not.toHaveProperty('ANTHROPIC_API_KEY');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts`
Expected: FAIL — coding type scaffolds openclaw secrets.

- [ ] **Step 3: Split secrets, allowed hosts, websocket bypass, and env template by type**

In `packages/agent-vm/src/cli/init-command.ts`:

```ts
function defaultSecretsForGatewayType(gatewayType: GatewayType): Record<string, object> {
	if (gatewayType === 'coding') {
		return {
			ANTHROPIC_API_KEY: {
				source: '1password',
				injection: 'http-mediation',
				hosts: ['api.anthropic.com'],
			},
			OPENAI_API_KEY: {
				source: '1password',
				injection: 'http-mediation',
				hosts: ['api.openai.com'],
			},
		};
	}

	return {
		DISCORD_BOT_TOKEN: { source: '1password', injection: 'env' },
		PERPLEXITY_API_KEY: {
			source: '1password',
			hosts: ['api.perplexity.ai'],
			injection: 'http-mediation',
		},
		OPENCLAW_GATEWAY_TOKEN: { source: '1password', injection: 'env' },
	};
}

function defaultAllowedHostsForGatewayType(gatewayType: GatewayType): string[] {
	if (gatewayType === 'coding') {
		return [
			'api.anthropic.com',
			'api.openai.com',
			'auth.openai.com',
			'api.github.com',
			'registry.npmjs.org',
		];
	}
	return [
		'api.openai.com',
		'auth.openai.com',
		'api.perplexity.ai',
		'discord.com',
		'cdn.discordapp.com',
		'api.github.com',
		'registry.npmjs.org',
	];
}

function defaultWebsocketBypassForGatewayType(gatewayType: GatewayType): string[] {
	if (gatewayType === 'coding') {
		return [];
	}
	return [
		'gateway.discord.gg:443',
		'web.whatsapp.com:443',
		'g.whatsapp.net:443',
		'mmg.whatsapp.net:443',
	];
}

function defaultEnvTemplateForGatewayType(gatewayType: GatewayType): string {
	const header =
		'# agent-vm environment configuration\n# 1Password token is stored in macOS Keychain by agent-vm init.\n# Only set this for CI or non-macOS environments:\n# OP_SERVICE_ACCOUNT_TOKEN=\n\n# === Secret References (1Password op:// URIs) ===\n';
	if (gatewayType === 'coding') {
		return (
			header +
			'ANTHROPIC_API_KEY_REF=op://agent-vm/agent-anthropic/api-key\nOPENAI_API_KEY_REF=op://agent-vm/agent-openai/api-key\n'
		);
	}
	return (
		header +
		'DISCORD_BOT_TOKEN_REF=op://agent-vm/agent-discord-app/bot-token\nPERPLEXITY_API_KEY_REF=op://agent-vm/agent-perplexity/credential\nOPENCLAW_GATEWAY_TOKEN_REF=op://agent-vm/agent-shravan-claw-gateway/password\n'
	);
}
```

Use these in `defaultSystemConfig` and replace the hardcoded `defaultEnvTemplate`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts
git commit -m "$(cat <<'EOF'
feat: init scaffolds per-type secrets, hosts, and env templates

openclaw: Discord, Perplexity, gateway token.
coding: Anthropic, OpenAI API keys.
No cross-contamination between types.
EOF
)"
```

---

### Task 7: Clean Up Dead Code

**Files:**

- Modify: `packages/agent-vm/src/cli/commands/command-definition-support.ts`

- [ ] **Step 1: Remove `parseGatewayType` default to openclaw**

In `command-definition-support.ts`, `parseGatewayType` returns `'openclaw'` when no type is given (line 90). The `--type` flag is required on `init`, so this default is dead code. Remove the default:

```ts
export function parseGatewayType(gatewayType: string | undefined): GatewayType {
	if (gatewayType === 'openclaw') {
		return gatewayType;
	}
	if (gatewayType === 'coding') {
		return gatewayType;
	}

	throw new Error(
		`Gateway type is required. Expected 'openclaw' or 'coding'${gatewayType ? `, got '${gatewayType}'` : ''}.`,
	);
}
```

- [ ] **Step 2: Grep for any remaining blind defaults**

```bash
grep -rn "?? 'openclaw'" packages/agent-vm/src/ --include="*.ts" | grep -v ".test.ts" | grep -v node_modules | grep -v dist
```

Expected: zero matches (the init-command default `gatewayType ?? 'openclaw'` should also be removed since `--type` is required).

- [ ] **Step 3: Run full suite**

Run: `pnpm check && pnpm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/cli/
git commit -m "$(cat <<'EOF'
fix: remove dead openclaw defaults — gateway type is always required
EOF
)"
```

---

### Task 8: Verification and E2E

- [ ] **Step 1: Verify CLI help**

```bash
agent-vm --help
```

Expected: shows `auth-interactive` (not `openclaw`).

```bash
agent-vm auth-interactive --help
```

Expected: shows provider as optional positional, `--zone` required.

- [ ] **Step 2: Grep for hardcoded openclaw in CLI command structure**

```bash
grep -rn "openclaw" packages/agent-vm/src/cli/ --include="*.ts" | grep -v ".test.ts" | grep -v node_modules | grep -v dist
```

Expected: only in init-command.ts scaffolding templates (Dockerfile content, config file names, OpenClaw config defaults). Zero in command definitions or dispatch logic.

- [ ] **Step 3: Grep for zones[0]**

```bash
grep -rn "zones\[0\]" packages/agent-vm/src/ --include="*.ts" | grep -v ".test.ts" | grep -v node_modules | grep -v dist
```

Expected: zero matches.

- [ ] **Step 4: Grep for resolveZoneId**

```bash
grep -rn "resolveZoneId" packages/agent-vm/src/ --include="*.ts" | grep -v node_modules | grep -v dist
```

Expected: zero matches.

- [ ] **Step 5: Verify auth-interactive against running VM**

```bash
cd /path/to/agent-vm-workspace
agent-vm controller start --zone shravan

# List providers (no argument) — should query the running gateway
agent-vm auth-interactive --zone shravan

# Auth with a specific provider (interactive TTY)
agent-vm auth-interactive codex --zone shravan
```

- [ ] **Step 6: Verify coding zone rejects auth**

Set up a coding zone in config, then:

```bash
agent-vm auth-interactive --zone test-coding
```

Expected: "Zone 'test-coding' does not support interactive auth."

- [ ] **Step 7: Verify missing --zone errors helpfully**

```bash
agent-vm controller logs
agent-vm auth-interactive
```

Expected: "--zone is required. Available zones: shravan" (or whatever zones are configured).

- [ ] **Step 8: Run pnpm check and test**

```bash
pnpm check && pnpm test
```

Expected: all pass.
