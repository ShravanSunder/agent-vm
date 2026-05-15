# Ephemeral Credential Runner VM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an always-ephemeral Credential Runner VM path for auth-heavy CLIs so agents can invoke registered credentialed tools without receiving raw OAuth, keyring, SigV4, or provider credentials.

**Architecture:** The normal Tool VM remains the agent workspace shell; it does not get auth-heavy credential state. OpenClaw registers a typed gateway tool that posts structured `{ runnerId, commandId, argv }` requests to the agent-vm controller, and the controller creates a fresh Credential Runner VM per invocation, materializes only the credentials needed for that command, runs one registered binary with argv semantics, captures bounded output, and destroys the VM. This plan supersedes the broad OAuth/keyring portions of `docs/superpowers/plans/2026-05-10-gondolin-secret-source.md`; that plan should remain scoped to header-token HTTP mediation, while `docs/superpowers/plans/2026-05-10-mcp-capability-portal.md` remains the separate MCP progressive-disclosure portal.

**Tech Stack:** TypeScript, Zod, Hono controller routes, `@earendil-works/gondolin` VM argv execution, OpenClaw `api.registerTool`, existing agent-vm secret resolver, Vitest.

---

## Decision Record: How We Got Here

This plan is the outcome of the auth idea maze:

1. We first tried to stretch `gondolin-secret-source` to cover every integration.
2. That is correct for simple header-token tools: GitHub API tokens, Linear, Readwise, OpenAI, Groq, Together, Anthropic, ElevenLabs, and similar clients that can put a placeholder in an HTTP header.
3. That is not a good fit for stateful or signer-based tools: `gog`, Google OAuth keyrings, AWS SigV4, `gcloud`, `az`, and CLIs that expect local credential stores or request signing.
4. We considered a host/gateway daemon. DeepWiki confirms OpenClaw/Gondolin treat the gateway/host as trusted and the guest as adversarial, but the project constraint is stricter: do not let the agent cause arbitrary credentialed command execution on the host.
5. We considered a separate service user inside the normal Tool VM. That still leaves the auth service inside the same broad shell environment as the agent, so it is not a clean enough boundary for keyrings or signer state.
6. We settled on an always-ephemeral Credential Runner VM. It is slower than a cached daemon, but it removes runner state reuse, cross-agent leakage, persistent keyrings, and most lifecycle complexity.

## Relation To Existing Plans

- `2026-05-10-gondolin-secret-source.md`
  - Keep for Tool VM egress allowlists and HTTP-mediated header secrets.
  - Remove or split out gateway-side Google OAuth/keyring refresh registry work when implementing this plan.
  - Do not expose a broad `POST /lease/:leaseId/secrets/:secretName` route for stateful CLI auth; this runner path avoids that controller-wide lease mutation surface.

- `2026-05-10-mcp-capability-portal.md`
  - Keep separate.
  - MCP portal brokers MCP servers and skills through gateway tools.
  - Credential Runner VM brokers registered CLIs that need credential materialization.
  - Neither plan should own the other's transport or auth model.

- `zone_git_push`
  - Use as the control-plane pattern: OpenClaw gateway tool calls controller with a scoped capability token, while the controller owns the real operation.
  - Do not copy the exact implementation blindly. `zone_git_push` performs a controller-side git push; Credential Runner must create an ephemeral VM and run argv-only process execution.

## Evidence To Preserve

- `packages/openclaw-agent-vm-plugin/src/zone-git-tool.ts` registers `zone_git_push` and only POSTs to `controllerUrl/zones/:zoneId/zone-git/push` with `x-agent-vm-zone-git-token`.
- `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts` verifies the zone-git capability token before calling `operations.pushZoneGit`.
- `packages/agent-vm/src/controller/controller-runtime.ts` resolves `host.githubToken` for the controller-owned zone Git operation, proving credentials do not need to live in the gateway tool handler or Tool VM.
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts` and `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-shell-script.ts` use shell-script execution for normal sandbox commands. Credential Runner execution must not reuse this shell path.
- `packages/gondolin-adapter/src/vm-adapter.ts` currently narrows Gondolin exec to `exec(command: string)`, even though the local Gondolin source supports `vm.exec(["/bin/echo", "hello"])`. This plan must add an argv execution surface.
- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts` creates normal Tool VMs with agent workspace mounts and SSH access. Credential Runner VMs must be a separate lifecycle, with no `/work` mount by default and no SSH exposure.
- DeepWiki for `openclaw/openclaw` and `earendil-works/gondolin` confirms the documented upstream model: the host/gateway is trusted, the guest VM is adversarial, and Gondolin secret injection avoids raw secret exposure to the guest. The separate ephemeral runner is our stricter design inference from the project constraint: auth-heavy CLIs should not run on the gateway host or in the normal Tool VM.
- DeepWiki for `openclaw/gogcli` reports that `gogcli` supports `--access-token`, `--no-input`, `GOG_ACCOUNT`, `GOG_KEYRING_BACKEND=file`, and `GOG_KEYRING_PASSWORD`. This plan uses the short-lived access-token path for the first Google Calendar runner to avoid persistent keyring state inside the VM.

## Non-Goals

- Do not create a generic credentialed shell.
- Do not allow arbitrary binary paths.
- Do not execute credentialed CLIs on the gateway host.
- Do not mount `/work` into the Credential Runner VM by default.
- Do not cache or reuse Credential Runner VMs.
- Do not persist OAuth keyrings or signer state inside a runner rootfs.
- Do not use the OpenClaw sandbox shell execution helper for credentialed execution.
- Do not build the MCP portal in this plan.

## File Structure

Create:

- `packages/agent-vm/src/controller/credential-runner/credential-runner-types.ts`
  - Shared request, response, config, argv policy, command registry, and runner result types.
- `packages/agent-vm/src/controller/credential-runner/credential-runner-policy.ts`
  - Validates registered command IDs, argv prefixes, byte limits, and disallowed environment overrides.
- `packages/agent-vm/src/controller/credential-runner/credential-runner-capability-store.ts`
  - Issues and verifies scoped gateway-to-controller capability tokens for credential runner calls.
- `packages/agent-vm/src/controller/credential-runner/google-oauth-access-token.ts`
  - Exchanges host-resolved Google OAuth refresh credentials for a short-lived access token.
- `packages/agent-vm/src/controller/credential-runner/credential-runner-vm-lifecycle.ts`
  - Creates one ephemeral VM, runs one argv command, captures output, and closes the VM in `finally`.
- `packages/agent-vm/src/controller/credential-runner/credential-runner-service.ts`
  - Orchestrates config lookup, capability verification, policy validation, secret materialization, VM execution, redaction, and result shaping.
- `packages/agent-vm/src/controller/http/controller-credential-runner-routes.ts`
  - Adds controller HTTP routes for credential runner execution.
- `packages/openclaw-agent-vm-plugin/src/credential-runner-tool.ts`
  - Registers the OpenClaw `credential_runner_execute` tool and proxies requests to the controller.
- `packages/agent-vm/src/controller/credential-runner/*.test.ts`
  - Unit tests for policy, token store, Google OAuth token exchange, lifecycle close behavior, and service orchestration.

Modify:

- `packages/gondolin-adapter/src/vm-adapter.ts`
  - Adds `execArgv(command: readonly [string, ...string[]])`.
- `packages/gondolin-adapter/src/vm-adapter.test.ts`
  - Proves argv execution reaches Gondolin without shell-string conversion.
- `packages/agent-vm/src/config/system-config.ts`
  - Adds `credentialRunners` schema.
- `packages/agent-vm/src/config/system-config.test.ts`
  - Tests config parsing and invalid runner configs.
- `packages/agent-vm/src/controller/controller-runtime.ts`
  - Creates the credential runner capability store and wires controller operations.
- `packages/agent-vm/src/controller/controller-runtime-types.ts`
  - Adds credential runner operation types.
