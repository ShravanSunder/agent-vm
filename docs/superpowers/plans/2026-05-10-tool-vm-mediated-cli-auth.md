# Tool VM Mediated CLI Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let OpenClaw Tool VMs use the same Gondolin HTTP-mediated service tokens and egress allowlist as their parent zone, so CLIs like `gh`, `linear`, and `readwise` work without raw secrets entering the VM.

**Architecture:** Keep gateway and Tool VM auth on the same zone-scoped policy: resolve zone secrets on the host, split them by injection mode, pass only `http-mediation` secrets into Gondolin, and pass `zone.allowedHosts` into Tool VM creation. Do not expose `env` secrets such as Discord bot tokens to Tool VMs. Add service-specific runtime auth recipes so agents know how to use placeholder env vars with `gh`, `linear`, and `readwise`.

**Tech Stack:** TypeScript, Vitest, pnpm, Gondolin `createHttpHooks`, agent-vm controller runtime, OpenClaw Tool VM leases.

---

## Problem Model

Current gateway VMs receive:

- `zones[].allowedHosts`
- `zones[].secrets` split into raw env secrets and mediated HTTP secrets
- Gondolin placeholder env vars for mediated secrets, such as `$READWISE_ACCESS_TOKEN`

Current Tool VMs are created in `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts` with:

```ts
allowedHosts: [],
secrets: {},
```

That means CLIs running inside OpenClaw sandboxes cannot use mediated tokens, even when the zone config declares the right secrets and hosts.

The fix is not CLI-specific. The generic fix is: Tool VM creation must receive the zone's HTTP-mediated secrets and allowed hosts.

## File Structure

- Modify `packages/gateway-interface/src/split-resolved-gateway-secrets.ts`
  - Add a reusable smaller splitter for any zone-like secret config.
  - Keep `splitResolvedGatewaySecrets()` as a compatibility wrapper.

- Create `packages/gateway-interface/src/split-resolved-gateway-secrets.test.ts`
  - Prove `env` secrets stay out of `mediatedSecrets`.
  - Prove `http-mediation` secrets become Gondolin `SecretSpec`.
  - Prove unresolved extras are ignored with the existing warning behavior.

- Modify `packages/gateway-interface/src/index.ts`
  - Export the reusable splitter and result type.

- Modify `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
  - Add `secretResolver` to `createToolVm()` options.
  - Resolve zone secrets host-side.
  - Split to mediated secrets.
  - Pass `allowedHosts: zone.allowedHosts`.
  - Pass `secrets: mediatedSecrets`.

- Modify `packages/agent-vm/src/controller/controller-runtime-types.ts`
  - Extend `createManagedToolVm` dependency options with `secretResolver`.

- Modify `packages/agent-vm/src/controller/controller-runtime.ts`
  - Pass the already-created controller `secretResolver` into default and injected Tool VM creation.

- Modify `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`
  - Add tests that Tool VM creation receives `zone.allowedHosts`.
  - Add tests that only mediated secrets are passed.
  - Update existing `createToolVm()` calls to provide a fake secret resolver.

- Modify `packages/agent-vm/src/controller/controller-runtime.test.ts`
  - Add a small test that injected `createManagedToolVm` receives `secretResolver`.

- Modify `packages/agent-vm/src/controller/runtime-instructions-builder.ts`
  - Add auth recipes for `linear` and `readwise`.
  - Keep `github` recipe as-is.

- Modify `packages/agent-vm/src/controller/runtime-instructions-builder.test.ts`
  - Add coverage for `linear` and `readwise` recipes.

- Modify `docs/subsystems/secrets-and-credentials.md`
  - Document that gateway and Tool VMs both receive HTTP-mediated zone secrets.
  - Document that `env` secrets do not go to Tool VMs unless a future explicit feature adds that.

- Modify `docs/reference/configuration/system-json.md`
  - Clarify `runtimeAuthHints` and Tool VM behavior.
  - Add `linear` and `readwise` example hints.

---

### Task 1: Extract Reusable Secret Splitting

**Files:**
- Modify: `packages/gateway-interface/src/split-resolved-gateway-secrets.ts`
- Modify: `packages/gateway-interface/src/index.ts`
- Create: `packages/gateway-interface/src/split-resolved-gateway-secrets.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway-interface/src/split-resolved-gateway-secrets.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import {
	splitResolvedGatewaySecrets,
	splitResolvedSecretsByInjection,
} from './split-resolved-gateway-secrets.js';

describe('splitResolvedSecretsByInjection', () => {
	it('places http-mediation secrets into mediatedSecrets and env secrets into environmentSecrets', () => {
		const result = splitResolvedSecretsByInjection(
			{
				DISCORD_BOT_TOKEN: {
					injection: 'env',
				},
				READWISE_ACCESS_TOKEN: {
					injection: 'http-mediation',
					hosts: ['readwise.io'],
				},
				LINEAR_API_KEY: {
					injection: 'http-mediation',
					hosts: ['api.linear.app'],
				},
			},
			{
				DISCORD_BOT_TOKEN: 'discord-real-secret',
				READWISE_ACCESS_TOKEN: 'readwise-real-secret',
				LINEAR_API_KEY: 'linear-real-secret',
			},
			'test-split',
		);

		expect(result.environmentSecrets).toEqual({
			DISCORD_BOT_TOKEN: 'discord-real-secret',
		});
		expect(result.mediatedSecrets).toEqual({
			READWISE_ACCESS_TOKEN: {
				hosts: ['readwise.io'],
				value: 'readwise-real-secret',
			},
			LINEAR_API_KEY: {
				hosts: ['api.linear.app'],
				value: 'linear-real-secret',
			},
		});
	});

	it('keeps malformed http-mediation secrets without hosts out of mediatedSecrets', () => {
		const result = splitResolvedSecretsByInjection(
			{
				BROKEN_TOKEN: {
					injection: 'http-mediation',
				},
			},
			{
				BROKEN_TOKEN: 'broken-real-secret',
			},
			'test-split',
		);

		expect(result.environmentSecrets).toEqual({
			BROKEN_TOKEN: 'broken-real-secret',
		});
		expect(result.mediatedSecrets).toEqual({});
	});

	it('warns and skips resolved secrets missing from config', () => {
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

		const result = splitResolvedSecretsByInjection(
			{},
			{
				UNDECLARED_TOKEN: 'undeclared-real-secret',
			},
			'test-split',
		);

		expect(result).toEqual({
			environmentSecrets: {},
			mediatedSecrets: {},
		});
		expect(stderrSpy).toHaveBeenCalledWith(
			"[test-split] Secret 'UNDECLARED_TOKEN' was resolved but has no matching secret config.\n",
		);
	});
});