- `packages/agent-vm/src/controller/http/controller-http-routes.ts`
  - Registers credential runner routes.
- `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`
  - Parses `credentialRunnerToken` / `credentialRunnerTokenEnv`.
- `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
  - Registers `credential_runner_execute` alongside `zone_git_push`.
- `packages/openclaw-agent-vm-plugin/openclaw.plugin.json`
  - Documents the new tool and plugin config fields.
- `docs/reference/configuration/system-json.md`
  - Documents `credentialRunners`.
- `docs/subsystems/secrets-and-credentials.md`
  - Explains the split between HTTP-mediated secrets and ephemeral credential runners.
- `docs/architecture/openclaw-gateway.md`
  - Adds the gateway/controller/runner flow.
- `docs/superpowers/plans/2026-05-10-gondolin-secret-source.md`
  - Keeps a cross-reference note that auth-heavy CLI execution moved to this plan.

---

### Task 1: Add The Argv VM Execution Surface

**Files:**
- Modify: `packages/gondolin-adapter/src/vm-adapter.ts`
- Modify: `packages/gondolin-adapter/src/vm-adapter.test.ts`

- [ ] **Step 1: Write the failing argv execution test**

Append this test inside the existing `describe('createManagedVm', ...)` block in `packages/gondolin-adapter/src/vm-adapter.test.ts`:

```ts
	it('executes argv commands without converting them to shell strings', async () => {
		const exec = vi.fn(async (command: string | readonly string[]) => ({
			exitCode: 0,
			stdout: JSON.stringify(command),
			stderr: '',
		}));
		const dependencies = createBaseDependencies({
			createVm: vi.fn(async () => ({
				...createFakeVmInstance(),
				exec,
			})),
		});

		const managedVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/tmp/runner.img',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {},
			},
			dependencies,
		);

		const result = await managedVm.execArgv([
			'/usr/local/bin/gog',
			'--no-input',
			'calendar',
			'events',
			'--today',
			'--json',
		]);

		expect(exec).toHaveBeenCalledWith([
			'/usr/local/bin/gog',
			'--no-input',
			'calendar',
			'events',
			'--today',
			'--json',
		]);
		expect(result).toEqual({
			exitCode: 0,
			stdout:
				'["/usr/local/bin/gog","--no-input","calendar","events","--today","--json"]',
			stderr: '',
		});
	});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/vm-adapter.test.ts -t "argv commands"
```

Expected: FAIL with a TypeScript or runtime error because `ManagedVm` does not expose `execArgv(...)`.

- [ ] **Step 3: Add argv execution types and method**

In `packages/gondolin-adapter/src/vm-adapter.ts`, replace `ManagedVmInstance.exec` with:

```ts
	exec(command: string | readonly [string, ...string[]]): Promise<{
		readonly exitCode: number;
		readonly stdout?: string;
		readonly stderr?: string;
	}>;
```

Add this method to `ManagedVm`:

```ts
	execArgv(command: readonly [string, ...string[]]): Promise<ExecResult>;
```

Add this method to the returned managed VM object:

```ts
			async execArgv(command: readonly [string, ...string[]]): Promise<ExecResult> {
				const executionResult = await vmInstance.exec(command);
				return {
					exitCode: executionResult.exitCode,
					stdout: executionResult.stdout ?? '',
					stderr: executionResult.stderr ?? '',
				};
			},
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/vm-adapter.test.ts -t "argv commands"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gondolin-adapter/src/vm-adapter.ts packages/gondolin-adapter/src/vm-adapter.test.ts
git commit -m "feat: add argv VM execution surface"
```

### Task 2: Add Credential Runner Config Schema

**Files:**
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `packages/agent-vm/src/config/system-config.test.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/credential-runner-types.ts`

- [ ] **Step 1: Create the runner type module**

Create `packages/agent-vm/src/controller/credential-runner/credential-runner-types.ts`:

```ts
export type CredentialRunnerSecretSource =
	| {
			readonly kind: 'host-secret';
			readonly envName: string;
			readonly secretRef: string;
	  }
	| {
			readonly kind: 'google-oauth-access-token';
			readonly envName: string;
			readonly clientIdRef: string;
			readonly clientSecretRef: string;
			readonly refreshTokenRef: string;
			readonly scopes: readonly string[];
	  };

export interface CredentialRunnerCommandConfig {
	readonly binary: string;
	readonly fixedArgs: readonly string[];
	readonly allowedArgvPrefixes: readonly (readonly string[])[];
	readonly deniedFirstArgs: readonly string[];
	readonly injectAccessTokenArg?: {
		readonly envName: string;
		readonly flag: string;
	};
	readonly maxArgvItems: number;
	readonly maxStdoutBytes: number;
	readonly maxStderrBytes: number;
	readonly timeoutMs: number;
}

export interface CredentialRunnerConfig {
	readonly allowedHosts: readonly string[];
	readonly cpus: number;
	readonly imageProfile: string;
	readonly memory: string;
	readonly commands: Readonly<Record<string, CredentialRunnerCommandConfig>>;
	readonly secretSources: readonly CredentialRunnerSecretSource[];
}

export interface CredentialRunnerExecuteRequest {
	readonly runnerId: string;
	readonly commandId: string;
	readonly argv: readonly string[];
	readonly stdin?: { readonly kind: 'none' };
}

export interface CredentialRunnerExecuteResult {
	readonly runnerId: string;
	readonly commandId: string;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly stdoutTruncated: boolean;
	readonly stderrTruncated: boolean;
	readonly redactedCommand: readonly string[];
}
```

- [ ] **Step 2: Add the failing config test**

Append this test to `packages/agent-vm/src/config/system-config.test.ts`:

```ts
	test('loads credential runner config with explicit commands and secret sources', async () => {
		const input = createMinimalSystemConfig();
		input.credentialRunners = {
			google: {
				allowedHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
				commands: {
					gog: {
						allowedArgvPrefixes: [['calendar', 'events'], ['calendar', 'create']],
						binary: '/usr/local/bin/gog',
						deniedFirstArgs: ['auth', 'config', 'tokens'],
						fixedArgs: ['--no-input'],
						injectAccessTokenArg: {
							envName: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
							flag: '--access-token',
						},
						maxArgvItems: 32,
						maxStderrBytes: 65536,
						maxStdoutBytes: 1048576,
						timeoutMs: 120000,
					},
				},
				cpus: 1,
				imageProfile: 'google-credential-runner',
				memory: '1G',
				secretSources: [
					{
						clientIdRef: 'op://agent-vm/google-oauth-client-id/credential',
						clientSecretRef: 'op://agent-vm/google-oauth-client-secret/credential',
						envName: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
						kind: 'google-oauth-access-token',
						refreshTokenRef: 'op://agent-vm/shravan-google-refresh-token/credential',
						scopes: ['https://www.googleapis.com/auth/calendar'],
					},
				],
			},
		};

		const configPath = await writeSystemConfigForTest('agent-vm-credential-runner-', input);
		const config = await loadSystemConfig(configPath);

		expect(config.credentialRunners?.google).toMatchObject({
			allowedHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
			imageProfile: 'google-credential-runner',
			memory: '1G',
		});
		expect(config.credentialRunners?.google.commands.gog.fixedArgs).toEqual(['--no-input']);
	});
```

- [ ] **Step 3: Run the focused config test and verify it fails**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts -t "credential runner config"
```

Expected: FAIL because `credentialRunners` is not part of the system config schema.

- [ ] **Step 4: Add the schema**

In `packages/agent-vm/src/config/system-config.ts`, add Zod schemas near the other top-level config schemas:

```ts
const credentialRunnerSecretSourceSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('host-secret'),
		envName: z.string().min(1),
		secretRef: z.string().min(1),
	}),
	z.object({
		kind: z.literal('google-oauth-access-token'),
		envName: z.string().min(1),
		clientIdRef: z.string().min(1),
		clientSecretRef: z.string().min(1),
		refreshTokenRef: z.string().min(1),
		scopes: z.array(z.string().min(1)).min(1),
	}),
]);

const credentialRunnerCommandSchema = z.object({
	binary: z.string().min(1).refine((value) => value.startsWith('/'), {
		message: 'credential runner command binary must be an absolute path',
	}),
	fixedArgs: z.array(z.string()).default([]),
	allowedArgvPrefixes: z.array(z.array(z.string()).min(1)).min(1),
	deniedFirstArgs: z.array(z.string()).default([]),
	injectAccessTokenArg: z
		.object({
			envName: z.string().min(1),
			flag: z.string().min(1),
		})
		.optional(),
	maxArgvItems: z.number().int().positive().default(32),
	maxStdoutBytes: z.number().int().positive().default(1024 * 1024),
	maxStderrBytes: z.number().int().positive().default(64 * 1024),
	timeoutMs: z.number().int().positive().default(120_000),
});

const credentialRunnerSchema = z.object({
	allowedHosts: z.array(z.string().min(1)).default([]),
	commands: z.record(z.string().min(1), credentialRunnerCommandSchema),
	cpus: z.number().int().positive().default(1),
	imageProfile: z.string().min(1),
	memory: z.string().min(1).default('1G'),
	secretSources: z.array(credentialRunnerSecretSourceSchema).default([]),
});
```

Add this field to the top-level system config schema:

```ts
	credentialRunners: z.record(z.string().min(1), credentialRunnerSchema).default({}),
```

- [ ] **Step 5: Run the focused config test and verify it passes**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts -t "credential runner config"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/config/system-config.ts packages/agent-vm/src/config/system-config.test.ts packages/agent-vm/src/controller/credential-runner/credential-runner-types.ts
git commit -m "feat: add credential runner config"
```

### Task 3: Add Command Policy Validation

**Files:**
- Create: `packages/agent-vm/src/controller/credential-runner/credential-runner-policy.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/credential-runner-policy.test.ts`

- [ ] **Step 1: Write policy tests**

Create `packages/agent-vm/src/controller/credential-runner/credential-runner-policy.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import type { CredentialRunnerCommandConfig } from './credential-runner-types.js';
import { buildCredentialRunnerCommand } from './credential-runner-policy.js';

const gogCommand: CredentialRunnerCommandConfig = {
	allowedArgvPrefixes: [['calendar', 'events'], ['calendar', 'create']],
	binary: '/usr/local/bin/gog',
	deniedFirstArgs: ['auth', 'config', 'tokens'],
	fixedArgs: ['--no-input'],
	injectAccessTokenArg: {
		envName: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
		flag: '--access-token',
	},
	maxArgvItems: 16,
	maxStderrBytes: 4096,
	maxStdoutBytes: 8192,
	timeoutMs: 120000,
};

describe('credential runner policy', () => {
	test('builds a registered command with fixed args and controller-injected token args', () => {
		const result = buildCredentialRunnerCommand({
			argv: ['calendar', 'events', '--today', '--json'],
			command: gogCommand,
			secretsByEnvName: new Map([['GOOGLE_CALENDAR_ACCESS_TOKEN', 'access-token-123']]),
		});

		expect(result.command).toEqual([
			'/usr/local/bin/gog',
			'--no-input',
			'--access-token',
			'access-token-123',
			'calendar',
			'events',
			'--today',
			'--json',
		]);
		expect(result.redactedCommand).toEqual([
			'/usr/local/bin/gog',
			'--no-input',
			'--access-token',
			'<redacted:GOOGLE_CALENDAR_ACCESS_TOKEN>',
			'calendar',
			'events',
			'--today',
			'--json',
		]);
	});

	test('rejects unregistered argv prefixes', () => {
		expect(() =>
			buildCredentialRunnerCommand({
				argv: ['drive', 'ls'],
				command: gogCommand,
				secretsByEnvName: new Map([['GOOGLE_CALENDAR_ACCESS_TOKEN', 'access-token-123']]),
			}),
		).toThrow("credential runner argv prefix 'drive ls' is not allowed");
	});

	test('rejects denied first arguments even if the prefix list changes later', () => {
		expect(() =>
			buildCredentialRunnerCommand({
				argv: ['auth', 'list'],
				command: gogCommand,
				secretsByEnvName: new Map([['GOOGLE_CALENDAR_ACCESS_TOKEN', 'access-token-123']]),
			}),
		).toThrow("credential runner argv first argument 'auth' is denied");
	});

	test('rejects missing injected secrets', () => {
		expect(() =>
			buildCredentialRunnerCommand({
				argv: ['calendar', 'events'],
				command: gogCommand,
				secretsByEnvName: new Map(),
			}),
		).toThrow("credential runner secret env 'GOOGLE_CALENDAR_ACCESS_TOKEN' was not materialized");
	});
});
```

- [ ] **Step 2: Run the policy tests and verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/credential-runner/credential-runner-policy.test.ts
```

Expected: FAIL because `credential-runner-policy.ts` does not exist.

- [ ] **Step 3: Implement policy validation**

Create `packages/agent-vm/src/controller/credential-runner/credential-runner-policy.ts`:

```ts
import type { CredentialRunnerCommandConfig } from './credential-runner-types.js';

export interface BuildCredentialRunnerCommandOptions {
	readonly argv: readonly string[];
	readonly command: CredentialRunnerCommandConfig;
	readonly secretsByEnvName: ReadonlyMap<string, string>;
}

export interface BuiltCredentialRunnerCommand {
	readonly command: readonly [string, ...string[]];
	readonly redactedCommand: readonly [string, ...string[]];
}

function formatPrefix(argv: readonly string[]): string {
	return argv.slice(0, 2).join(' ') || '<empty>';
}

function prefixMatches(argv: readonly string[], prefix: readonly string[]): boolean {
	return prefix.every((expected, index) => argv[index] === expected);
}

function assertAllowedUserArgv(
	command: CredentialRunnerCommandConfig,
	argv: readonly string[],
): void {
	if (argv.length === 0) {
		throw new Error('credential runner argv must not be empty');
	}
	if (argv.length > command.maxArgvItems) {
		throw new Error(
			`credential runner argv has ${String(argv.length)} item(s), max is ${String(command.maxArgvItems)}`,
		);
	}
	const [firstArg = ''] = argv;
	if (command.deniedFirstArgs.includes(firstArg)) {
		throw new Error(`credential runner argv first argument '${firstArg}' is denied`);
	}
	if (!command.allowedArgvPrefixes.some((prefix) => prefixMatches(argv, prefix))) {
		throw new Error(`credential runner argv prefix '${formatPrefix(argv)}' is not allowed`);
	}
}

export function buildCredentialRunnerCommand(
	options: BuildCredentialRunnerCommandOptions,
): BuiltCredentialRunnerCommand {
	assertAllowedUserArgv(options.command, options.argv);

	const effectiveArgs = [...options.command.fixedArgs];
	const redactedArgs = [...options.command.fixedArgs];
	if (options.command.injectAccessTokenArg) {
		const secretValue = options.secretsByEnvName.get(options.command.injectAccessTokenArg.envName);
		if (!secretValue) {
			throw new Error(
				`credential runner secret env '${options.command.injectAccessTokenArg.envName}' was not materialized`,
			);
		}
		effectiveArgs.push(options.command.injectAccessTokenArg.flag, secretValue);
		redactedArgs.push(
			options.command.injectAccessTokenArg.flag,
			`<redacted:${options.command.injectAccessTokenArg.envName}>`,
		);
	}

	return {
		command: [options.command.binary, ...effectiveArgs, ...options.argv],
		redactedCommand: [options.command.binary, ...redactedArgs, ...options.argv],
	};
}
```