describe('splitResolvedGatewaySecrets', () => {
	it('keeps the existing gateway wrapper behavior', () => {
		const result = splitResolvedGatewaySecrets(
			{
				id: 'sunfam',
				gateway: {
					type: 'openclaw',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './openclaw.json',
					stateDir: './state',
					ssh: { secretEnv: 'explicit' },
					zoneFilesDir: './zone-files',
				},
				secrets: {
					PERPLEXITY_API_KEY: {
						source: '1password',
						ref: 'op://agent-vm/sunfam-perplexity/credential',
						injection: 'http-mediation',
						hosts: ['api.perplexity.ai'],
					},
					OPENCLAW_GATEWAY_TOKEN: {
						source: '1password',
						ref: 'op://agent-vm/sunfam-gateway-auth/password',
						injection: 'env',
					},
				},
				allowedHosts: ['api.perplexity.ai'],
				websocketBypass: [],
			},
			{
				PERPLEXITY_API_KEY: 'perplexity-real-secret',
				OPENCLAW_GATEWAY_TOKEN: 'gateway-real-secret',
			},
		);

		expect(result).toEqual({
			environmentSecrets: {
				OPENCLAW_GATEWAY_TOKEN: 'gateway-real-secret',
			},
			mediatedSecrets: {
				PERPLEXITY_API_KEY: {
					hosts: ['api.perplexity.ai'],
					value: 'perplexity-real-secret',
				},
			},
		});
	});
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/gateway-interface/src/split-resolved-gateway-secrets.test.ts
```

Expected: FAIL because `splitResolvedSecretsByInjection` is not exported.

- [ ] **Step 3: Implement the reusable splitter**

Replace `packages/gateway-interface/src/split-resolved-gateway-secrets.ts` with:

```ts
import type { SecretSpec } from '@agent-vm/gondolin-adapter';

import type { GatewayZoneConfig } from './gateway-lifecycle.js';

export interface SplitResolvedSecretsResult {
	readonly environmentSecrets: Record<string, string>;
	readonly mediatedSecrets: Record<string, SecretSpec>;
}

export interface SecretInjectionConfig {
	readonly injection: 'env' | 'http-mediation';
	readonly hosts?: readonly string[] | undefined;
}

export function splitResolvedSecretsByInjection(
	secretConfigs: Readonly<Record<string, SecretInjectionConfig>>,
	resolvedSecrets: Record<string, string>,
	logPrefix = 'split-resolved-secrets',
): SplitResolvedSecretsResult {
	const environmentSecrets: Record<string, string> = {};
	const mediatedSecrets: Record<string, SecretSpec> = {};

	for (const [secretName, secretValue] of Object.entries(resolvedSecrets)) {
		const secretConfig = secretConfigs[secretName];
		if (!secretConfig) {
			process.stderr.write(
				`[${logPrefix}] Secret '${secretName}' was resolved but has no matching secret config.\n`,
			);
			continue;
		}

		if (secretConfig.injection === 'http-mediation' && secretConfig.hosts) {
			mediatedSecrets[secretName] = {
				hosts: [...secretConfig.hosts],
				value: secretValue,
			};
			continue;
		}

		environmentSecrets[secretName] = secretValue;
	}

	return { environmentSecrets, mediatedSecrets };
}

export type SplitResolvedGatewaySecretsResult = SplitResolvedSecretsResult;

export function splitResolvedGatewaySecrets(
	zone: GatewayZoneConfig,
	resolvedSecrets: Record<string, string>,
): SplitResolvedGatewaySecretsResult {
	return splitResolvedSecretsByInjection(
		zone.secrets,
		resolvedSecrets,
		'split-resolved-gateway-secrets',
	);
}
```

- [ ] **Step 4: Export the reusable helper**

Modify `packages/gateway-interface/src/index.ts` so the existing export becomes:

```ts
export {
	splitResolvedGatewaySecrets,
	splitResolvedSecretsByInjection,
	type SecretInjectionConfig,
	type SplitResolvedGatewaySecretsResult,
	type SplitResolvedSecretsResult,
} from './split-resolved-gateway-secrets.js';
```

- [ ] **Step 5: Run tests for the splitter**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/gateway-interface/src/split-resolved-gateway-secrets.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run existing OpenClaw gateway lifecycle tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/openclaw-gateway/src/openclaw-lifecycle.test.ts
```

Expected: PASS, proving the wrapper did not change gateway behavior.

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/gateway-interface/src/split-resolved-gateway-secrets.ts packages/gateway-interface/src/split-resolved-gateway-secrets.test.ts packages/gateway-interface/src/index.ts
git commit -m "refactor: share resolved secret splitting"
```

---

### Task 2: Pass Mediated Zone Secrets Into Tool VMs

**Files:**
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`

- [ ] **Step 1: Add a fake secret resolver helper in the Tool VM tests**

In `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`, add this helper below `createPinnedRealFsRoot()`:

```ts
function createSecretResolver(values: Record<string, string>) {
	return {
		resolve: vi.fn(async (ref: { readonly ref: string }) => {
			const value = values[ref.ref];
			if (value === undefined) {
				throw new Error(`Missing test secret for ${ref.ref}`);
			}
			return value;
		}),
		resolveAll: vi.fn(async () => values),
	};
}
```

- [ ] **Step 2: Write the failing Tool VM auth test**

Add this test inside `describe('createToolVm', () => { ... })`, after the `/work` mount test:

```ts
it('passes zone allowed hosts and only mediated zone secrets into the Tool VM', async () => {
	const managedVm = {
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
		enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
		exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		getVmInstance: () => ({
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
			exec: async () => ({ exitCode: 0 }),
			id: 'vm-instance',
			setIngressRoutes: () => {},
		}),
		id: 'managed-vm',
		setIngressRoutes: () => {},
	} satisfies ManagedVm;
	let capturedCreateVmOptions: CreateVmOptions | undefined;
	const createManagedVm = vi.fn(async (createVmOptions: CreateVmOptions) => {
		capturedCreateVmOptions = createVmOptions;
		return managedVm;
	});
	const systemConfig = await createToolVmSystemConfig();
	const zone = systemConfig.zones[0];
	if (!zone) {
		throw new Error('Expected test zone');
	}
	zone.allowedHosts = ['api.github.com', 'api.linear.app', 'readwise.io'];
	zone.secrets = {
		DISCORD_BOT_TOKEN: {
			source: 'environment',
			envVar: 'DISCORD_BOT_TOKEN',
			injection: 'env',
		},
		GITHUB_TOKEN: {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			hosts: ['api.github.com'],
		},
		LINEAR_API_KEY: {
			source: 'environment',
			envVar: 'LINEAR_API_KEY',
			injection: 'http-mediation',
			hosts: ['api.linear.app'],
		},
		READWISE_ACCESS_TOKEN: {
			source: 'environment',
			envVar: 'READWISE_ACCESS_TOKEN',
			injection: 'http-mediation',
			hosts: ['readwise.io'],
		},
	};
	const standardProfile = systemConfig.toolVmProfiles.standard;
	if (!standardProfile) {
		throw new Error('Expected standard tool VM profile');
	}
	const requestedWorkMountDir = await createWorkMountDirectory(systemConfig, 'cli-auth-work-mount');

	await createToolVm(
		{
			cacheDir: systemConfig.cacheDir,
			profile: standardProfile,
			systemConfig,
			tcpSlot: 0,
			hostWorkMountDir: requestedWorkMountDir,
			zoneId: 'shravan',
			secretResolver: createSecretResolver({
				DISCORD_BOT_TOKEN: 'discord-real-secret',
				GITHUB_TOKEN: 'github-real-secret',
				LINEAR_API_KEY: 'linear-real-secret',
				READWISE_ACCESS_TOKEN: 'readwise-real-secret',
			}),
		},
		{
			buildGondolinImage: async () => ({
				built: true,
				fingerprint: 'tool-fingerprint',
				imagePath: '/cache/tool-fingerprint',
			}),
			createManagedVm,
			closePinnedRealFsRoot: () => {},
			pinRealFsRoot: createPinnedRealFsRoot,
		},
	);

	expect(capturedCreateVmOptions).toMatchObject({
		allowedHosts: ['api.github.com', 'api.linear.app', 'readwise.io'],
		secrets: {
			GITHUB_TOKEN: {
				hosts: ['api.github.com'],
				value: 'github-real-secret',
			},
			LINEAR_API_KEY: {
				hosts: ['api.linear.app'],
				value: 'linear-real-secret',
			},
			READWISE_ACCESS_TOKEN: {
				hosts: ['readwise.io'],
				value: 'readwise-real-secret',
			},
		},
	});
	expect(capturedCreateVmOptions?.secrets).not.toHaveProperty('DISCORD_BOT_TOKEN');
});
```

- [ ] **Step 3: Run the Tool VM test to verify it fails**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts --testNamePattern "passes zone allowed hosts"
```

Expected: FAIL because `secretResolver` is not accepted and Tool VMs still receive empty auth.

- [ ] **Step 4: Implement Tool VM mediated auth**

Modify imports in `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`:

```ts
import {
	closePinnedRealFsRoot as closePinnedRealFsRootDefault,
	createManagedVm as createManagedVmFromCore,
	pinRealFsRoot as pinRealFsRootDefault,
	type ManagedVm,
	type PinnedRealFsRoot,
	type SecretResolver,
} from '@agent-vm/gondolin-adapter';
import { splitResolvedSecretsByInjection } from '@agent-vm/gateway-interface';
```

Add this import:

```ts
import { resolveZoneSecrets } from '../gateway/credential-manager.js';
```

Add `secretResolver` to `createToolVm()` options:

```ts
readonly secretResolver: SecretResolver;
```

After confirming `zone` exists and before `createManagedVm()`, add:

```ts
	const resolvedSecrets = await resolveZoneSecrets({
		secretResolver: options.secretResolver,
		systemConfig: options.systemConfig,
		zoneId: options.zoneId,
	});
	const { mediatedSecrets } = splitResolvedSecretsByInjection(
		zone.secrets,
		resolvedSecrets,
		'tool-vm-secrets',
	);
```

Change the `createManagedVm()` call from:

```ts
		allowedHosts: [],
```

to:

```ts
		allowedHosts: zone.allowedHosts,
```

Change:

```ts
		secrets: {},
```

to:

```ts
		secrets: mediatedSecrets,
```

- [ ] **Step 5: Update existing Tool VM tests to pass a fake secret resolver**

For every `createToolVm({ ... })` call in `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`, add:

```ts
secretResolver: createSecretResolver({}),
```

For tests that configure zone secrets, pass the matching fake values as shown in Step 2.

- [ ] **Step 6: Run the Tool VM lifecycle tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
git commit -m "feat: mediate zone auth for tool vms"
```

---

### Task 3: Wire Controller Runtime Secret Resolver Into Tool VM Leases

**Files:**
- Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts`

- [ ] **Step 1: Write the failing controller runtime dependency test**

In `packages/agent-vm/src/controller/controller-runtime.test.ts`, add this test inside `describe('startControllerRuntime', () => { ... })`:

```ts
it('passes the controller secret resolver into managed Tool VM creation', async () => {
	process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
	const secretResolver = {
		resolve: vi.fn(async () => 'resolved-secret'),
		resolveAll: vi.fn(async () => ({})),
	};
	const createSecretResolver = vi.fn(async () => secretResolver);
	const createManagedToolVm = vi.fn(async () => ({
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
		enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
		exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		getVmInstance: () => ({
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
			exec: async () => ({ exitCode: 0 }),
			id: 'tool-vm-instance',
			setIngressRoutes: () => {},
		}),
		id: 'tool-vm',
		setIngressRoutes: () => {},
	}));
	const startHttpServer = vi.fn(async () => ({ close: async () => {} }));
	const startGatewayZone = vi.fn(async () => ({
		image: { built: true, fingerprint: 'gateway-image', imagePath: '/tmp/gateway-image' },
		ingress: { host: '127.0.0.1', port: 18791 },
		processSpec: openClawProcessSpec,
		vm: {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			getVmInstance: () => ({
				close: async () => {},
				enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
				enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
				exec: async () => ({ exitCode: 0 }),
				id: 'gateway-vm-instance',
				setIngressRoutes: () => {},
			}),
			id: 'gateway-vm',
			setIngressRoutes: () => {},
		},
		zone: systemConfig.zones[0],
	}));
	const runtime = await startControllerRuntime(
		{ systemConfig, zoneIds: ['shravan'] },
		{
			createManagedToolVm,
			createSecretResolver,
			now: () => 1,
			setIntervalImpl: (() => ({}) as NodeJS.Timeout) as typeof setInterval,
			clearIntervalImpl: () => {},
			startGatewayZone,
			startHttpServer,
		},
	);

	const app = startHttpServer.mock.calls[0]?.[0].app;
	if (!app) {
		throw new Error('Expected controller app');
	}
	const response = await app.request('/lease', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			agentWorkspaceDir: '/zone/agents/shravan',
			profileId: 'standard',
			scopeKey: 'agent:shravan',
			workMountDir: '/zone/agents/shravan',
			zoneId: 'shravan',
		}),
	});

	expect(response.status).toBe(200);
	expect(createManagedToolVm).toHaveBeenCalledWith(
		expect.objectContaining({
			secretResolver,
			zoneId: 'shravan',
		}),
	);
	await runtime.close();
});
```

- [ ] **Step 2: Run the targeted controller runtime test to verify it fails**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/controller-runtime.test.ts --testNamePattern "passes the controller secret resolver"
```

Expected: FAIL because `createManagedToolVm` options do not include `secretResolver`.

- [ ] **Step 3: Extend the controller dependency type**

In `packages/agent-vm/src/controller/controller-runtime-types.ts`, change `createManagedToolVm` options to:

```ts
readonly createManagedToolVm?: (options: {
	readonly profile: ToolVmProfile;
	readonly tcpSlot: number;
	readonly hostWorkMountDir: string;
	readonly zoneId: string;
	readonly secretResolver: SecretResolver;
}) => Promise<import('@agent-vm/gondolin-adapter').ManagedVm>;
```

- [ ] **Step 4: Pass `secretResolver` through the default `createToolVm()` path**

In `packages/agent-vm/src/controller/controller-runtime.ts`, update the default `createManagedToolVm` implementation:

```ts
const createManagedToolVm =
	dependencies.createManagedToolVm ??
	(async (toolVmOptions): Promise<ManagedVm> =>
		await createToolVm({
			cacheDir: options.systemConfig.cacheDir,
			profile: toolVmOptions.profile,
			systemConfig: options.systemConfig,
			tcpSlot: toolVmOptions.tcpSlot,
			hostWorkMountDir: toolVmOptions.hostWorkMountDir,
			zoneId: toolVmOptions.zoneId,
			secretResolver: toolVmOptions.secretResolver,
		}));
```