- [ ] **Step 4: Run the policy tests and verify they pass**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/credential-runner/credential-runner-policy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/credential-runner/credential-runner-policy.ts packages/agent-vm/src/controller/credential-runner/credential-runner-policy.test.ts
git commit -m "feat: validate credential runner argv"
```

### Task 4: Add Google OAuth Access Token Materialization

**Files:**
- Create: `packages/agent-vm/src/controller/credential-runner/google-oauth-access-token.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/google-oauth-access-token.test.ts`

- [ ] **Step 1: Write OAuth token exchange tests**

Create `packages/agent-vm/src/controller/credential-runner/google-oauth-access-token.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';

import { fetchGoogleOAuthAccessToken } from './google-oauth-access-token.js';

describe('fetchGoogleOAuthAccessToken', () => {
	test('exchanges a refresh token for a short-lived access token', async () => {
		const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
			expect(init.method).toBe('POST');
			expect(init.headers).toEqual({
				'content-type': 'application/x-www-form-urlencoded',
			});
			expect(String(init.body)).toContain('grant_type=refresh_token');
			expect(String(init.body)).toContain('client_id=client-id');
			expect(String(init.body)).toContain('client_secret=client-secret');
			expect(String(init.body)).toContain('refresh_token=refresh-token');
			expect(String(init.body)).toContain(
				'scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar',
			);

			return new Response(
				JSON.stringify({
					access_token: 'access-token',
					expires_in: 3600,
					token_type: 'Bearer',
				}),
				{ status: 200 },
			);
		});

		await expect(
			fetchGoogleOAuthAccessToken({
				clientId: 'client-id',
				clientSecret: 'client-secret',
				fetchImpl,
				refreshToken: 'refresh-token',
				scopes: ['https://www.googleapis.com/auth/calendar'],
			}),
		).resolves.toBe('access-token');
	});

	test('throws a scrubbed error when Google rejects the refresh token', async () => {
		const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));

		await expect(
			fetchGoogleOAuthAccessToken({
				clientId: 'client-id',
				clientSecret: 'client-secret',
				fetchImpl,
				refreshToken: 'refresh-token',
				scopes: ['https://www.googleapis.com/auth/calendar'],
			}),
		).rejects.toThrow('Google OAuth token exchange failed: 400');
	});
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/credential-runner/google-oauth-access-token.test.ts
```

Expected: FAIL because `google-oauth-access-token.ts` does not exist.

- [ ] **Step 3: Implement the token exchange**

Create `packages/agent-vm/src/controller/credential-runner/google-oauth-access-token.ts`:

```ts
export interface FetchGoogleOAuthAccessTokenOptions {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly fetchImpl?: typeof fetch;
	readonly refreshToken: string;
	readonly scopes: readonly string[];
}

interface GoogleOAuthTokenResponse {
	readonly access_token?: unknown;
}

export async function fetchGoogleOAuthAccessToken(
	options: FetchGoogleOAuthAccessTokenOptions,
): Promise<string> {
	const body = new URLSearchParams({
		client_id: options.clientId,
		client_secret: options.clientSecret,
		grant_type: 'refresh_token',
		refresh_token: options.refreshToken,
		scope: options.scopes.join(' '),
	});
	const response = await (options.fetchImpl ?? fetch)('https://oauth2.googleapis.com/token', {
		body,
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
		},
		method: 'POST',
	});
	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(`Google OAuth token exchange failed: ${String(response.status)}`);
	}
	let parsed: GoogleOAuthTokenResponse;
	try {
		parsed = JSON.parse(responseText) as GoogleOAuthTokenResponse;
	} catch (error) {
		throw new Error('Google OAuth token exchange returned invalid JSON', { cause: error });
	}
	if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
		throw new Error('Google OAuth token exchange did not return access_token');
	}
	return parsed.access_token;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/credential-runner/google-oauth-access-token.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/credential-runner/google-oauth-access-token.ts packages/agent-vm/src/controller/credential-runner/google-oauth-access-token.test.ts
git commit -m "feat: materialize google oauth access tokens"
```

### Task 5: Add Ephemeral Runner VM Lifecycle

**Files:**
- Create: `packages/agent-vm/src/controller/credential-runner/credential-runner-vm-lifecycle.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/credential-runner-vm-lifecycle.test.ts`

- [ ] **Step 1: Write lifecycle tests**

Create `packages/agent-vm/src/controller/credential-runner/credential-runner-vm-lifecycle.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';

import { runCredentialCommandInEphemeralVm } from './credential-runner-vm-lifecycle.js';