- [ ] **Step 5: Pass `secretResolver` through the lease manager bridge**

In `packages/agent-vm/src/controller/controller-runtime.ts`, update the `createLeaseManager()` callback:

```ts
createManagedVm: async (leaseOptions) =>
	await createManagedToolVm({
		profile: leaseOptions.profile,
		tcpSlot: leaseOptions.tcpSlot,
		hostWorkMountDir: leaseOptions.hostWorkMountDir,
		zoneId: leaseOptions.zoneId,
		secretResolver,
	}),
```

- [ ] **Step 6: Run controller runtime tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/controller-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run Tool VM lifecycle tests again**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add packages/agent-vm/src/controller/controller-runtime-types.ts packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime.test.ts
git commit -m "feat: pass secret resolver to tool leases"
```

---

### Task 4: Add Runtime Auth Recipes for Linear and Readwise

**Files:**
- Modify: `packages/agent-vm/src/controller/runtime-instructions-builder.ts`
- Modify: `packages/agent-vm/src/controller/runtime-instructions-builder.test.ts`

- [ ] **Step 1: Write failing recipe tests**

In `packages/agent-vm/src/controller/runtime-instructions-builder.test.ts`, add:

```ts
it('describes Linear mediated auth through LINEAR_API_KEY', () => {
	const result = buildRuntimeInstructions({
		resolvedResources: [],
		runtimeAuthHints: [
			{
				kind: 'service-token',
				secret: 'LINEAR_API_KEY',
				service: 'linear',
				hosts: ['api.linear.app'],
				tools: ['linear'],
			},
		],
		taskId: 'task-linear',
		workDir: '/work',
	});

	expect(result.runtimeInstructions).toContain('LINEAR_API_KEY="$LINEAR_API_KEY" linear issue mine');
	expect(result.runtimeInstructions).toContain('Do not run `linear auth token`');
});