describe('runCredentialCommandInEphemeralVm', () => {
	test('creates a memory-rootfs VM, runs one argv command, and closes the VM', async () => {
		const close = vi.fn(async () => {});
		const execArgv = vi.fn(async () => ({
			exitCode: 0,
			stdout: '{"items":[]}',
			stderr: '',
		}));
		const createManagedVm = vi.fn(async () => ({
			close,
			execArgv,
			id: 'runner-vm-1',
		}));

		const result = await runCredentialCommandInEphemeralVm({
			allowedHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
			command: ['/usr/local/bin/gog', '--no-input', 'calendar', 'events'],
			cpus: 1,
			createManagedVm,
			imagePath: '/images/google-runner.img',
			maxStderrBytes: 1024,
			maxStdoutBytes: 1024,
			memory: '1G',
			timeoutMs: 120000,
		});

		expect(createManagedVm).toHaveBeenCalledWith({
			allowedHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
			cpus: 1,
			imagePath: '/images/google-runner.img',
			memory: '1G',
			rootfsMode: 'memory',
			secrets: {},
			sessionLabel: 'credential-runner',
			vfsMounts: {},
		});
		expect(execArgv).toHaveBeenCalledWith([
			'/usr/local/bin/gog',
			'--no-input',
			'calendar',
			'events',
		]);
		expect(close).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			exitCode: 0,
			stderr: '',
			stderrTruncated: false,
			stdout: '{"items":[]}',
			stdoutTruncated: false,
		});
	});

	test('closes the VM when command execution fails', async () => {
		const close = vi.fn(async () => {});
		const execArgv = vi.fn(async () => {
			throw new Error('runner crashed');
		});
		const createManagedVm = vi.fn(async () => ({
			close,
			execArgv,
			id: 'runner-vm-1',
		}));

		await expect(
			runCredentialCommandInEphemeralVm({
				allowedHosts: [],
				command: ['/usr/local/bin/gog', 'calendar', 'events'],
				cpus: 1,
				createManagedVm,
				imagePath: '/images/google-runner.img',
				maxStderrBytes: 1024,
				maxStdoutBytes: 1024,
				memory: '1G',
				timeoutMs: 120000,
			}),
		).rejects.toThrow('runner crashed');
		expect(close).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run lifecycle tests and verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/credential-runner/credential-runner-vm-lifecycle.test.ts
```

Expected: FAIL because `credential-runner-vm-lifecycle.ts` does not exist.

- [ ] **Step 3: Implement lifecycle**

Create `packages/agent-vm/src/controller/credential-runner/credential-runner-vm-lifecycle.ts`:

```ts
import type { createManagedVm as createManagedVmFromCore } from '@agent-vm/gondolin-adapter';

interface MinimalManagedVm {
	readonly id: string;
	execArgv(command: readonly [string, ...string[]]): Promise<{
		readonly exitCode: number;
		readonly stdout: string;
		readonly stderr: string;
	}>;
	close(): Promise<void>;
}

export interface RunCredentialCommandInEphemeralVmOptions {
	readonly allowedHosts: readonly string[];
	readonly command: readonly [string, ...string[]];
	readonly cpus: number;
	readonly createManagedVm: typeof createManagedVmFromCore | ((
		options: {
			readonly allowedHosts: readonly string[];
			readonly cpus: number;
			readonly imagePath: string;
			readonly memory: string;
			readonly rootfsMode: 'memory';
			readonly secrets: Record<string, never>;
			readonly sessionLabel: string;
			readonly vfsMounts: Record<string, never>;
		},
	) => Promise<MinimalManagedVm>);
	readonly imagePath: string;
	readonly maxStderrBytes: number;
	readonly maxStdoutBytes: number;
	readonly memory: string;
	readonly timeoutMs: number;
}

export interface EphemeralCredentialRunnerResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly stdoutTruncated: boolean;
	readonly stderrTruncated: boolean;
}

function truncateOutput(value: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
	const buffer = Buffer.from(value, 'utf8');
	if (buffer.byteLength <= maxBytes) {
		return { text: value, truncated: false };
	}
	return { text: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

export async function runCredentialCommandInEphemeralVm(
	options: RunCredentialCommandInEphemeralVmOptions,
): Promise<EphemeralCredentialRunnerResult> {
	const vm = await options.createManagedVm({
		allowedHosts: options.allowedHosts,
		cpus: options.cpus,
		imagePath: options.imagePath,
		memory: options.memory,
		rootfsMode: 'memory',
		secrets: {},
		sessionLabel: 'credential-runner',
		vfsMounts: {},
	});
	try {
		const result = await vm.execArgv(options.command);
		const stdout = truncateOutput(result.stdout, options.maxStdoutBytes);
		const stderr = truncateOutput(result.stderr, options.maxStderrBytes);
		return {
			exitCode: result.exitCode,
			stderr: stderr.text,
			stderrTruncated: stderr.truncated,
			stdout: stdout.text,
			stdoutTruncated: stdout.truncated,
		};
	} finally {
		await vm.close();
	}
}
```

- [ ] **Step 4: Run lifecycle tests and verify they pass**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/credential-runner/credential-runner-vm-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/credential-runner/credential-runner-vm-lifecycle.ts packages/agent-vm/src/controller/credential-runner/credential-runner-vm-lifecycle.test.ts
git commit -m "feat: run credential commands in ephemeral VMs"
```

### Task 6: Add Capability Store And Controller Service

**Files:**
- Create: `packages/agent-vm/src/controller/credential-runner/credential-runner-capability-store.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/credential-runner-service.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/credential-runner-service.test.ts`

- [ ] **Step 1: Write service tests**

Create `packages/agent-vm/src/controller/credential-runner/credential-runner-service.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';

import { CredentialRunnerCapabilityStore } from './credential-runner-capability-store.js';
import { executeCredentialRunnerCommand } from './credential-runner-service.js';
import type { CredentialRunnerConfig } from './credential-runner-types.js';

const googleRunner: CredentialRunnerConfig = {
	allowedHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
	commands: {
		gog: {
			allowedArgvPrefixes: [['calendar', 'events']],
			binary: '/usr/local/bin/gog',
			deniedFirstArgs: ['auth', 'config', 'tokens'],
			fixedArgs: ['--no-input'],
			injectAccessTokenArg: {
				envName: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
				flag: '--access-token',
			},
			maxArgvItems: 16,
			maxStderrBytes: 4096,
			maxStdoutBytes: 8192,
			timeoutMs: 120000,
		},
	},
	cpus: 1,
	imageProfile: 'google-credential-runner',
	memory: '1G',
	secretSources: [
		{
			clientIdRef: 'op://agent-vm/google-client-id/credential',
			clientSecretRef: 'op://agent-vm/google-client-secret/credential',
			envName: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
			kind: 'google-oauth-access-token',
			refreshTokenRef: 'op://agent-vm/google-refresh-token/credential',
			scopes: ['https://www.googleapis.com/auth/calendar'],
		},
	],
};

describe('executeCredentialRunnerCommand', () => {
	test('materializes secrets, validates policy, and runs a single ephemeral command', async () => {
		const runInVm = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stderrTruncated: false,
			stdout: '{"items":[]}',
			stdoutTruncated: false,
		}));
		const resolveSecret = vi.fn(async (secretRef: string) => {
			const values = new Map([
				['op://agent-vm/google-client-id/credential', 'client-id'],
				['op://agent-vm/google-client-secret/credential', 'client-secret'],
				['op://agent-vm/google-refresh-token/credential', 'refresh-token'],
			]);
			const value = values.get(secretRef);
			if (!value) throw new Error(`unexpected secret ref ${secretRef}`);
			return value;
		});
		const fetchGoogleAccessToken = vi.fn(async () => 'access-token');

		const result = await executeCredentialRunnerCommand({
			fetchGoogleAccessToken,
			imagePathForProfile: vi.fn(() => '/images/google-runner.img'),
			request: {
				argv: ['calendar', 'events', '--today', '--json'],
				commandId: 'gog',
				runnerId: 'google',
			},
			resolveSecret,
			runInVm,
			runners: { google: googleRunner },
		});

		expect(fetchGoogleAccessToken).toHaveBeenCalledWith({
			clientId: 'client-id',
			clientSecret: 'client-secret',
			refreshToken: 'refresh-token',
			scopes: ['https://www.googleapis.com/auth/calendar'],
		});
		expect(runInVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
				command: [
					'/usr/local/bin/gog',
					'--no-input',
					'--access-token',
					'access-token',
					'calendar',
					'events',
					'--today',
					'--json',
				],
				imagePath: '/images/google-runner.img',
			}),
		);
		expect(result.redactedCommand).toEqual([
			'/usr/local/bin/gog',
			'--no-input',
			'--access-token',
			'<redacted:GOOGLE_CALENDAR_ACCESS_TOKEN>',
			'calendar',
			'events',
			'--today',
			'--json',
		]);
	});

	test('rejects unknown runners', async () => {
		await expect(
			executeCredentialRunnerCommand({
				fetchGoogleAccessToken: vi.fn(),
				imagePathForProfile: vi.fn(),
				request: {
					argv: ['calendar', 'events'],
					commandId: 'gog',
					runnerId: 'missing',
				},
				resolveSecret: vi.fn(),
				runInVm: vi.fn(),
				runners: { google: googleRunner },
			}),
		).rejects.toThrow("credential runner 'missing' is not configured");
	});
});
```

- [ ] **Step 2: Run service tests and verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/credential-runner/credential-runner-service.test.ts
```

Expected: FAIL because service files do not exist.

- [ ] **Step 3: Implement capability store**

Create `packages/agent-vm/src/controller/credential-runner/credential-runner-capability-store.ts`:

```ts
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CREDENTIAL_RUNNER_CAPABILITY_HEADER = 'x-agent-vm-credential-runner-token';
export const CREDENTIAL_RUNNER_CAPABILITY_ENV_VAR = 'AGENT_VM_CREDENTIAL_RUNNER_TOKEN';

function generateDefaultToken(): string {
	return randomBytes(32).toString('base64url');
}

function constantTimeStringEquals(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class CredentialRunnerCapabilityStore {
	private readonly generateToken: () => string;
	private readonly tokensByZoneAndRunner = new Map<string, string>();

	public constructor(props: { readonly generateToken?: () => string } = {}) {
		this.generateToken = props.generateToken ?? generateDefaultToken;
	}

	private key(zoneId: string, runnerId: string): string {
		return `${zoneId}\u0000${runnerId}`;
	}

	public issueToken(zoneId: string, runnerId: string): string {
		const key = this.key(zoneId, runnerId);
		const existingToken = this.tokensByZoneAndRunner.get(key);
		if (existingToken) return existingToken;
		const token = this.generateToken();
		this.tokensByZoneAndRunner.set(key, token);
		return token;
	}

	public verifyToken(zoneId: string, runnerId: string, token: string | undefined): boolean {
		const expectedToken = this.tokensByZoneAndRunner.get(this.key(zoneId, runnerId));
		return (
			expectedToken !== undefined &&
			token !== undefined &&
			constantTimeStringEquals(token, expectedToken)
		);
	}
}
```

- [ ] **Step 4: Implement controller service**

Create `packages/agent-vm/src/controller/credential-runner/credential-runner-service.ts`:

```ts
import { buildCredentialRunnerCommand } from './credential-runner-policy.js';
import type {
	CredentialRunnerConfig,
	CredentialRunnerExecuteRequest,
	CredentialRunnerExecuteResult,
} from './credential-runner-types.js';

export interface ExecuteCredentialRunnerCommandOptions {
	readonly fetchGoogleAccessToken: (options: {
		readonly clientId: string;
		readonly clientSecret: string;
		readonly refreshToken: string;
		readonly scopes: readonly string[];
	}) => Promise<string>;
	readonly imagePathForProfile: (imageProfile: string) => string;
	readonly request: CredentialRunnerExecuteRequest;
	readonly resolveSecret: (secretRef: string) => Promise<string>;
	readonly runInVm: (options: {
		readonly allowedHosts: readonly string[];
		readonly command: readonly [string, ...string[]];
		readonly cpus: number;
		readonly imagePath: string;
		readonly maxStderrBytes: number;
		readonly maxStdoutBytes: number;
		readonly memory: string;
		readonly timeoutMs: number;
	}) => Promise<{
		readonly exitCode: number;
		readonly stdout: string;
		readonly stderr: string;
		readonly stdoutTruncated: boolean;
		readonly stderrTruncated: boolean;
	}>;
	readonly runners: Readonly<Record<string, CredentialRunnerConfig>>;
}

async function materializeSecrets(
	options: Pick<ExecuteCredentialRunnerCommandOptions, 'fetchGoogleAccessToken' | 'resolveSecret'> & {
		readonly runner: CredentialRunnerConfig;
	},
): Promise<ReadonlyMap<string, string>> {
	const secretsByEnvName = new Map<string, string>();
	for (const source of options.runner.secretSources) {
		if (source.kind === 'host-secret') {
			secretsByEnvName.set(source.envName, await options.resolveSecret(source.secretRef));
			continue;
		}
		const [clientId, clientSecret, refreshToken] = await Promise.all([
			options.resolveSecret(source.clientIdRef),
			options.resolveSecret(source.clientSecretRef),
			options.resolveSecret(source.refreshTokenRef),
		]);
		secretsByEnvName.set(
			source.envName,
			await options.fetchGoogleAccessToken({
				clientId,
				clientSecret,
				refreshToken,
				scopes: source.scopes,
			}),
		);
	}
	return secretsByEnvName;
}

export async function executeCredentialRunnerCommand(
	options: ExecuteCredentialRunnerCommandOptions,
): Promise<CredentialRunnerExecuteResult> {
	const runner = options.runners[options.request.runnerId];
	if (!runner) {
		throw new Error(`credential runner '${options.request.runnerId}' is not configured`);
	}
	const commandConfig = runner.commands[options.request.commandId];
	if (!commandConfig) {
		throw new Error(
			`credential runner command '${options.request.commandId}' is not configured for runner '${options.request.runnerId}'`,
		);
	}
	const secretsByEnvName = await materializeSecrets({
		fetchGoogleAccessToken: options.fetchGoogleAccessToken,
		resolveSecret: options.resolveSecret,
		runner,
	});
	const builtCommand = buildCredentialRunnerCommand({
		argv: options.request.argv,
		command: commandConfig,
		secretsByEnvName,
	});
	const result = await options.runInVm({
		allowedHosts: runner.allowedHosts,
		command: builtCommand.command,
		cpus: runner.cpus,
		imagePath: options.imagePathForProfile(runner.imageProfile),
		maxStderrBytes: commandConfig.maxStderrBytes,
		maxStdoutBytes: commandConfig.maxStdoutBytes,
		memory: runner.memory,
		timeoutMs: commandConfig.timeoutMs,
	});
	return {
		commandId: options.request.commandId,
		exitCode: result.exitCode,
		redactedCommand: builtCommand.redactedCommand,
		runnerId: options.request.runnerId,
		stderr: result.stderr,
		stderrTruncated: result.stderrTruncated,
		stdout: result.stdout,
		stdoutTruncated: result.stdoutTruncated,
	};
}
```

- [ ] **Step 5: Run service tests and verify they pass**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/credential-runner/credential-runner-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/credential-runner
git commit -m "feat: orchestrate credential runner commands"
```

### Task 7: Add Controller Route And Runtime Wiring

**Files:**
- Create: `packages/agent-vm/src/controller/http/controller-credential-runner-routes.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts`

- [ ] **Step 1: Add route tests**

Append this test to `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`:

```ts
	it('serves credential runner execution through a scoped controller route', async () => {
		const executeCredentialRunner = vi.fn(async () => ({
			commandId: 'gog',
			exitCode: 0,
			redactedCommand: ['/usr/local/bin/gog', '--no-input', 'calendar', 'events'],
			runnerId: 'google',
			stderr: '',
			stderrTruncated: false,
			stdout: '{"items":[]}',
			stdoutTruncated: false,
		}));
		const app = createControllerService({
			leaseManager: createLeaseManagerStub(),
			operations: {
				...createBaseOperations(),
				executeCredentialRunner,
				verifyCredentialRunnerToken: vi.fn(
					(zoneId, runnerId, token) =>
						zoneId === 'sunfam' && runnerId === 'google' && token === 'runner-token',
				),
			},
			secretResolver: createSecretResolverStub(),
		});

		const response = await app.request('/zones/sunfam/credential-runners/google/execute', {
			body: JSON.stringify({
				argv: ['calendar', 'events', '--today', '--json'],
				commandId: 'gog',
			}),
			headers: {
				'content-type': 'application/json',
				'x-agent-vm-credential-runner-token': 'runner-token',
			},
			method: 'POST',
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			commandId: 'gog',
			exitCode: 0,
			runnerId: 'google',
			stdout: '{"items":[]}',
		});
		expect(executeCredentialRunner).toHaveBeenCalledWith('sunfam', {
			argv: ['calendar', 'events', '--today', '--json'],
			commandId: 'gog',
			runnerId: 'google',
		});
	});
```

- [ ] **Step 2: Run route tests and verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts -t "credential runner execution"
```

Expected: FAIL because the route is not registered.

- [ ] **Step 3: Add route support types**

In `packages/agent-vm/src/controller/http/controller-http-route-support.ts`, add imports and operation fields:

```ts
import type {
	CredentialRunnerExecuteRequest,
	CredentialRunnerExecuteResult,
} from '../credential-runner/credential-runner-types.js';
```

Add to `ControllerRouteOperations`:

```ts
	readonly executeCredentialRunner?: (
		zoneId: string,
		request: CredentialRunnerExecuteRequest,
	) => Promise<CredentialRunnerExecuteResult>;
	readonly verifyCredentialRunnerToken?: (
		zoneId: string,
		runnerId: string,
		token: string | undefined,
	) => boolean;
```

- [ ] **Step 4: Create credential runner routes**

Create `packages/agent-vm/src/controller/http/controller-credential-runner-routes.ts`:

```ts
import type { Hono } from 'hono';
import { z } from 'zod';

import { CREDENTIAL_RUNNER_CAPABILITY_HEADER } from '../credential-runner/credential-runner-capability-store.js';
import type { ControllerRouteOperations } from './controller-http-route-support.js';

const credentialRunnerExecuteRequestSchema = z.object({
	argv: z.array(z.string()),
	commandId: z.string().min(1),
});

export function registerCredentialRunnerRoutes(
	app: Hono,
	operations: ControllerRouteOperations,
): void {
	app.post('/zones/:zoneId/credential-runners/:runnerId/execute', async (context) => {
		if (!operations.executeCredentialRunner) {
			return context.json({ error: 'credential-runner-unavailable' }, 405);
		}
		if (!operations.verifyCredentialRunnerToken) {
			return context.json({ error: 'credential-runner-auth-unavailable' }, 405);
		}
		const zoneId = context.req.param('zoneId');
		const runnerId = context.req.param('runnerId');
		if (
			!operations.verifyCredentialRunnerToken(
				zoneId,
				runnerId,
				context.req.header(CREDENTIAL_RUNNER_CAPABILITY_HEADER),
			)
		) {
			return context.json({ error: 'credential-runner-forbidden' }, 403);
		}
		const body = await context.req.json().catch(() => undefined);
		const parsed = credentialRunnerExecuteRequestSchema.safeParse(body);
		if (!parsed.success) {
			return context.json({ error: 'invalid-credential-runner-request' }, 400);
		}
		try {
			return context.json(
				await operations.executeCredentialRunner(zoneId, {
					argv: parsed.data.argv,
					commandId: parsed.data.commandId,
					runnerId,
					stdin: { kind: 'none' },
				}),
			);
		} catch (error) {
			return context.json(
				{
					error: 'credential-runner-execute-failed',
					message: error instanceof Error ? error.message : String(error),
				},
				500,
			);
		}
	});
}
```

- [ ] **Step 5: Register the routes**

In `packages/agent-vm/src/controller/http/controller-http-routes.ts`, import and call the route registrar:

```ts
import { registerCredentialRunnerRoutes } from './controller-credential-runner-routes.js';
```

Add this next to the other route registration calls:

```ts
	registerCredentialRunnerRoutes(app, operations);
```

- [ ] **Step 6: Wire runtime operations**

In `packages/agent-vm/src/controller/controller-runtime.ts`, create a `CredentialRunnerCapabilityStore` next to `ZoneGitCapabilityStore`, and add operations:

```ts
executeCredentialRunner: async (zoneId, request) =>
	await executeCredentialRunnerCommand({
		fetchGoogleAccessToken: async (tokenOptions) => await fetchGoogleOAuthAccessToken(tokenOptions),
		imagePathForProfile: (imageProfile) => resolveManagedImagePath(options.systemConfig, imageProfile),
		request,
		resolveSecret: async (secretRef) => await secretResolver.resolveSecretRef(secretRef),
		runInVm: async (runnerOptions) =>
			await runCredentialCommandInEphemeralVm({
				...runnerOptions,
				createManagedVm: createManagedVmFromCore,
			}),
		runners: options.systemConfig.credentialRunners,
	}),
verifyCredentialRunnerToken: (zoneId, runnerId, token) =>
	credentialRunnerCapabilityStore.verifyToken(zoneId, runnerId, token),
```

Use the project's existing image-path and secret-resolver helpers rather than inventing new config lookup behavior. If the exact helper names differ at implementation time, update this block to call the existing helper and keep the same operation shape.

- [ ] **Step 7: Run route tests and verify they pass**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts -t "credential runner execution"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-vm/src/controller/http packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime-types.ts
git commit -m "feat: add credential runner controller route"
```

### Task 8: Add The OpenClaw Gateway Tool

**Files:**
- Create: `packages/openclaw-agent-vm-plugin/src/credential-runner-tool.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/openclaw.plugin.json`

- [ ] **Step 1: Add plugin registration test**

Append this test to `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts`:

```ts
	it('registers credential_runner_execute and proxies to the controller with a scoped token', async () => {
		const fetchImpl = vi.fn(async () => new Response('{"exitCode":0,"stdout":"{}","stderr":""}', { status: 200 }));
		const registeredTools: Record<string, { execute: (toolCallId: string, input: unknown) => Promise<unknown> }> =
			{};

		plugin.register({
			pluginConfig: {
				controllerUrl: 'http://controller.vm.host:18800',
				credentialRunnerToken: 'runner-token',
				fetchImpl,
				zoneId: 'sunfam',
			},
			registerTool: (definition) => {
				registeredTools[definition.name] = definition;
			},
			registrationMode: 'tools',
		});

		await registeredTools.credential_runner_execute.execute('tool-call-1', {
			argv: ['calendar', 'events', '--today', '--json'],
			commandId: 'gog',
			runnerId: 'google',
		});

		expect(fetchImpl).toHaveBeenCalledWith(
			'http://controller.vm.host:18800/zones/sunfam/credential-runners/google/execute',
			expect.objectContaining({
				body: JSON.stringify({
					argv: ['calendar', 'events', '--today', '--json'],
					commandId: 'gog',
				}),
				headers: expect.objectContaining({
					'content-type': 'application/json',
					'x-agent-vm-credential-runner-token': 'runner-token',
				}),
				method: 'POST',
			}),
		);
	});
```

- [ ] **Step 2: Run plugin test and verify it fails**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts -t "credential_runner_execute"
```

Expected: FAIL because the tool is not registered.

- [ ] **Step 3: Create the gateway tool module**

Create `packages/openclaw-agent-vm-plugin/src/credential-runner-tool.ts`:

```ts
import { CREDENTIAL_RUNNER_CAPABILITY_HEADER } from '../../agent-vm/src/controller/credential-runner/credential-runner-capability-store.js';
import type { OpenClawToolRegistrationApi } from './openclaw-sandbox-sdk-contract.js';

type RequiredOpenClawToolRegistrationApi = OpenClawToolRegistrationApi & {
	readonly registerTool: NonNullable<OpenClawToolRegistrationApi['registerTool']>;
};

export interface RegisterCredentialRunnerToolOptions {
	readonly api: RequiredOpenClawToolRegistrationApi;
	readonly controllerUrl: string;
	readonly credentialRunnerToken?: string;
	readonly fetchImpl?: typeof fetch;
	readonly zoneId: string;
}

function readInput(input: unknown): {
	readonly argv: readonly string[];
	readonly commandId: string;
	readonly runnerId: string;
} {
	if (typeof input !== 'object' || input === null) {
		throw new Error('credential_runner_execute requires an object input.');
	}
	const record = input as Record<string, unknown>;
	if (typeof record.runnerId !== 'string' || record.runnerId.length === 0) {
		throw new Error('credential_runner_execute requires runnerId.');
	}
	if (typeof record.commandId !== 'string' || record.commandId.length === 0) {
		throw new Error('credential_runner_execute requires commandId.');
	}
	if (!Array.isArray(record.argv) || !record.argv.every((item) => typeof item === 'string')) {
		throw new Error('credential_runner_execute requires argv as string array.');
	}
	return {
		argv: record.argv,
		commandId: record.commandId,
		runnerId: record.runnerId,
	};
}

export function registerCredentialRunnerTool(options: RegisterCredentialRunnerToolOptions): void {
	options.api.registerTool(
		{
			name: 'credential_runner_execute',
			description:
				'Execute a registered credentialed CLI command through an ephemeral agent-vm Credential Runner VM. Does not run arbitrary shell.',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					argv: { type: 'array', items: { type: 'string' } },
					commandId: { type: 'string' },
					runnerId: { type: 'string' },
				},
				required: ['runnerId', 'commandId', 'argv'],
			},
			execute: async (_toolCallId: string, input: unknown) => {
				const parsedInput = readInput(input);
				const response = await (options.fetchImpl ?? fetch)(
					`${options.controllerUrl.replace(/\/$/u, '')}/zones/${encodeURIComponent(options.zoneId)}/credential-runners/${encodeURIComponent(parsedInput.runnerId)}/execute`,
					{
						body: JSON.stringify({
							argv: parsedInput.argv,
							commandId: parsedInput.commandId,
						}),
						headers: {
							'content-type': 'application/json',
							...(options.credentialRunnerToken
								? { [CREDENTIAL_RUNNER_CAPABILITY_HEADER]: options.credentialRunnerToken }
								: {}),
						},
						method: 'POST',
					},
				);
				const responseText = await response.text();
				if (!response.ok) {
					throw new Error(
						`credential_runner_execute failed: ${String(response.status)} ${responseText.slice(0, 500)}`,
					);
				}
				return {
					content: responseText,
					details: JSON.parse(responseText) as unknown,
				};
			},
		},
		{ name: 'credential_runner_execute', optional: true },
	);
}
```

- [ ] **Step 4: Parse plugin config**

In `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`, add optional fields:

```ts
	readonly credentialRunnerToken?: string;
	readonly credentialRunnerTokenEnv?: string;
```

In the resolver object, add:

```ts
		...(typeof config.credentialRunnerToken === 'string'
			? { credentialRunnerToken: config.credentialRunnerToken }
			: {}),
		...(typeof config.credentialRunnerTokenEnv === 'string'
			? { credentialRunnerTokenEnv: config.credentialRunnerTokenEnv }
			: {}),
```

- [ ] **Step 5: Register the tool**

In `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`, import:

```ts
import { registerCredentialRunnerTool } from './credential-runner-tool.js';
```

After `registerZoneGitTool(...)`, add:

```ts
			const credentialRunnerToken =
				pluginConfig.credentialRunnerToken ??
				(pluginConfig.credentialRunnerTokenEnv
					? process.env[pluginConfig.credentialRunnerTokenEnv]
					: undefined);
			registerCredentialRunnerTool({
				api: { registerTool },
				controllerUrl: pluginConfig.controllerUrl,
				...(credentialRunnerToken ? { credentialRunnerToken } : {}),
				zoneId: pluginConfig.zoneId,
			});
```

- [ ] **Step 6: Run plugin test and verify it passes**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts -t "credential_runner_execute"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/openclaw-agent-vm-plugin
git commit -m "feat: register credential runner gateway tool"
```

### Task 9: Add Documentation And Narrow Old Plan References

**Files:**
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/subsystems/secrets-and-credentials.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/superpowers/plans/2026-05-10-gondolin-secret-source.md`

- [ ] **Step 1: Document the config**

Add this section to `docs/reference/configuration/system-json.md`:

````md
## credentialRunners

`credentialRunners` defines registered auth-heavy CLI runners that execute in
fresh Credential Runner VMs. These runners are for tools that do not fit
Gondolin HTTP-mediated header secrets, such as Google OAuth CLIs and SigV4
signing tools.

Credential Runner VMs are always ephemeral:

- one VM per `credential_runner_execute` call
- `rootfsMode: "memory"`
- no `/work` mount by default
- no SSH exposure
- no persistent keyring state in the VM
- fixed registered binary paths only
- argv execution only; no shell strings

Example:

```jsonc
{
  "credentialRunners": {
    "google": {
      "imageProfile": "google-credential-runner",
      "memory": "1G",
      "cpus": 1,
      "allowedHosts": [
        "oauth2.googleapis.com",
        "www.googleapis.com",
        "calendar-json.googleapis.com"
      ],
      "secretSources": [
        {
          "kind": "google-oauth-access-token",
          "envName": "GOOGLE_CALENDAR_ACCESS_TOKEN",
          "clientIdRef": "op://agent-vm/google-oauth-client-id/credential",
          "clientSecretRef": "op://agent-vm/google-oauth-client-secret/credential",
          "refreshTokenRef": "op://agent-vm/shravan-google-refresh-token/credential",
          "scopes": ["https://www.googleapis.com/auth/calendar"]
        }
      ],
      "commands": {
        "gog": {
          "binary": "/usr/local/bin/gog",
          "fixedArgs": ["--no-input"],
          "injectAccessTokenArg": {
            "envName": "GOOGLE_CALENDAR_ACCESS_TOKEN",
            "flag": "--access-token"
          },
          "allowedArgvPrefixes": [
            ["calendar", "events"],
            ["calendar", "create"]
          ],
          "deniedFirstArgs": ["auth", "config", "tokens"],
          "maxArgvItems": 32,
          "maxStdoutBytes": 1048576,
          "maxStderrBytes": 65536,
          "timeoutMs": 120000
        }
      }
    }
  }
}
```
````

- [ ] **Step 2: Document the boundary in secrets docs**

Add this section to `docs/subsystems/secrets-and-credentials.md`:

```md
## HTTP-mediated secrets vs Credential Runner VMs

Use Gondolin HTTP-mediated secrets when a tool can send credentials in HTTP
headers. The Tool VM sees only placeholders, and Gondolin substitutes real
secret values at the network boundary.

Use Credential Runner VMs when a CLI needs local OAuth state, keyrings, request
signing, or provider-specific credential helpers. The agent does not receive
those credentials. OpenClaw calls a typed gateway tool, the controller starts a
fresh runner VM, the runner executes one registered argv command, and the VM is
destroyed.

Do not use Credential Runner VMs as a credentialed shell. Registered commands
must name absolute binary paths and argv policies.
```

- [ ] **Step 3: Add gateway architecture flow**

Add this flow to `docs/architecture/openclaw-gateway.md`:

````md
### Credential Runner VM flow

```text
agent
  |
  | calls OpenClaw tool: credential_runner_execute
  v
OpenClaw gateway plugin
  |
  | POST /zones/:zoneId/credential-runners/:runnerId/execute
  | x-agent-vm-credential-runner-token: <scoped token>
  v
agent-vm controller
  |
  | validate token, resolve host secrets, build argv
  v
ephemeral Credential Runner VM
  |
  | execArgv([registeredBinary, ...fixedArgs, ...secretArgs, ...userArgv])
  v
bounded stdout/stderr/exit code
```
````

- [ ] **Step 4: Narrow the old secret-source plan**

Add this note immediately after the header block in `docs/superpowers/plans/2026-05-10-gondolin-secret-source.md`:

```md
> **2026-05-11 scope correction:** this plan remains the right home for
> Tool VM egress allowlists and HTTP-mediated header-token secrets. Auth-heavy
> CLI execution for Google OAuth/keyrings, SigV4, `gog`, `gcloud`, `aws`, and
> similar tools moved to
> `docs/superpowers/plans/2026-05-11-ephemeral-credential-runner-vm.md`.
> Do not implement the broad gateway-side OAuth/keyring refresh route from this
> plan without re-checking the Credential Runner VM split.
```

- [ ] **Step 5: Commit**

```bash
git add docs/reference/configuration/system-json.md docs/subsystems/secrets-and-credentials.md docs/architecture/openclaw-gateway.md docs/superpowers/plans/2026-05-10-gondolin-secret-source.md
git commit -m "docs: document credential runner boundary"
```

### Task 10: Full Verification

**Files:**
- No file edits.

- [ ] **Step 1: Run package tests for touched units**

Run:

```bash
pnpm vitest run \
  packages/gondolin-adapter/src/vm-adapter.test.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/controller/credential-runner/credential-runner-policy.test.ts \
  packages/agent-vm/src/controller/credential-runner/google-oauth-access-token.test.ts \
  packages/agent-vm/src/controller/credential-runner/credential-runner-vm-lifecycle.test.ts \
  packages/agent-vm/src/controller/credential-runner/credential-runner-service.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts
```

Expected: PASS for all listed tests.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 5: Inspect for accidental shell runner use**

Run:

```bash
rg -n "credential.*shell|buildShellScriptWithArgs|/bin/sh|sh -c" packages/agent-vm/src/controller/credential-runner packages/openclaw-agent-vm-plugin/src/credential-runner-tool.ts
```

Expected: no matches for shell execution helpers inside the credential runner implementation.

- [ ] **Step 6: Commit final verification fixes if any files changed**

If verification required fixes, commit them:

```bash
git add <changed-files>
git commit -m "fix: stabilize credential runner verification"
```

If no files changed, do not create an empty commit.

## Rollback

- Disable `credential_runner_execute` in OpenClaw tool allowlists.
- Remove or leave unused `credentialRunners` config entries.
- Continue using `gondolin-secret-source` for simple header-token integrations.
- Do not fall back to running `gog`, `aws`, `gcloud`, or `az` inside the normal Tool VM with raw secrets.

## Self-Review Checklist

- Spec coverage: the plan builds an always-ephemeral runner, keeps MCP portal separate, references and narrows the old secret-source plan, and preserves the zone-git control-plane pattern.
- Placeholder scan: this plan intentionally avoids open placeholders and gives concrete file paths, request shapes, config examples, and test commands.
- Type consistency: `CredentialRunnerExecuteRequest`, `CredentialRunnerExecuteResult`, `CredentialRunnerConfig`, and `CredentialRunnerCommandConfig` names are used consistently across tasks.