it('describes Readwise mediated auth through login-with-token using the placeholder', () => {
	const result = buildRuntimeInstructions({
		resolvedResources: [],
		runtimeAuthHints: [
			{
				kind: 'service-token',
				secret: 'READWISE_ACCESS_TOKEN',
				service: 'readwise',
				hosts: ['readwise.io'],
				tools: ['readwise'],
			},
		],
		taskId: 'task-readwise',
		workDir: '/work',
	});

	expect(result.runtimeInstructions).toContain('readwise login-with-token "$READWISE_ACCESS_TOKEN"');
	expect(result.runtimeInstructions).toContain('stores the placeholder, not the raw token');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/runtime-instructions-builder.test.ts --testNamePattern "Linear|Readwise"
```

Expected: FAIL because these services use the unknown auth recipe.

- [ ] **Step 3: Add the Linear recipe**

In `packages/agent-vm/src/controller/runtime-instructions-builder.ts`, add:

```ts
function buildLinearAuthRecipe(hint: RuntimeAuthHint): readonly string[] {
	return [
		'Use the mediated placeholder as LINEAR_API_KEY for every linear command:',
		'',
		`  LINEAR_API_KEY="$${hint.secret}" linear issue mine`,
		`  LINEAR_API_KEY="$${hint.secret}" linear issue query --all-teams`,
		'',
		'The schpet/linear-cli reads LINEAR_API_KEY directly, so no auth file is required for basic read/query flows.',
		'Do not run `linear auth token`; that command prints credential material and is not appropriate in a mediated VM.',
		'If a project needs default team/workspace settings, use non-secret config such as LINEAR_TEAM_ID or a checked-in .linear.toml.',
	];
}
```

- [ ] **Step 4: Add the Readwise recipe**

In the same file, add:

```ts
function buildReadwiseAuthRecipe(hint: RuntimeAuthHint): readonly string[] {
	return [
		'Before Readwise commands, log in with the mediated placeholder token:',
		'',
		`  readwise login-with-token "$${hint.secret}"`,
		'',
		'This stores the placeholder, not the raw token. Gondolin substitutes the real token only when Readwise sends an outbound HTTP request to the listed hosts.',
		'If Readwise returns 401 after this setup, report an infrastructure/auth setup failure with the exact command and output.',
	];
}
```

- [ ] **Step 5: Register the recipes**

Update `authRecipes`:

```ts
const authRecipes: Readonly<Record<string, RuntimeAuthRecipeBuilder>> = {
	github: buildGithubAuthRecipe,
	linear: buildLinearAuthRecipe,
	npm: buildNpmAuthRecipe,
	pypi: buildPythonPackageIndexAuthRecipe,
	'pypi-private': buildPythonPackageIndexAuthRecipe,
	python: buildPythonPackageIndexAuthRecipe,
	'python-package-index': buildPythonPackageIndexAuthRecipe,
	readwise: buildReadwiseAuthRecipe,
};
```

- [ ] **Step 6: Run runtime instruction tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/runtime-instructions-builder.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/agent-vm/src/controller/runtime-instructions-builder.ts packages/agent-vm/src/controller/runtime-instructions-builder.test.ts
git commit -m "docs: guide linear and readwise mediated auth"
```

---

### Task 5: Document Tool VM Auth Behavior

**Files:**
- Modify: `docs/subsystems/secrets-and-credentials.md`
- Modify: `docs/reference/configuration/system-json.md`

- [ ] **Step 1: Update subsystem docs**

In `docs/subsystems/secrets-and-credentials.md`, add this section after the existing explanation of mediated secrets:

```md
### Tool VM mediated secrets

Gateway VMs and Tool VMs both use the zone's HTTP-mediated secret policy.

For each zone secret with `injection: "http-mediation"`:

- The host resolves the real secret through the configured secret resolver.
- Gondolin injects a placeholder env var into the VM.
- The real secret is substituted only in outbound HTTP headers for the secret's configured `hosts`.
- The VM process never receives the raw value.

For each zone secret with `injection: "env"`:

- Gateway startup may receive it when the gateway lifecycle needs raw process env, such as Discord bot tokens.
- Tool VMs do not receive it.

This distinction is intentional. Tool VMs should use mediated HTTP tokens for service CLIs such as `gh`, `linear`, and `readwise`, not raw environment secrets.
```

- [ ] **Step 2: Update configuration reference**

In `docs/reference/configuration/system-json.md`, extend the `runtimeAuthHints` example with:

```json
{
  "kind": "service-token",
  "secret": "LINEAR_API_KEY",
  "service": "linear",
  "hosts": ["api.linear.app"],
  "tools": ["linear"]
},
{
  "kind": "service-token",
  "secret": "READWISE_ACCESS_TOKEN",
  "service": "readwise",
  "hosts": ["readwise.io"],
  "tools": ["readwise"]
}
```

Then add this paragraph below the example:

```md
OpenClaw Tool VMs receive the same zone `allowedHosts` and `http-mediation`
secrets as the gateway. They do not receive `env` secrets. If a CLI needs a
token, prefer a mediated secret plus a `runtimeAuthHints` recipe instead of
writing raw credentials into image layers, dotfiles, or auth stores.
```

- [ ] **Step 3: Run formatting check for docs**

Run:

```bash
pnpm fmt:check
```

Expected: PASS. If it fails only because docs were wrapped differently, run:

```bash
pnpm fmt docs/subsystems/secrets-and-credentials.md docs/reference/configuration/system-json.md
```

Then rerun:

```bash
pnpm fmt:check
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git add docs/subsystems/secrets-and-credentials.md docs/reference/configuration/system-json.md
git commit -m "docs: explain tool vm mediated secrets"
```

---

### Task 6: Full Validation

**Files:**
- No source edits expected.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts \
  packages/gateway-interface/src/split-resolved-gateway-secrets.test.ts \
  packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts \
  packages/agent-vm/src/controller/controller-runtime.test.ts \
  packages/agent-vm/src/controller/runtime-instructions-builder.test.ts \
  packages/openclaw-gateway/src/openclaw-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full check**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 4: Commit any validation-only fixes**

If Steps 1-3 required no edits, skip this step.

If formatting or type-only fixes were made, run:

```bash
git add .
git commit -m "chore: fix tool vm auth validation"
```

---

## Deployment Notes for shravan-claw

After this agent-vm change is published and installed in `shravan-claw`, the deployment config should use normal zone config, not raw Tool VM token files:

```jsonc
"secrets": {
  "GITHUB_TOKEN": {
    "source": "1password",
    "ref": "op://agent-vm/sunfam-github/credential",
    "injection": "http-mediation",
    "hosts": ["api.github.com", "github.com"]
  },
  "LINEAR_API_KEY": {
    "source": "1password",
    "ref": "op://agent-vm/sunfam-linear/credential",
    "injection": "http-mediation",
    "hosts": ["api.linear.app"]
  },
  "READWISE_ACCESS_TOKEN": {
    "source": "1password",
    "ref": "op://agent-vm/sunfam-shravan-readwise/credential",
    "injection": "http-mediation",
    "hosts": ["readwise.io"]
  }
},
"runtimeAuthHints": [
  {
    "kind": "service-token",
    "secret": "GITHUB_TOKEN",
    "service": "github",
    "hosts": ["api.github.com"],
    "tools": ["gh"]
  },
  {
    "kind": "service-token",
    "secret": "LINEAR_API_KEY",
    "service": "linear",
    "hosts": ["api.linear.app"],
    "tools": ["linear"]
  },
  {
    "kind": "service-token",
    "secret": "READWISE_ACCESS_TOKEN",
    "service": "readwise",
    "hosts": ["readwise.io"],
    "tools": ["readwise"]
  }
],
"allowedHosts": [
  "api.github.com",
  "github.com",
  "api.linear.app",
  "readwise.io"
]
```

Do not add Discord bot tokens as `http-mediation` secrets. They are gateway process credentials and should remain `injection: "env"`.

Do not put real CLI auth files into Tool VM images. Image layers are durable and shared by profile; mediated auth belongs in runtime config.

## Manual Smoke Test After Publish

In a fresh OpenClaw sandbox after `shravan-claw` upgrades to the new agent-vm:

```bash
printf '%s\n' "$GITHUB_TOKEN" | grep '^GONDOLIN_SECRET_'
GH_TOKEN="$GITHUB_TOKEN" gh api user --jq .login

printf '%s\n' "$LINEAR_API_KEY" | grep '^GONDOLIN_SECRET_'
LINEAR_API_KEY="$LINEAR_API_KEY" linear auth whoami

printf '%s\n' "$READWISE_ACCESS_TOKEN" | grep '^GONDOLIN_SECRET_'
readwise login-with-token "$READWISE_ACCESS_TOKEN"
readwise search test --limit 1
```

Expected:

- The env vars print placeholder prefixes, not raw secrets.
- `gh api user` succeeds.
- `linear auth whoami` succeeds if the token has workspace access.
- `readwise login-with-token` succeeds and subsequent Readwise commands can reach `readwise.io`.

If any command returns `401`, `403`, or `404`, inspect:

- The secret exists in 1Password.
- The secret's `hosts` contains the API host actually used.
- `zones[].allowedHosts` contains the same API host.
- The Tool VM was recreated after the new config was installed.

## Self-Review

Spec coverage:

- Generic Tool VM mediated secrets: Task 2 and Task 3.
- No raw env secrets in Tool VMs: Task 2 test explicitly checks Discord is absent.
- CLI usability for GitHub, Linear, Readwise: Task 4 plus deployment notes.
- Docs for future sessions: Task 5.
- Validation path: Task 6.

Placeholder scan:

- No forbidden placeholder markers or unspecified implementation gaps remain.
- Every code-changing step includes concrete code or exact edits.

Type consistency:

- `secretResolver` type is `SecretResolver` from `@agent-vm/gondolin-adapter` everywhere.
- Splitter result type is `SplitResolvedSecretsResult`.
- Tool VM option names match the existing `createToolVm()` option object style.
