# Gondolin Secret Source Implementation Plan

Status: superseded / reference-only for credentialed tool execution. Do not execute this plan directly.

Superseded by:
- `docs/superpowers/plans/2026-05-10-tool-vm-mediated-cli-auth.md` for the shipped audience-scoped Tool VM mediation direction.
- `docs/superpowers/plans/2026-05-20-credentialed-tool-system.md` for the later credentialed tool target architecture.
- `docs/superpowers/plans/2026-05-22-gondolin-adapter-tool-vm-ssh-cleanup.md` for the prerequisite Gondolin adapter widening.

Still useful as background:
- Secret manager evidence and local Gondolin API notes.
- The distinction between HTTP-mediated secrets and raw credentials.
- Tool VM access/profile concerns that still inform future designs.

Do not use this for:
- Gateway/plugin-owned rotating secret sources.
- Credentialed runner v1 implementation.
- Generic lease or SSH transport design.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `gondolin-secret-source`, a gateway-side secret/token source that can inject and rotate Tool VM HTTP-mediated secrets without exposing raw credentials inside the Tool VM.

**Architecture:** Tool VMs get placeholder environment variables from Gondolin HTTP mediation, while the gateway/plugin owns real tokens and rotates them through the agent-vm controller. The name is `gondolin-secret-source`, not `gondolin-auth-source`, because the primitive is host-held secret substitution; OAuth refresh is one producer of secrets, not the boundary itself.

**Tech Stack:** TypeScript, Zod, Hono controller routes, `@earendil-works/gondolin` `createHttpHooks`, OpenClaw plugin `api.registerTool`/sandbox backend, Vitest.

---

## Current Evidence To Preserve

- `packages/gondolin-adapter/src/vm-adapter.ts` already passes `allowedHosts`, `secrets`, `env`, and `httpHooks` to `VM.create(...)`, but it drops `CreateHttpHooksResult.secretManager`.
- Gateway VMs already use disk-backed `cow` rootfs through `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`.
- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts` currently creates Tool VMs with `allowedHosts: []`, `secrets: {}`, and `rootfsMode: 'memory'`. This is the stale path; Tool VMs should also use disk-backed `cow` by default.
- Tool VM SSH currently inherits Gondolin's default SSH user because `packages/agent-vm/src/controller/leases/lease-manager.ts` calls `vm.enableSsh({ listenPort })` without `user`. Lease serialization falls back to `root` when `sshAccess.user` is missing.
- `zones[].agentToolVmProfiles` already chooses a Tool VM profile per agent ID, but today it only changes CPU/memory/image profile. Secret and egress access are zone-wide because there is no Tool VM access schema yet.
- The default generated Tool VM overlay is intentionally minimal: `extraAptPackages: []`, `openClawPackageOverrides: []`, `copy: []`, and `runAfterBase: []`.
- Gateway VMs already resolve zone secrets through `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`; Tool VM mediation needs a separate config surface so we do not blur gateway egress with Tool VM egress.
- The local Gondolin checkout at `/Users/shravansunder/Documents/dev/open-source/gondolin/host/src/http/hooks.ts` exposes `secretManager.listSecrets()`, `secretManager.updateSecret()`, and `secretManager.deleteSecret()`. DeepWiki currently reports a stale shape for this API, so implementation must test the installed package contract before relying on it.
- The local Gondolin VFS RPC layer passes guest uid/gid into `access(...)`, but `open(...)`, `create(...)`, and `write(...)` delegate to the provider/host process after the file handle exists. Guest-owner RealFS mapping is therefore a non-root compatibility mechanism, not an authorization boundary. Security-sensitive mount denial must come from readonly providers, explicit mount policy, or host filesystem permissions.
- OpenClaw plugin tools and plugin approval hooks exist, but this plan does not put approval policy in the secret source. Approval belongs in OpenClaw tool policy and `before_tool_call`; this component only supplies and rotates mediated secrets.

## File Structure

Modify:

- `packages/gondolin-adapter/src/vm-adapter.ts`
  - Exposes the Gondolin secret manager through `ManagedVm`.
  - Supports guest-owner mapped RealFS mounts so non-root Tool VM users can write `/work` without host-path `chmod 777`.
- `packages/gondolin-adapter/src/vm-adapter.test.ts`
  - Locks placeholder env, update, delete, list behavior, and RealFS guest owner mapping.
- `packages/agent-vm/src/config/system-config.ts`
  - Adds `zones[].toolVmAccess` and `zones[].toolVmAccessByAgent` with Tool VM `allowedHosts` and mediated secret refs.
  - Adds Tool VM profile SSH user and rootfs mode configuration.
- `packages/agent-vm/src/config/system-config.test.ts`
  - Validates Tool VM access config, per-agent overrides, SSH user config, and worker-zone rejection.
- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
  - Resolves Tool VM secrets and passes `allowedHosts`/`secrets` into `createManagedVm`.
  - Uses the configured Tool VM profile `rootfsMode` instead of hardcoding `memory`.
  - Mounts `/work` and zone files with the configured guest uid/gid owner mapping.
- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`
  - Proves resolved Tool VM access, rootfs mode, and non-root SSH settings reach the VM/lease boundary.
- `packages/agent-vm/src/controller/leases/lease-manager.ts`
  - Passes the configured SSH user into `vm.enableSsh(...)`.
- `packages/agent-vm/src/controller/leases/lease-manager.test.ts`
  - Proves non-root SSH user survives lease creation.
- `packages/agent-vm/src/controller/controller-runtime.ts`
  - Threads the existing `SecretResolver` into Tool VM creation.
- `packages/agent-vm/src/controller/controller-runtime-types.ts`
  - Updates dependency typing.
- `packages/agent-vm/src/controller/http/controller-request-schemas.ts`
  - Adds a lease secret update body schema.
- `packages/agent-vm/src/controller/http/controller-http-routes.ts`
  - Adds authenticated `POST /lease/:leaseId/secrets/:secretName`.
- `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
  - Adds the controller-side verifier for lease secret update tokens.
- `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
  - Covers successful update, 404, and invalid payload.
- `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
  - Adds `updateLeaseSecret(...)`.
- `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`
  - Covers controller client request/response behavior.
- `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`
  - Parses `secretSources`.
- `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
  - Creates and wires the secret-source registry into sandbox backend lease creation.
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
  - Calls a lease-ready callback for created and reused leases.
- `packages/openclaw-agent-vm-plugin/openclaw.plugin.json`
  - Documents the plugin config shape for `secretSources`.
- `packages/agent-vm/src/cli/init-command.ts`
  - Scaffolds a useful Tool VM baseline image with shell/navigation tools (`cat`, `ls`, `grep`, `find`, `tree`), modern search tools (`ripgrep`, `fd`), `python3`, `uv`, `jq`, and an `agent` user.
- `packages/agent-vm/src/cli/init-command.test.ts`
  - Locks the generated Tool VM overlay baseline.
- `docs/reference/configuration/system-json.md`
  - Documents `zones[].toolVmAccess`, `zones[].toolVmAccessByAgent`, Tool VM egress, and non-root Tool VM profiles.
- `docs/subsystems/gondolin-vm-layer.md`
  - Replaces the stale "Tool VMs use memory" guidance with the deployment rule: gateway and Tool VMs both default to disk-backed `cow`.
- `docs/architecture/overview.md`
  - Updates the rootfs summary so Tool VM leases are not described as memory-backed.
- `docs/manual/per-agent-setup.md`
  - Explains when `agentToolVmProfiles` is enough and when per-agent `toolVmAccessByAgent` is needed.
- `docs/subsystems/secrets-and-credentials.md`
  - Documents gateway secrets vs Tool VM mediated secrets vs rotating secret sources.

Create:

- `packages/gondolin-adapter/src/vfs-guest-owner-map.ts`
  - Wraps RealFS providers so VFS stat metadata presents a configured guest uid/gid while the host process still owns actual host writes.
- `packages/gondolin-adapter/src/vfs-guest-owner-map.test.ts`
  - Proves mapped stats satisfy non-root access checks without exposing host path ownership.
- `packages/agent-vm/src/tool-vm/tool-vm-secret-access.ts`
  - Resolves zone-level and per-agent `toolVmAccess` into `allowedHosts` and `SecretSpec` for `createManagedVm`.
- `packages/agent-vm/src/tool-vm/tool-vm-secret-access.test.ts`
  - Unit tests for secret splitting and resolver calls.
- `packages/openclaw-agent-vm-plugin/src/secret-source/secret-source-config.ts`
  - Parses and types plugin-level secret source config.
- `packages/openclaw-agent-vm-plugin/src/secret-source/google-oauth-token-provider.ts`
  - Mints Google OAuth access tokens from env-held client credentials and refresh token.
- `packages/openclaw-agent-vm-plugin/src/secret-source/secret-source-registry.ts`
  - Owns provider instances, active lease IDs, refresh skew, and controller updates.
- `packages/openclaw-agent-vm-plugin/src/secret-source/secret-source-registry.test.ts`
  - Tests refresh, reuse, failure, and no-secret-source behavior.

---

### Task 1: Lock The Gondolin SecretManager Contract

**Files:**
- Modify: `packages/gondolin-adapter/src/vm-adapter.test.ts`
- Modify: `packages/gondolin-adapter/src/vm-adapter.ts`

- [ ] **Step 1: Add the failing adapter test**

Append this test inside the existing `describe('createManagedVm', ...)` block in `packages/gondolin-adapter/src/vm-adapter.test.ts`:

```ts
	it('exposes the Gondolin secret manager for runtime-mediated secret rotation', async () => {
		const updateSecret = vi.fn();
		const deleteSecret = vi.fn();
		const listSecrets = vi.fn(() => [
			{
				deleted: false,
				hosts: ['www.googleapis.com'],
				name: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
				placeholder: 'GONDOLIN_SECRET_placeholder',
			},
		]);
		let capturedVmOptions: VMOptions | undefined;
		const dependencies = createBaseDependencies({
			createHttpHooks: vi.fn(() => ({
				env: {
					GOOGLE_CALENDAR_ACCESS_TOKEN: 'GONDOLIN_SECRET_placeholder',
				},
				httpHooks: {},
				secretManager: {
					deleteSecret,
					listSecrets,
					updateSecret,
				},
			})),
			createVm: vi.fn(async (vmOptions: VMOptions) => {
				capturedVmOptions = vmOptions;
				return createFakeVmInstance();
			}),
		});

		const vm = await createManagedVm(
			{
				allowedHosts: ['www.googleapis.com'],
				cpus: 1,
				imagePath: '/tmp/tool.img',
				memory: '1G',
				rootfsMode: 'cow',
				secrets: {
					GOOGLE_CALENDAR_ACCESS_TOKEN: {
						hosts: ['www.googleapis.com'],
						value: 'initial-token',
					},
				},
				vfsMounts: {},
			},
			dependencies,
		);

		expect(capturedVmOptions?.env).toMatchObject({
			GOOGLE_CALENDAR_ACCESS_TOKEN: 'GONDOLIN_SECRET_placeholder',
		});
		expect(vm.listMediatedSecrets()).toEqual([
			{
				deleted: false,
				hosts: ['www.googleapis.com'],
				name: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
				placeholder: 'GONDOLIN_SECRET_placeholder',
			},
		]);

		vm.updateMediatedSecret('GOOGLE_CALENDAR_ACCESS_TOKEN', {
			hosts: ['calendar-json.googleapis.com'],
			value: 'rotated-token',
		});
		vm.deleteMediatedSecret('GOOGLE_CALENDAR_ACCESS_TOKEN');

		expect(updateSecret).toHaveBeenCalledWith('GOOGLE_CALENDAR_ACCESS_TOKEN', {
			hosts: ['calendar-json.googleapis.com'],
			value: 'rotated-token',
		});
		expect(deleteSecret).toHaveBeenCalledWith('GOOGLE_CALENDAR_ACCESS_TOKEN');
	});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/vm-adapter.test.ts -t "runtime-mediated secret rotation"
```

Expected: FAIL because `ManagedVm` does not expose `listMediatedSecrets`, `updateMediatedSecret`, or `deleteMediatedSecret`, and `ManagedVmDependencies.createHttpHooks` currently omits `secretManager`.

- [ ] **Step 3: Expose secret manager types and methods**

In `packages/gondolin-adapter/src/vm-adapter.ts`, add these types after `export type IngressRoute = GondolinIngressRoute;`:

```ts
type GondolinSecretManager = CreateHttpHooksResult['secretManager'];

export type MediatedSecretEntry = ReturnType<GondolinSecretManager['listSecrets']>[number];
export type UpdateMediatedSecretOptions = Parameters<GondolinSecretManager['updateSecret']>[1];
```

Update `ManagedVmDependencies.createHttpHooks`:

```ts
	}): Pick<CreateHttpHooksResult, 'env' | 'httpHooks' | 'secretManager'>;
```

Add the methods to `ManagedVm`:

```ts
	listMediatedSecrets(): readonly MediatedSecretEntry[];
	updateMediatedSecret(secretName: string, options: UpdateMediatedSecretOptions): void;
	deleteMediatedSecret(secretName: string): void;
```

Add these methods to the object returned by `createManagedVm(...)`:

```ts
		listMediatedSecrets(): readonly MediatedSecretEntry[] {
			return hookBundle.secretManager.listSecrets();
		},
		updateMediatedSecret(
			secretName: string,
			secretOptions: UpdateMediatedSecretOptions,
		): void {
			hookBundle.secretManager.updateSecret(secretName, secretOptions);
		},
		deleteMediatedSecret(secretName: string): void {
			hookBundle.secretManager.deleteSecret(secretName);
		},
```

Keep `hookBundle` in a scope visible to the returned object by changing:

```ts
	let vmInstance: ManagedVmInstance;
```

to:

```ts
	let vmInstance: ManagedVmInstance;
	let hookBundle: Pick<CreateHttpHooksResult, 'env' | 'httpHooks' | 'secretManager'>;
```

and changing:

```ts
		const hookBundle = dependencies.createHttpHooks({
```

to:

```ts
		hookBundle = dependencies.createHttpHooks({
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/vm-adapter.test.ts -t "runtime-mediated secret rotation"
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add packages/gondolin-adapter/src/vm-adapter.ts packages/gondolin-adapter/src/vm-adapter.test.ts
git commit -m "feat: expose gondolin mediated secret manager

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Add Tool VM Access Config

**Files:**
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `packages/agent-vm/src/config/system-config.test.ts`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/manual/per-agent-setup.md`

- [ ] **Step 1: Write config parsing tests**

Add these tests to `packages/agent-vm/src/config/system-config.test.ts`:

```ts
	it('parses toolVmAccess for OpenClaw zones', () => {
		const config = createLoadedSystemConfig({
			...createBaseSystemConfigInput(),
			zones: [
				{
					...createBaseOpenClawZoneInput(),
					toolVmAccess: {
						allowedHosts: ['www.googleapis.com', 'calendar-json.googleapis.com'],
						secrets: {
							GOOGLE_CALENDAR_ACCESS_TOKEN: {
								source: 'environment',
								envVar: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
								injection: 'http-mediation',
								hosts: ['www.googleapis.com', 'calendar-json.googleapis.com'],
							},
						},
					},
				},
			],
		});

		expect(config.zones[0]?.toolVmAccess).toEqual({
			allowedHosts: ['www.googleapis.com', 'calendar-json.googleapis.com'],
			secrets: {
				GOOGLE_CALENDAR_ACCESS_TOKEN: {
					source: 'environment',
					envVar: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
					injection: 'http-mediation',
					hosts: ['www.googleapis.com', 'calendar-json.googleapis.com'],
				},
			},
		});
	});

	it('defaults toolVmAccess to deny egress and no mediated secrets', () => {
		const config = createLoadedSystemConfig(createBaseSystemConfigInput());

		expect(config.zones[0]?.toolVmAccess).toEqual({
			allowedHosts: [],
			secrets: {},
		});
		expect(config.zones[0]?.toolVmAccessByAgent).toEqual({});
	});

	it('parses per-agent Tool VM access overrides for OpenClaw zones', () => {
		const config = createLoadedSystemConfig({
			...createBaseSystemConfigInput(),
			zones: [
				{
					...createBaseOpenClawZoneInput(),
					toolVmAccess: {
						allowedHosts: ['www.googleapis.com'],
						secrets: {},
					},
					toolVmAccessByAgent: {
						shravan: {
							allowedHosts: ['calendar-json.googleapis.com'],
							secrets: {
								GOOGLE_CALENDAR_ACCESS_TOKEN: {
									envVar: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
									hosts: ['calendar-json.googleapis.com'],
									injection: 'http-mediation',
									source: 'environment',
								},
							},
						},
					},
				},
			],
		});

		expect(config.zones[0]?.toolVmAccessByAgent).toEqual({
			shravan: {
				allowedHosts: ['calendar-json.googleapis.com'],
				secrets: {
					GOOGLE_CALENDAR_ACCESS_TOKEN: {
						envVar: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
						hosts: ['calendar-json.googleapis.com'],
						injection: 'http-mediation',
						source: 'environment',
					},
				},
			},
		});
	});

	it('defaults Tool VM profiles to cow rootfs with legacy root SSH user', () => {
		const config = createLoadedSystemConfig(createBaseSystemConfigInput());

		expect(config.toolVmProfiles.standard).toMatchObject({
			imageProfile: 'default',
			rootfsMode: 'cow',
			sshGid: 0,
			sshUid: 0,
			sshUser: 'root',
		});
	});

	it('parses explicit non-root Tool VM profiles', () => {
		const config = createLoadedSystemConfig({
			...createBaseSystemConfigInput(),
			toolVmProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
					rootfsMode: 'cow',
					sshGid: 10000,
					sshUid: 10000,
					sshUser: 'agent',
				},
			},
		});

		expect(config.toolVmProfiles.standard).toMatchObject({
			rootfsMode: 'cow',
			sshGid: 10000,
			sshUid: 10000,
			sshUser: 'agent',
		});
	});

	it('rejects Tool VM access config on worker zones', () => {
		expect(() =>
			createLoadedSystemConfig({
				...createBaseWorkerSystemConfigInput(),
				zones: [
					{
						...createBaseWorkerZoneInput(),
							toolVmAccess: {
								allowedHosts: ['www.googleapis.com'],
								secrets: {},
							},
							toolVmAccessByAgent: {
								shravan: {
									allowedHosts: ['calendar-json.googleapis.com'],
									secrets: {},
								},
							},
						},
					],
				}),
		).toThrow("Worker zone 'worker' must not declare Tool VM access.");
	});

	it('rejects Tool VM secrets that are not HTTP-mediated', () => {
		expect(() =>
			createLoadedSystemConfig({
				...createBaseSystemConfigInput(),
				zones: [
					{
						...createBaseOpenClawZoneInput(),
						toolVmAccess: {
							allowedHosts: ['www.googleapis.com'],
							secrets: {
								BAD_TOKEN: {
									envVar: 'BAD_TOKEN',
									injection: 'env',
									source: 'environment',
								},
							},
						},
					},
				],
			}),
		).toThrow(/http-mediation/u);
	});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts -t "toolVmAccess"
```

Expected: FAIL because `toolVmAccess` is not in the schema.

- [ ] **Step 3: Add the schema**

In `packages/agent-vm/src/config/system-config.ts`, add this schema after `runtimeAuthHintSchema`:

```ts
const toolVmMediatedSecretSchema = secretReferenceSchema.and(
	z.object({
		injection: z.literal('http-mediation'),
		hosts: z.array(z.string().min(1)).min(1),
	}),
);

const toolVmAccessSchema = z
	.object({
		allowedHosts: z.array(z.string().min(1)).default([]),
		secrets: z.record(z.string(), toolVmMediatedSecretSchema).default({}),
	})
	.strict();
```

Extend `toolVmProfileSchema`:

```ts
	rootfsMode: z.enum(['readonly', 'memory', 'cow']).default('cow'),
	sshGid: z.number().int().nonnegative().default(0),
	sshUid: z.number().int().nonnegative().default(0),
	sshUser: z.string().min(1).default('root'),
```

Add this property to each zone object:

```ts
							toolVmAccess: toolVmAccessSchema.default({
								allowedHosts: [],
								secrets: {},
							}),
							toolVmAccessByAgent: z.record(agentIdSchema, toolVmAccessSchema).default({}),
```

Extend the `hasOnePasswordSecrets` expression so Tool VM access secrets require `host.secretsProvider` when any Tool VM secret uses 1Password:

```ts
					Object.values(zone.toolVmAccess.secrets).some((secret) => secret.source === '1password') ||
					Object.values(zone.toolVmAccessByAgent).some((agentAccess) =>
						Object.values(agentAccess.secrets).some((secret) => secret.source === '1password'),
					) ||
```

Add this worker-zone validation inside the per-zone validation loop:

```ts
				if (
					zone.gateway.type !== 'openclaw' &&
					(zone.toolVmAccess.allowedHosts.length > 0 ||
						Object.keys(zone.toolVmAccess.secrets).length > 0 ||
						Object.keys(zone.toolVmAccessByAgent).length > 0)
				) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Worker zone '${zone.id}' must not declare Tool VM access.`,
						path: ['zones', zoneIndex, 'toolVmAccess'],
					});
				}
```

- [ ] **Step 4: Document the new config**

In `docs/reference/configuration/system-json.md`, add this section near the existing `zones[].allowedHosts` documentation:

```md
### `zones[].toolVmAccess`

`toolVmAccess` controls outbound HTTP mediation for OpenClaw Tool VMs. It is
separate from gateway VM `allowedHosts` and `secrets`.

```jsonc
{
  "toolVmAccess": {
    "allowedHosts": ["www.googleapis.com", "calendar-json.googleapis.com"],
    "secrets": {
      "GOOGLE_CALENDAR_ACCESS_TOKEN": {
        "source": "environment",
        "envVar": "GOOGLE_CALENDAR_ACCESS_TOKEN",
        "injection": "http-mediation",
        "hosts": ["www.googleapis.com", "calendar-json.googleapis.com"]
      }
    }
  }
}
```

The Tool VM receives placeholder environment variables only. Gondolin replaces
placeholders in outbound HTTP headers when the destination host matches the
secret's `hosts` list. Worker zones must not declare `toolVmAccess` because
they do not create OpenClaw Tool VM leases.

Use `toolVmAccessByAgent` only when agents in the same zone need different
Tool VM egress or secret authority. An agent-specific entry replaces the
zone-level `toolVmAccess`; it does not inherit zone-level hosts or secrets:

```jsonc
{
  "toolVmAccessByAgent": {
    "shravan": {
      "allowedHosts": ["calendar-json.googleapis.com"],
      "secrets": {
        "GOOGLE_CALENDAR_ACCESS_TOKEN": {
          "source": "environment",
          "envVar": "GOOGLE_CALENDAR_ACCESS_TOKEN",
          "injection": "http-mediation",
          "hosts": ["calendar-json.googleapis.com"]
        }
      }
    }
  }
}
```

`agentToolVmProfiles` remains the binary/image isolation surface. Use it when
one agent needs different installed CLIs or a different Tool VM image. Use
`toolVmAccessByAgent` when one agent needs different network or secret
authority and should not inherit the zone default authority. Use both when the
agent must have both a different image and different authority.
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts -t "toolVmAccess"
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add packages/agent-vm/src/config/system-config.ts packages/agent-vm/src/config/system-config.test.ts docs/reference/configuration/system-json.md
git commit -m "feat: add tool vm access config

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Resolve Tool VM Mediated Secrets During Lease Creation

**Files:**
- Create: `packages/agent-vm/src/tool-vm/tool-vm-secret-access.ts`
- Create: `packages/agent-vm/src/tool-vm/tool-vm-secret-access.test.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts`

- [ ] **Step 1: Write resolver unit tests**

Create `packages/agent-vm/src/tool-vm/tool-vm-secret-access.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import type { SecretResolver } from '@agent-vm/gondolin-adapter';

import type { SystemConfig } from '../config/system-config.js';
import { resolveToolVmSecretAccess } from './tool-vm-secret-access.js';

function createSecretResolver(): SecretResolver {
	return {
		resolve: vi.fn(async (secretRef) => {
			if (secretRef.source === 'environment') {
				return `resolved-${secretRef.envVar}`;
			}
			return `resolved-${secretRef.ref}`;
		}),
	};
}

function createSystemConfig(): SystemConfig {
	return {
		cacheDir: '/cache',
		host: {
			controllerPort: 18800,
			projectNamespace: 'agent-vm-test',
		},
		imageProfiles: {
			gateways: {
				openclaw: {
					buildConfig: './gateway.json',
					type: 'openclaw',
				},
			},
			toolVms: {
				standard: {
					buildConfig: './tool.json',
					type: 'toolVm',
				},
			},
		},
		leaseIdleTtl: undefined,
		runtimeDir: '/runtime',
		tcpPool: {
			basePort: 19000,
			size: 8,
		},
		toolVmProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'standard',
					memory: '1G',
					rootfsMode: 'cow',
					sshGid: 10000,
					sshUid: 10000,
					sshUser: 'agent',
				},
			},
		zones: [
			{
				adminAccess: undefined,
				agentSandboxSeeds: undefined,
				agentToolVmProfiles: {},
				allowedHosts: ['api.openai.com'],
				defaultToolVmProfile: 'standard',
				gateway: {
					config: './openclaw.json',
					cpus: 1,
					imageProfile: 'openclaw',
					memory: '1G',
					port: 18789,
					stateDir: './state',
					type: 'openclaw',
					zoneFilesDir: './zone-files',
				},
				id: 'sunfam',
				resources: undefined,
				runtimeAuthHints: undefined,
				secrets: {},
					toolVmAccess: {
						allowedHosts: ['www.googleapis.com'],
						secrets: {
						GOOGLE_CALENDAR_ACCESS_TOKEN: {
							envVar: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
							hosts: ['www.googleapis.com'],
							injection: 'http-mediation',
							source: 'environment',
							},
						},
					},
					toolVmAccessByAgent: {
						shravan: {
							allowedHosts: ['calendar-json.googleapis.com'],
							secrets: {
								GOOGLE_CALENDAR_ACCESS_TOKEN: {
									envVar: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
									hosts: ['calendar-json.googleapis.com'],
									injection: 'http-mediation',
									source: 'environment',
								},
							},
						},
					},
					websocketBypass: [],
				},
			],
	};
}

describe('resolveToolVmSecretAccess', () => {
	it('resolves Tool VM allowed hosts and mediated secrets for a zone', async () => {
		const secretResolver = createSecretResolver();

		const access = await resolveToolVmSecretAccess({
			secretResolver,
			systemConfig: createSystemConfig(),
			zoneId: 'sunfam',
		});

		expect(access).toEqual({
			allowedHosts: ['www.googleapis.com'],
			secrets: {
				GOOGLE_CALENDAR_ACCESS_TOKEN: {
					hosts: ['www.googleapis.com'],
					value: 'resolved-GOOGLE_CALENDAR_ACCESS_TOKEN',
				},
			},
		});
			expect(secretResolver.resolve).toHaveBeenCalledWith({
				envVar: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
				source: 'environment',
			});
		});

	it('uses per-agent Tool VM access instead of zone defaults', async () => {
		const access = await resolveToolVmSecretAccess({
			agentId: 'shravan',
			secretResolver: createSecretResolver(),
				systemConfig: createSystemConfig(),
				zoneId: 'sunfam',
			});

		expect(access).toEqual({
			allowedHosts: ['calendar-json.googleapis.com'],
			secrets: {
				GOOGLE_CALENDAR_ACCESS_TOKEN: {
					hosts: ['calendar-json.googleapis.com'],
						value: 'resolved-GOOGLE_CALENDAR_ACCESS_TOKEN',
					},
				},
			});
		});

		it('returns empty access when no Tool VM access is configured', async () => {
			const systemConfig = createSystemConfig();
		systemConfig.zones[0] = {
			...systemConfig.zones[0]!,
				toolVmAccess: {
					allowedHosts: [],
					secrets: {},
				},
				toolVmAccessByAgent: {},
			};

		await expect(
			resolveToolVmSecretAccess({
				agentId: 'shravan',
				secretResolver: createSecretResolver(),
				systemConfig,
				zoneId: 'sunfam',
			}),
		).resolves.toEqual({
			allowedHosts: [],
			secrets: {},
		});
	});
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/tool-vm/tool-vm-secret-access.test.ts
```

Expected: FAIL because `tool-vm-secret-access.ts` does not exist.

- [ ] **Step 3: Implement the resolver**

Create `packages/agent-vm/src/tool-vm/tool-vm-secret-access.ts`:

```ts
import type { SecretResolver, SecretSpec } from '@agent-vm/gondolin-adapter';

import type { LoadedSystemConfig, SystemConfig } from '../config/system-config.js';

export interface ResolvedToolVmSecretAccess {
	readonly allowedHosts: readonly string[];
	readonly secrets: Record<string, SecretSpec>;
}

export async function resolveToolVmSecretAccess(options: {
	readonly agentId?: string;
	readonly secretResolver: SecretResolver;
	readonly systemConfig: LoadedSystemConfig | SystemConfig;
	readonly zoneId: string;
}): Promise<ResolvedToolVmSecretAccess> {
	const zone = options.systemConfig.zones.find((configuredZone) => configuredZone.id === options.zoneId);
	if (!zone) {
		throw new Error(`Zone '${options.zoneId}' is not configured.`);
	}

	const agentAccess =
		options.agentId === undefined ? undefined : zone.toolVmAccessByAgent[options.agentId];
	const selectedAccess = agentAccess ?? zone.toolVmAccess;
	const allowedHosts = [...selectedAccess.allowedHosts];
	const secretReferences = selectedAccess.secrets;

	const secrets: Record<string, SecretSpec> = {};
	for (const [secretName, secretReference] of Object.entries(secretReferences)) {
		if (secretReference.injection !== 'http-mediation') {
			throw new Error(
				`Tool VM secret '${secretName}' in zone '${options.zoneId}' must use injection 'http-mediation'.`,
			);
		}
		if (!secretReference.hosts || secretReference.hosts.length === 0) {
			throw new Error(
				`Tool VM secret '${secretName}' in zone '${options.zoneId}' must declare at least one host.`,
			);
		}
		secrets[secretName] = {
			hosts: [...secretReference.hosts],
			value: await options.secretResolver.resolve(
				secretReference.source === 'environment'
					? { source: 'environment', envVar: secretReference.envVar }
					: { source: '1password', ref: secretReference.ref },
			),
		};
	}

	return {
		allowedHosts,
		secrets,
	};
}
```

- [ ] **Step 4: Thread resolver into Tool VM lifecycle**

In `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`, import `SecretResolver` and the new helper:

```ts
	type SecretResolver,
```

from `@agent-vm/gondolin-adapter`, and:

```ts
import { resolveToolVmSecretAccess as resolveToolVmSecretAccessDefault } from './tool-vm-secret-access.js';
```

Extend `ToolVmLifecycleDependencies`:

```ts
	readonly resolveToolVmSecretAccess?: typeof resolveToolVmSecretAccessDefault;
```

Extend `createToolVm` options:

```ts
		readonly agentId?: string;
		readonly secretResolver: SecretResolver;
```

Resolve access before `createManagedVm(...)`:

```ts
		const toolVmAccess = await resolveToolVmSecretAccess({
			...(options.agentId ? { agentId: options.agentId } : {}),
			secretResolver: options.secretResolver,
			systemConfig: options.systemConfig,
			zoneId: options.zoneId,
		});
```

Pass it to `createManagedVm(...)`:

```ts
			allowedHosts: toolVmAccess.allowedHosts,
			...
			rootfsMode: options.profile.rootfsMode,
			secrets: toolVmAccess.secrets,
```

- [ ] **Step 5: Update controller runtime threading**

In `packages/agent-vm/src/controller/leases/lease-manager.ts`, add `agentId?: string` to `LeaseManager.createLease(...)` options and pass it through to `options.createManagedVm(...)`.

In `packages/agent-vm/src/controller/http/controller-http-routes.ts`, pass the parsed agent ID into the lease request:

```ts
				...(agentId ? { agentId } : {}),
```

In `packages/agent-vm/src/controller/controller-runtime-types.ts`, add `agentId` and `secretResolver` to `createManagedToolVm` options:

```ts
		readonly agentId?: string;
		readonly secretResolver: SecretResolver;
```

In `packages/agent-vm/src/controller/controller-runtime.ts`, pass `secretResolver` to `createToolVm(...)`:

```ts
				...(toolVmOptions.agentId ? { agentId: toolVmOptions.agentId } : {}),
				secretResolver,
```

and pass it through the `createManagedToolVm(...)` call inside the lease manager:

```ts
				...(leaseOptions.agentId ? { agentId: leaseOptions.agentId } : {}),
				secretResolver,
```

- [ ] **Step 6: Update lifecycle tests**

In `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`, update existing `createToolVm(...)` calls to pass a resolver:

```ts
secretResolver: {
	resolve: vi.fn(async () => 'resolved-secret'),
},
```

Add a focused assertion in the test that captures `createManagedVm` options:

```ts
	expect(createManagedVm).toHaveBeenCalledWith(
		expect.objectContaining({
			allowedHosts: ['www.googleapis.com'],
			rootfsMode: 'cow',
			secrets: {
				GOOGLE_CALENDAR_ACCESS_TOKEN: {
					hosts: ['www.googleapis.com'],
				value: 'resolved-secret',
			},
		},
	}),
);
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/tool-vm/tool-vm-secret-access.test.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts packages/agent-vm/src/controller/controller-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

Run:

```bash
git add packages/agent-vm/src/tool-vm packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime-types.ts
git commit -m "feat: mediate tool vm secrets

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Make Tool VM Profiles Non-Root And Useful By Default

**Files:**
- Create: `packages/gondolin-adapter/src/vfs-guest-owner-map.ts`
- Create: `packages/gondolin-adapter/src/vfs-guest-owner-map.test.ts`
- Modify: `packages/gondolin-adapter/src/vm-adapter.ts`
- Modify: `packages/gondolin-adapter/src/vm-adapter.test.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.test.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `docs/manual/tool-access.md`
- Modify: `docs/manual/per-agent-setup.md`

- [ ] **Step 1: Add VFS guest-owner mapping tests**

Create `packages/gondolin-adapter/src/vfs-guest-owner-map.test.ts` with tests that wrap a fake `VirtualProvider` and prove:

- `stat(...)` and `lstat(...)` report the configured guest `uid` and `gid`.
- `readdir(...)` entries report the configured guest `uid` and `gid` when the wrapped provider includes stat-like directory entries.
- mode bits are preserved.
- write calls are still delegated to the wrapped provider.
- host path ownership is not changed.
- denied mounts are enforced by explicit provider/policy behavior, not by relying on `guestOwner` uid/gid mapping as an authorization boundary.

The core assertion should look like:

```ts
const mappedProvider = createGuestOwnerMappedProvider(fakeProvider, {
	gid: 10000,
	uid: 10000,
});

await expect(mappedProvider.stat('/work')).resolves.toMatchObject({
	gid: 10000,
	uid: 10000,
});
expect(fakeProvider.stat).toHaveBeenCalledWith('/work');
```

This is the systematic non-root fix. Do not solve `/work` by `chmod 777`.
Gondolin VFS `access(...)` checks can compare the guest uid/gid against provider
`stat` metadata, so the Tool VM mount should present `/work` as owned by the
guest agent user for normal shell/tool compatibility. This is not a security
boundary: Gondolin's open/create/write paths ultimately delegate to the wrapped
provider and host process. Do not use `guestOwner` to protect privileged host
paths.

- [ ] **Step 2: Implement guest-owner mapping in the adapter**

In `packages/gondolin-adapter/src/vfs-guest-owner-map.ts`, add a provider wrapper that delegates all operations and maps stat-like return values:

```ts
export interface GuestOwnerMapping {
	readonly gid: number;
	readonly uid: number;
}

export function createGuestOwnerMappedProvider(
	provider: VirtualProvider,
	owner: GuestOwnerMapping,
): VirtualProvider {
	// Implement as a thin delegating VirtualProvider wrapper.
	// For every method returning fs.Stats, clone the stat object and override
	// uid/gid. Do not mutate the wrapped provider's stat object in place.
}
```

Update `VfsMountSpec` in `packages/gondolin-adapter/src/vm-adapter.ts`:

```ts
readonly guestOwner?: {
	readonly gid: number;
	readonly uid: number;
};
```

Wrap `realfs` and `realfs-readonly` providers when `guestOwner` is present.
Keep memory and shadow mounts unchanged.

If the wrapped provider exposes an `access(...)` method, do not accidentally
bypass the guest-owner mapping by delegating `access(...)` directly to host
filesystem access checks. Either omit `access(...)` so Gondolin's stat-based
fallback is exercised, or implement `access(...)` in the wrapper using the
mapped stat metadata. This remains a compatibility check; readonly mounts and
host permissions still own real authorization.

- [ ] **Step 3: Add lease-manager non-root SSH test**

Add a test to `packages/agent-vm/src/controller/leases/lease-manager.test.ts`:

```ts
it('passes the Tool VM profile SSH user into enableSsh', async () => {
	const enableSsh = vi.fn(async (options?: { readonly listenPort?: number; readonly user?: string }) => ({
		host: '127.0.0.1',
		port: options?.listenPort ?? 22,
		user: options?.user,
	}));
	const manager = createLeaseManager({
		createManagedVm: async () => ({ ...createFakeManagedVm(), enableSsh }),
		now: () => 1_000,
		tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
	});

	await manager.createLease({
		agentWorkspaceDir: '/workspace',
		guestWorkdir: '/work',
		hostWorkMountDir: '/host/work',
		profile: {
			cpus: 1,
			imageProfile: 'default',
			memory: '1G',
			rootfsMode: 'cow',
			sshGid: 10000,
			sshUid: 10000,
			sshUser: 'agent',
		},
		profileId: 'standard',
		scopeKey: 'agent:shravan',
		zoneId: 'sunfam',
	});

	expect(enableSsh).toHaveBeenCalledWith({
		listenPort: 19000,
		user: 'agent',
	});
});
```

- [ ] **Step 4: Pass the SSH user from the profile**

In `packages/agent-vm/src/controller/leases/lease-manager.ts`, change:

```ts
const sshAccess = await vm.enableSsh({
	listenPort: options.tcpPool.portForSlot(tcpSlot),
});
```

to:

```ts
const sshAccess = await vm.enableSsh({
	listenPort: options.tcpPool.portForSlot(tcpSlot),
	user: leaseOptions.profile.sshUser,
});
```

`tools.exec: full` still works with this. OpenClaw's exec policy decides
whether a command is allowed; the command then runs over SSH as
`lease.sshAccess.user`. With `sshUser: "agent"`, full exec means unrestricted
shell inside the VM as `agent`, not root.

- [ ] **Step 5: Mount Tool VM RealFS roots as the profile guest owner**

In `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`, add `guestOwner` to
the `/work`, `/zone-files`, and `/zone-git` mount specs:

```ts
	const guestOwner = {
		gid: options.profile.sshGid,
		uid: options.profile.sshUid,
	};
```

Then include it on each writable RealFS mount:

```ts
guestOwner,
kind: 'realfs',
```

Also pass the configured rootfs mode:

```ts
rootfsMode: options.profile.rootfsMode,
```

The deployment-wide default is disk-backed `cow`, not `memory`, for both
gateway VMs and Tool VMs. `memory` is allowed only as an explicit test or
throwaway experiment because it increases pressure on host memory and loses the
fast disk-backed COW behavior documented in
`docs/reference/gondolin/vfs-rootfs-performance.md`.

- [ ] **Step 6: Scaffold baseline Tool VM packages and the agent user**

In `packages/agent-vm/src/cli/init-command.ts`, change the default Tool VM
profile to:

```ts
standard: {
	memory: '1G',
	cpus: 1,
	imageProfile: 'default',
	rootfsMode: 'cow',
	sshGid: 10000,
	sshUid: 10000,
	sshUser: 'agent',
},
```

This is a scaffold default, not the schema default. Existing deployments that
do not set `sshUser` continue to use `root` until their Tool VM image is updated
to contain the configured non-root user. Protected/auth-heavy deployments should
opt in by setting `sshUser: "agent"` and using an image overlay that creates
that account.

Change the generated Tool VM overlay to install the baseline tools:

```ts
extraAptPackages: [
	'coreutils',
	'fd-find',
	'findutils',
	'grep',
	'jq',
	'python3',
	'python3-pip',
	'python3-venv',
	'ripgrep',
	'tree',
],
runAfterBase: [
	'getent group 10000 >/dev/null || groupadd --gid 10000 agent',
	'id -u agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --uid 10000 --gid 10000 agent',
	'python3 -m pip install --break-system-packages uv',
	'ln -sf /usr/bin/fdfind /usr/local/bin/fd',
],
```

Update `packages/agent-vm/src/cli/init-command.test.ts` expectations for:

- `toolVmProfiles.standard.rootfsMode === 'cow'`
- `toolVmProfiles.standard.sshUser === 'agent'`
- `toolVmProfiles.standard.sshUid === 10000`
- `toolVmProfiles.standard.sshGid === 10000`
- overlay packages include `coreutils`, `grep`, `findutils`, `tree`, `python3`, `python3-venv`, `python3-pip`, `jq`, `ripgrep`, and `fd-find`
- the live canary verifies `cat`, `ls`, `grep`, `find`, `tree`, `rg`, and `fd` exist on `PATH`
- `runAfterBase` creates `agent`, installs `uv`, and creates the `fd` symlink

Update stale docs in `docs/subsystems/gondolin-vm-layer.md` and
`docs/architecture/overview.md` so they say:

```md
Gateway VMs and Tool VMs both default to `cow` rootfs. `cow` is disk-backed and
keeps hot VM-local filesystem work off Gondolin VFS/RealFS while avoiding the
host memory pressure of `memory`. Use `memory` only when a test explicitly
needs an in-memory throwaway rootfs.
```

- [ ] **Step 7: Add live Tool VM canaries for root and non-root profiles**

Add or extend integration tests that boot both profile shapes:

- schema-default/root profile: proves existing deployments still boot and run
  `/work` commands as root when `sshUser` is unset.
- explicit non-root profile: uses `sshUser: "agent"`, `sshUid: 10000`, and
  `sshGid: 10000`; proves the scaffolded protected Tool VM path works.

The non-root canary runs:

```bash
id -u
id -g
touch /work/.agent-vm-non-root-canary
cat /etc/os-release >/dev/null
ls /work >/dev/null
printf 'needle\n' | grep needle >/dev/null
find /work -maxdepth 1 -type f >/dev/null
tree -L 1 /work >/dev/null
python3 --version
uv --version
jq --version
rg --version
fd --version
```

Expected:

- `id -u` prints `10000`.
- `id -g` prints `10000`.
- `touch /work/.agent-vm-non-root-canary` succeeds.
- every baseline tool command exits 0.

If `touch /work/...` fails, stop and fix the VFS guest-owner mapping. Do not
fall back to root SSH or broad host path permissions.

- [ ] **Step 8: Run focused tests**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/vfs-guest-owner-map.test.ts packages/gondolin-adapter/src/vm-adapter.test.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts packages/agent-vm/src/cli/init-command.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 4**

Run:

```bash
git add packages/gondolin-adapter/src packages/agent-vm/src/controller/leases/lease-manager.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts docs/manual/tool-access.md docs/manual/per-agent-setup.md docs/subsystems/gondolin-vm-layer.md docs/architecture/overview.md
git commit -m "feat: run tool vm leases as non-root

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Add Controller Route To Rotate Lease Secrets

**Files:**
- Modify: `packages/agent-vm/src/controller/http/controller-request-schemas.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`

- [ ] **Step 1: Write controller route tests**

Add this test to `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`:

```ts
	it('updates a mediated secret on an active lease', async () => {
		const updateMediatedSecret = vi.fn();
		const app = createControllerAppForTest({
			leaseManager: createLeaseManagerStub({
				peekLease: () => ({
					kind: 'snapshot',
					lease: {
						...createLeaseStub('lease-123', 0),
						vm: {
							...createLeaseStub('lease-123', 0).vm,
							updateMediatedSecret,
						},
					},
				}),
			}),
		});

		const response = await app.request('/lease/lease-123/secrets/GOOGLE_CALENDAR_ACCESS_TOKEN', {
			body: JSON.stringify({
				hosts: ['www.googleapis.com'],
				value: 'access-token-2',
			}),
			headers: {
				'content-type': 'application/json',
				'x-agent-vm-lease-secret-token': 'controller-secret-token',
			},
			method: 'POST',
		});

		await expect(response.json()).resolves.toEqual({
			ok: true,
			leaseId: 'lease-123',
			secretName: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
		});
		expect(response.status).toBe(200);
		expect(updateMediatedSecret).toHaveBeenCalledWith('GOOGLE_CALENDAR_ACCESS_TOKEN', {
			hosts: ['www.googleapis.com'],
			value: 'access-token-2',
		});
	});
```

Add auth tests before the success test:

```ts
	it('rejects mediated secret updates without the controller secret token', async () => {
		const app = createControllerAppForTest({
			verifyLeaseSecretUpdateToken: (token) => token === 'controller-secret-token',
		});

		const response = await app.request('/lease/lease-123/secrets/TOKEN', {
			body: JSON.stringify({ value: 'token' }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
	});
```

The success test must create the app with the same verifier:

```ts
verifyLeaseSecretUpdateToken: (token) => token === 'controller-secret-token',
```

Add 404 and validation tests:

These tests should also pass `verifyLeaseSecretUpdateToken: (token) => token ===
'controller-secret-token'` so they exercise missing lease/validation behavior
after authentication has succeeded.

```ts
	it('returns 404 when updating a secret for a missing lease', async () => {
		const app = createControllerAppForTest({
			leaseManager: createLeaseManagerStub({
				peekLease: () => undefined,
			}),
		});

		const response = await app.request('/lease/missing/secrets/TOKEN', {
			body: JSON.stringify({ value: 'token' }),
			headers: {
				'content-type': 'application/json',
				'x-agent-vm-lease-secret-token': 'controller-secret-token',
			},
			method: 'POST',
		});

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({ error: 'Lease not found' });
	});

	it('rejects empty mediated secret updates', async () => {
		const app = createControllerAppForTest();

		const response = await app.request('/lease/lease-123/secrets/TOKEN', {
			body: JSON.stringify({}),
			headers: {
				'content-type': 'application/json',
				'x-agent-vm-lease-secret-token': 'controller-secret-token',
			},
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'invalid-secret-update-request',
		});
	});
```

- [ ] **Step 2: Run route tests and verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts -t "mediated secret|secret updates|missing lease"
```

Expected: FAIL because the route and schema do not exist.

- [ ] **Step 3: Add the request schema**

In `packages/agent-vm/src/controller/http/controller-request-schemas.ts`, add:

```ts
export const controllerLeaseSecretUpdateRequestSchema = z
	.object({
		hosts: z.array(z.string().min(1)).optional(),
		value: z.string().min(1).optional(),
	})
	.strict()
	.superRefine((payload, context) => {
		if (payload.value === undefined && payload.hosts === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'At least one of value or hosts is required.',
			});
		}
	});
```

- [ ] **Step 4: Add the controller route**

In `packages/agent-vm/src/controller/http/controller-http-route-support.ts`, add a
controller operation/verifier for this route:

```ts
readonly verifyLeaseSecretUpdateToken?: (token: string | undefined) => boolean;
```

Update the import in `packages/agent-vm/src/controller/http/controller-http-routes.ts`:

```ts
import {
	controllerLeaseCreateRequestSchema,
	controllerLeaseSecretUpdateRequestSchema,
} from './controller-request-schemas.js';
```

Add this route before `app.delete('/lease/:leaseId', ...)`:

```ts
	app.post('/lease/:leaseId/secrets/:secretName', async (context) => {
		const token = context.req.header('x-agent-vm-lease-secret-token');
		if (!options.operations?.verifyLeaseSecretUpdateToken?.(token)) {
			return context.json({ error: 'Forbidden' }, 403);
		}
		const parsedPayload = controllerLeaseSecretUpdateRequestSchema.safeParse(
			await context.req.json(),
		);
		if (!parsedPayload.success) {
			return context.json(
				{
					error: 'invalid-secret-update-request',
					issues: parsedPayload.error.issues,
				},
				400,
			);
		}
		const leaseId = context.req.param('leaseId');
		const secretName = context.req.param('secretName');
		const leaseSnapshot = options.leaseManager.peekLease(leaseId);
		if (!leaseSnapshot) {
			return context.json({ error: 'Lease not found' }, 404);
		}

		leaseSnapshot.lease.vm.updateMediatedSecret(secretName, parsedPayload.data);
		return context.json({
			ok: true,
			leaseId,
			secretName,
		});
	});
```

- [ ] **Step 5: Add lease client support**

In `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`, add a
lease-client option:

```ts
readonly leaseSecretUpdateToken?: string;
```

Then add this to `LeaseClient`:

```ts
	updateLeaseSecret(
		leaseId: string,
		secretName: string,
		update: {
			readonly hosts?: readonly string[];
			readonly value?: string;
		},
	): Promise<void>;
```

Add this method in `createLeaseClient(...)`:

```ts
		updateLeaseSecret: async (leaseId, secretName, update): Promise<void> => {
			const response = await fetchImpl(
				`${baseUrl}/lease/${encodeURIComponent(leaseId)}/secrets/${encodeURIComponent(secretName)}`,
				{
					body: JSON.stringify({
						...(update.hosts ? { hosts: [...update.hosts] } : {}),
						...(update.value ? { value: update.value } : {}),
					}),
					headers: {
						'content-type': 'application/json',
						...(options.leaseSecretUpdateToken
							? { 'x-agent-vm-lease-secret-token': options.leaseSecretUpdateToken }
							: {}),
					},
					method: 'POST',
				},
			);
			if (!response.ok) {
				const errorBody = await readErrorBody(response, 'Controller lease secret update API');
				throw new ControllerLeaseRequestError({
					bodyText: errorBody.bodyText,
					context: 'Controller lease secret update API',
					responseBody: errorBody.responseBody,
					status: response.status,
				});
			}
		},
```

Add a client test in `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`:

```ts
	it('updates mediated lease secrets through the controller API', async () => {
		const requests: readonly {
			readonly body?: string;
			readonly init?: RequestInit;
			readonly url: string;
		}[] = [];
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			leaseSecretUpdateToken: 'controller-secret-token',
			fetchImpl: async (input, init) => {
				requests.push({
					body: typeof init?.body === 'string' ? init.body : undefined,
					init,
					url: String(input),
				});
				return new Response(null, { status: 204 });
			},
		});

		await leaseClient.updateLeaseSecret('lease-123', 'GOOGLE_CALENDAR_ACCESS_TOKEN', {
			hosts: ['www.googleapis.com'],
			value: 'access-token-2',
		});

		expect(requests).toEqual([
			{
				body: JSON.stringify({
					hosts: ['www.googleapis.com'],
					value: 'access-token-2',
				}),
				init: expect.objectContaining({
					headers: {
						'content-type': 'application/json',
						'x-agent-vm-lease-secret-token': 'controller-secret-token',
					},
					method: 'POST',
				}),
				url: 'http://controller.vm.host:18800/lease/lease-123/secrets/GOOGLE_CALENDAR_ACCESS_TOKEN',
			},
		]);
	});
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

Run:

```bash
git add packages/agent-vm/src/controller/http packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts
git commit -m "feat: rotate mediated lease secrets

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Implement The OpenClaw Secret Source Registry

**Files:**
- Create: `packages/openclaw-agent-vm-plugin/src/secret-source/secret-source-config.ts`
- Create: `packages/openclaw-agent-vm-plugin/src/secret-source/google-oauth-token-provider.ts`
- Create: `packages/openclaw-agent-vm-plugin/src/secret-source/secret-source-registry.ts`
- Create: `packages/openclaw-agent-vm-plugin/src/secret-source/secret-source-registry.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
- Modify: `packages/openclaw-agent-vm-plugin/openclaw.plugin.json`

- [ ] **Step 1: Add config parsing tests**

Create `packages/openclaw-agent-vm-plugin/src/secret-source/secret-source-registry.test.ts` with this first test:

```ts
import { describe, expect, it, vi } from 'vitest';

import { ControllerLeaseRequestError } from '../controller-lease-client.js';
import { parseSecretSourceConfig } from './secret-source-config.js';
import { createSecretSourceRegistry } from './secret-source-registry.js';

describe('secret source config', () => {
	it('parses Google OAuth refresh token sources', () => {
		expect(
			parseSecretSourceConfig({
				GOOGLE_CALENDAR_ACCESS_TOKEN: {
					clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
					clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
					hosts: ['www.googleapis.com', 'calendar-json.googleapis.com'],
					kind: 'google-oauth-refresh',
					refreshSkewMs: 300_000,
					refreshTokenEnv: 'GOOGLE_CALENDAR_REFRESH_TOKEN',
					scopes: ['https://www.googleapis.com/auth/calendar'],
				},
			}),
		).toEqual({
			GOOGLE_CALENDAR_ACCESS_TOKEN: {
				clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
				clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
				hosts: ['www.googleapis.com', 'calendar-json.googleapis.com'],
				kind: 'google-oauth-refresh',
				refreshSkewMs: 300_000,
				refreshTokenEnv: 'GOOGLE_CALENDAR_REFRESH_TOKEN',
				scopes: ['https://www.googleapis.com/auth/calendar'],
				tokenEndpoint: 'https://oauth2.googleapis.com/token',
			},
		});
	});
});
```

- [ ] **Step 2: Implement secret source config**

Create `packages/openclaw-agent-vm-plugin/src/secret-source/secret-source-config.ts`:

```ts
import { z } from 'zod';

const googleOAuthRefreshSourceSchema = z
	.object({
		clientIdEnv: z.string().min(1),
		clientSecretEnv: z.string().min(1),
		hosts: z.array(z.string().min(1)).min(1),
		kind: z.literal('google-oauth-refresh'),
		refreshSkewMs: z.number().int().positive().default(300_000),
		refreshTokenEnv: z.string().min(1),
		scopes: z.array(z.string().min(1)).default([]),
		tokenEndpoint: z.string().url().default('https://oauth2.googleapis.com/token'),
	})
	.strict();

export const secretSourceConfigSchema = z.record(
	z.string().min(1),
	z.discriminatedUnion('kind', [googleOAuthRefreshSourceSchema]),
);

export type SecretSourceConfig = z.infer<typeof secretSourceConfigSchema>;

export function parseSecretSourceConfig(value: unknown): SecretSourceConfig {
	return secretSourceConfigSchema.parse(value ?? {});
}
```

- [ ] **Step 3: Add Google token provider tests**

Append this test to `secret-source-registry.test.ts`:

```ts
describe('createSecretSourceRegistry', () => {
	it('refreshes Google OAuth sources and updates active lease secrets', async () => {
		const updateLeaseSecret = vi.fn(async () => {});
		const fetchImpl = vi.fn(async () =>
			new Response(
				JSON.stringify({
					access_token: 'access-token-1',
					expires_in: 3600,
					token_type: 'Bearer',
				}),
				{
					headers: { 'content-type': 'application/json' },
					status: 200,
				},
			),
		);
		const registry = createSecretSourceRegistry({
			env: {
				GOOGLE_CALENDAR_REFRESH_TOKEN: 'refresh-token',
				GOOGLE_OAUTH_CLIENT_ID: 'client-id',
				GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
			},
			fetchImpl,
			leaseClient: {
				updateLeaseSecret,
			},
			now: () => 1_000,
			secretSources: parseSecretSourceConfig({
				GOOGLE_CALENDAR_ACCESS_TOKEN: {
					clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
					clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
					hosts: ['www.googleapis.com'],
					kind: 'google-oauth-refresh',
					refreshTokenEnv: 'GOOGLE_CALENDAR_REFRESH_TOKEN',
				},
			}),
		});

		await registry.ensureLeaseSecretsFresh({ leaseId: 'lease-123' });

		expect(fetchImpl).toHaveBeenCalledWith(
			'https://oauth2.googleapis.com/token',
			expect.objectContaining({
				method: 'POST',
			}),
		);
		expect(updateLeaseSecret).toHaveBeenCalledWith('lease-123', 'GOOGLE_CALENDAR_ACCESS_TOKEN', {
			hosts: ['www.googleapis.com'],
			value: 'access-token-1',
		});
	});

	it('refreshes tracked leases during long-lived sessions before access tokens expire', async () => {
		let now = 1_000;
		const updateLeaseSecret = vi.fn(async () => {});
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ access_token: 'access-token-1', expires_in: 3600 }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ access_token: 'access-token-2', expires_in: 3600 }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				}),
			);
		const registry = createSecretSourceRegistry({
			env: {
				GOOGLE_CALENDAR_REFRESH_TOKEN: 'refresh-token',
				GOOGLE_OAUTH_CLIENT_ID: 'client-id',
				GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
			},
			fetchImpl,
			leaseClient: { updateLeaseSecret },
			now: () => now,
			secretSources: parseSecretSourceConfig({
				GOOGLE_CALENDAR_ACCESS_TOKEN: {
					clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
					clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
					hosts: ['www.googleapis.com'],
					kind: 'google-oauth-refresh',
					refreshSkewMs: 300_000,
					refreshTokenEnv: 'GOOGLE_CALENDAR_REFRESH_TOKEN',
				},
			}),
		});

		await registry.trackLease({ leaseId: 'lease-123' });
		now = 3_302_000;
		await registry.ensureTrackedLeasesFresh();

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(updateLeaseSecret).toHaveBeenLastCalledWith(
			'lease-123',
			'GOOGLE_CALENDAR_ACCESS_TOKEN',
			expect.objectContaining({ value: 'access-token-2' }),
		);
	});

	it('does not resend unchanged cached secrets to tracked leases', async () => {
		const updateLeaseSecret = vi.fn(async () => {});
		const registry = createSecretSourceRegistry({
			env: {
				GOOGLE_CALENDAR_REFRESH_TOKEN: 'refresh-token',
				GOOGLE_OAUTH_CLIENT_ID: 'client-id',
				GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
			},
			fetchImpl: vi.fn(async () =>
				new Response(JSON.stringify({ access_token: 'access-token-1', expires_in: 3600 }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				}),
			),
			leaseClient: { updateLeaseSecret },
			now: () => 1_000,
			secretSources: parseSecretSourceConfig({
				GOOGLE_CALENDAR_ACCESS_TOKEN: {
					clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
					clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
					hosts: ['www.googleapis.com'],
					kind: 'google-oauth-refresh',
					refreshTokenEnv: 'GOOGLE_CALENDAR_REFRESH_TOKEN',
				},
			}),
		});

		await registry.trackLease({ leaseId: 'lease-123' });
		await registry.ensureTrackedLeasesFresh();

		expect(updateLeaseSecret).toHaveBeenCalledTimes(1);
	});

	it('forgets tracked leases when the controller reports the lease is gone', async () => {
		const updateLeaseSecret = vi.fn(async () => {
			throw new ControllerLeaseRequestError({
				bodyText: '{"error":"Lease not found"}',
				context: 'Controller lease secret update API',
				responseBody: { error: 'Lease not found' },
				status: 404,
			});
		});
		const registry = createSecretSourceRegistry({
			env: {
				GOOGLE_CALENDAR_REFRESH_TOKEN: 'refresh-token',
				GOOGLE_OAUTH_CLIENT_ID: 'client-id',
				GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
			},
			fetchImpl: vi.fn(async () =>
				new Response(JSON.stringify({ access_token: 'access-token-1', expires_in: 3600 }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				}),
			),
			leaseClient: { updateLeaseSecret },
			now: () => 1_000,
			secretSources: parseSecretSourceConfig({
				GOOGLE_CALENDAR_ACCESS_TOKEN: {
					clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
					clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
					hosts: ['www.googleapis.com'],
					kind: 'google-oauth-refresh',
					refreshTokenEnv: 'GOOGLE_CALENDAR_REFRESH_TOKEN',
				},
			}),
		});

		await registry.trackLease({ leaseId: 'lease-123' });
		await registry.ensureTrackedLeasesFresh();

		expect(updateLeaseSecret).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 4: Implement Google provider and registry**

Create `packages/openclaw-agent-vm-plugin/src/secret-source/google-oauth-token-provider.ts`:

```ts
import type { SecretSourceConfig } from './secret-source-config.js';

export interface TokenRefreshResult {
	readonly accessToken: string;
	readonly expiresAtMs: number;
}

export async function refreshGoogleOAuthAccessToken(options: {
	readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>;
	readonly fetchImpl: typeof fetch;
	readonly now: () => number;
	readonly source: Extract<SecretSourceConfig[string], { readonly kind: 'google-oauth-refresh' }>;
}): Promise<TokenRefreshResult> {
	const clientId = options.env[options.source.clientIdEnv];
	const clientSecret = options.env[options.source.clientSecretEnv];
	const refreshToken = options.env[options.source.refreshTokenEnv];
	if (!clientId) {
		throw new Error(`Missing Google OAuth client id env '${options.source.clientIdEnv}'.`);
	}
	if (!clientSecret) {
		throw new Error(`Missing Google OAuth client secret env '${options.source.clientSecretEnv}'.`);
	}
	if (!refreshToken) {
		throw new Error(`Missing Google OAuth refresh token env '${options.source.refreshTokenEnv}'.`);
	}

	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
	});
	if (options.source.scopes.length > 0) {
		body.set('scope', options.source.scopes.join(' '));
	}

	const response = await options.fetchImpl(options.source.tokenEndpoint, {
		body,
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
		},
		method: 'POST',
	});
	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(
			`Google OAuth token refresh failed with HTTP ${String(response.status)}: ${responseText.slice(0, 300)}`,
		);
	}
	const payload = JSON.parse(responseText) as {
		access_token?: unknown;
		expires_in?: unknown;
	};
	if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
		throw new Error('Google OAuth token refresh response did not include access_token.');
	}
	const expiresInSeconds = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
	return {
		accessToken: payload.access_token,
		expiresAtMs: options.now() + expiresInSeconds * 1000,
	};
}
```

Create `packages/openclaw-agent-vm-plugin/src/secret-source/secret-source-registry.ts`:

```ts
import { ControllerLeaseRequestError, type LeaseClient } from '../controller-lease-client.js';
import { refreshGoogleOAuthAccessToken } from './google-oauth-token-provider.js';
import type { SecretSourceConfig } from './secret-source-config.js';

interface CachedSecretValue {
	readonly expiresAtMs: number;
	readonly value: string;
}

export interface SecretSourceRegistry {
	ensureLeaseSecretsFresh(options: { readonly leaseId: string }): Promise<void>;
	ensureTrackedLeasesFresh(): Promise<void>;
	forgetLease(options: { readonly leaseId: string }): void;
	start(): void;
	stop(): void;
	trackLease(options: { readonly leaseId: string }): Promise<void>;
}

export function createSecretSourceRegistry(options: {
	readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
	readonly fetchImpl?: typeof fetch;
	readonly leaseClient: Pick<LeaseClient, 'updateLeaseSecret'>;
	readonly now?: () => number;
	readonly secretSources: SecretSourceConfig;
}): SecretSourceRegistry {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const cache = new Map<string, CachedSecretValue>();
	const appliedLeaseSecrets = new Map<string, Map<string, string>>();
	const trackedLeaseIds = new Set<string>();
	let refreshTimer: NodeJS.Timeout | undefined;

	async function resolveSecretValue(secretName: string): Promise<CachedSecretValue> {
		const source = options.secretSources[secretName];
		if (!source) {
			throw new Error(`Unknown secret source '${secretName}'.`);
		}
		const cached = cache.get(secretName);
		if (cached && cached.expiresAtMs - source.refreshSkewMs > now()) {
			return cached;
		}

		switch (source.kind) {
			case 'google-oauth-refresh': {
				const refreshed = await refreshGoogleOAuthAccessToken({
					env,
					fetchImpl,
					now,
					source,
				});
				const nextCached = {
					expiresAtMs: refreshed.expiresAtMs,
					value: refreshed.accessToken,
				};
				cache.set(secretName, nextCached);
				return nextCached;
			}
		}
	}

	function isMissingLeaseError(error: unknown): boolean {
		return error instanceof ControllerLeaseRequestError && error.status === 404;
	}

	async function ensureLeaseSecretsFresh({ leaseId }: { readonly leaseId: string }): Promise<void> {
		if (Object.keys(options.secretSources).length === 0) {
			return;
		}
		try {
			for (const [secretName, source] of Object.entries(options.secretSources)) {
				const resolvedSecret = await resolveSecretValue(secretName);
				const appliedKey = JSON.stringify({
					hosts: source.hosts,
					value: resolvedSecret.value,
				});
				const leaseAppliedSecrets = appliedLeaseSecrets.get(leaseId) ?? new Map<string, string>();
				if (leaseAppliedSecrets.get(secretName) === appliedKey) {
					continue;
				}
				await options.leaseClient.updateLeaseSecret(leaseId, secretName, {
					hosts: source.hosts,
					value: resolvedSecret.value,
				});
				leaseAppliedSecrets.set(secretName, appliedKey);
				appliedLeaseSecrets.set(leaseId, leaseAppliedSecrets);
			}
		} catch (error) {
			if (isMissingLeaseError(error)) {
				trackedLeaseIds.delete(leaseId);
				appliedLeaseSecrets.delete(leaseId);
				return;
			}
			throw error;
		}
	}

	async function ensureTrackedLeasesFresh(): Promise<void> {
		for (const leaseId of trackedLeaseIds) {
			await ensureLeaseSecretsFresh({ leaseId });
		}
	}

	return {
		ensureLeaseSecretsFresh,
		ensureTrackedLeasesFresh,
		forgetLease({ leaseId }) {
			trackedLeaseIds.delete(leaseId);
			appliedLeaseSecrets.delete(leaseId);
		},
		start() {
			if (refreshTimer || Object.keys(options.secretSources).length === 0) {
				return;
			}
			refreshTimer = setInterval(() => {
				void ensureTrackedLeasesFresh();
			}, 60_000);
		},
		stop() {
			if (!refreshTimer) {
				return;
			}
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		},
		async trackLease({ leaseId }) {
			trackedLeaseIds.add(leaseId);
			await ensureLeaseSecretsFresh({ leaseId });
		},
	};
}
```

- [ ] **Step 5: Parse plugin config**

In `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`, import and add:

```ts
import { parseSecretSourceConfig, type SecretSourceConfig } from './secret-source/secret-source-config.js';
```

Extend `ResolvedGondolinPluginConfig`:

```ts
	readonly secretSources: SecretSourceConfig;
	readonly leaseSecretUpdateTokenEnv?: string;
```

Add to the returned config:

```ts
		leaseSecretUpdateTokenEnv: optionalString(config.leaseSecretUpdateTokenEnv),
		secretSources: parseSecretSourceConfig(config.secretSources),
```

When `secretSources` is non-empty, require `leaseSecretUpdateTokenEnv` and a
non-empty env value at plugin startup. This keeps the controller secret update
endpoint protected even though the controller itself is bound to loopback.

- [ ] **Step 6: Wire lease-ready refresh into sandbox backend**

In `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`, extend the factory options:

```ts
		readonly onLeaseReady?: (lease: GondolinLeaseResponse) => Promise<void>;
```

After successful keepalive for a cached entry, call:

```ts
				await options.onLeaseReady?.(cachedEntry.lease);
```

After a new `leaseResponse` is validated and before creating the handle, call:

```ts
		await options.onLeaseReady?.(leaseResponse);
```

- [ ] **Step 7: Create registry in plugin registration**

In `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`, import:

```ts
import { createLeaseClient } from './controller-lease-client.js';
import { createSecretSourceRegistry } from './secret-source/secret-source-registry.js';
```

Create the lease client once after `pluginConfig`:

```ts
		const leaseSecretUpdateToken = resolveLeaseSecretUpdateToken(pluginConfig);
		const leaseClient = createLeaseClient({
			controllerUrl: pluginConfig.controllerUrl,
			leaseSecretUpdateToken,
		});
		const secretSourceRegistry = createSecretSourceRegistry({
			leaseClient,
			secretSources: pluginConfig.secretSources,
		});
		secretSourceRegistry.start();
		api.registerRuntimeLifecycle?.({
			id: 'gondolin-secret-source-refresh',
			cleanup: async () => {
				secretSourceRegistry.stop();
			},
		});
```

`resolveLeaseSecretUpdateToken(...)` reads the env var named by
`leaseSecretUpdateTokenEnv`. If `secretSources` is non-empty and the token is
missing, plugin registration must fail fast. If `secretSources` is empty, the
token is optional and no secret refresh loop starts.

Use the same lease client in backend dependencies by adding `createLeaseClient` to `createBackendDeps(...)` dependencies when available, or pass it in the factory dependency override:

```ts
			const backendDependencies = {
				...createBackendDeps(sshHelpers),
				createLeaseClient: () => leaseClient,
			};
```

Pass `onLeaseReady` to the backend factory:

```ts
				factory: createGondolinSandboxBackendFactory(
					{
						...pluginConfig,
						onLeaseReady: async (lease) => {
							await secretSourceRegistry.trackLease({
								leaseId: lease.leaseId,
							});
						},
					},
					backendDependencies,
				),
```

- [ ] **Step 8: Update plugin manifest config schema**

In `packages/openclaw-agent-vm-plugin/openclaw.plugin.json`, add `secretSources` under `properties`:

```json
			"leaseSecretUpdateTokenEnv": {
				"type": "string",
				"minLength": 1
			},
			"secretSources": {
				"type": "object",
				"additionalProperties": {
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"kind": { "const": "google-oauth-refresh" },
						"clientIdEnv": { "type": "string", "minLength": 1 },
						"clientSecretEnv": { "type": "string", "minLength": 1 },
						"refreshTokenEnv": { "type": "string", "minLength": 1 },
						"hosts": {
							"type": "array",
							"items": { "type": "string", "minLength": 1 },
							"minItems": 1
						},
						"scopes": {
							"type": "array",
							"items": { "type": "string", "minLength": 1 }
						},
						"refreshSkewMs": { "type": "integer", "minimum": 1 },
						"tokenEndpoint": { "type": "string", "minLength": 1 }
					},
					"required": ["kind", "clientIdEnv", "clientSecretEnv", "refreshTokenEnv", "hosts"]
				}
			}
```

- [ ] **Step 9: Run focused tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/secret-source/secret-source-registry.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 6**

Run:

```bash
git add packages/openclaw-agent-vm-plugin/src packages/openclaw-agent-vm-plugin/openclaw.plugin.json
git commit -m "feat: add gondolin secret source registry

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Document The Security Boundary

**Files:**
- Modify: `docs/subsystems/secrets-and-credentials.md`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Add subsystem documentation**

Add this section to `docs/subsystems/secrets-and-credentials.md`:

```md
## Gondolin Secret Source For Tool VMs

`gondolin-secret-source` is the gateway-side producer for Tool VM mediated
secrets.

The boundary is:

1. The gateway/plugin owns real credentials, OAuth refresh tokens, and provider
   client secrets.
2. The Tool VM receives only Gondolin placeholder env vars.
3. The Tool VM CLI sends placeholders in HTTP headers such as
   `Authorization: Bearer $GOOGLE_CALENDAR_ACCESS_TOKEN`.
4. Gondolin replaces placeholders at the network layer when the destination
   host matches the secret's host allowlist.
5. The plugin can rotate the real value for a live lease through
   `POST /lease/:leaseId/secrets/:secretName`.
6. That controller route requires the gateway-held
   `x-agent-vm-lease-secret-token`; loopback binding is not the security
   boundary.
7. Long-lived leases are tracked and refreshed before token expiry. A missing
   lease response removes that lease from the refresh set.

This is not an approval system. OpenClaw exec approvals and plugin
`before_tool_call` approvals decide whether a tool action should run.
`gondolin-secret-source` only decides which real secret value a placeholder
maps to at the HTTP mediation layer.

Non-root Tool VM support is a separate compatibility layer. `guestOwner` makes
RealFS mounts look owned by the configured guest uid/gid so normal shell tools
can write `/work`; it must not be treated as the authorization boundary for
privileged host paths.
```

- [ ] **Step 2: Add generated manual text**

In `packages/agent-vm/src/cli/manual-templates.ts`, add text to the Tool VM access section:

```ts
Tool VM mediated secrets use zones[].toolVmAccess. Keep gateway VM secrets and
Tool VM secrets separate: gateway zone secrets configure OpenClaw/provider
egress, while toolVmAccess configures outbound HTTP from leased Tool VMs.

For rotating OAuth tokens, configure the OpenClaw gondolin plugin's
secretSources block. The plugin refreshes the token in the gateway process and
updates the active Tool VM lease through the controller; the Tool VM only sees
the stable Gondolin placeholder env var.
```

Update `packages/agent-vm/src/cli/manual-templates.test.ts` with assertions:

```ts
expect(manual).toContain('zones[].toolVmAccess');
expect(manual).toContain('secretSources');
expect(manual).toContain('stable Gondolin placeholder env var');
```

- [ ] **Step 3: Regenerate docs**

Run:

```bash
pnpm --filter @agent-vm/agent-vm build
pnpm agent-vm manual update
```

Expected: generated docs include `zones[].toolVmAccess` and `secretSources`.
The package build must run first because the `agent-vm` binary executes
`packages/agent-vm/dist/cli/agent-vm-entrypoint.js`.

- [ ] **Step 4: Commit Task 7**

Run:

```bash
git add docs packages/agent-vm/src/cli/manual-templates.ts packages/agent-vm/src/cli/manual-templates.test.ts
git commit -m "docs: explain gondolin secret sources

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 8: Full Verification

**Files:**
- No source edits.

- [ ] **Step 1: Run unit tests**

Run:

```bash
pnpm test:unit
```

Expected: PASS, all Vitest unit tests pass with exit code 0.

- [ ] **Step 2: Run checks**

Run:

```bash
pnpm check
```

Expected: PASS, package version sync, Zod check, type-aware lint, format check, and typecheck all pass with exit code 0.

- [ ] **Step 3: Run integration test focused on HTTP mediation**

Run:

```bash
pnpm vitest run --config vitest.integration.config.ts packages/agent-vm/src/integration-tests/live-http-mediation.integration.test.ts
```

Expected: PASS. If the environment cannot boot Gondolin, capture the exact missing dependency or permission error in the PR notes instead of claiming integration success.

- [ ] **Step 4: Final commit if verification fixes were needed**

If verification required code or docs changes, commit them:

```bash
git add .
git commit -m "fix: stabilize gondolin secret source verification

Co-authored-by: Codex <noreply@openai.com>"
```

If no changes were required, do not create an empty commit.

---

## Security Notes

- No endpoint returns raw secret values.
- `POST /lease/:leaseId/secrets/:secretName` accepts raw values only from the trusted gateway/plugin side. Do not expose it as an agent-visible tool.
- Tool VM egress is denied by default until `zones[].toolVmAccess.allowedHosts` is populated.
- Gateway VMs and Tool VMs default to disk-backed `cow` rootfs. Do not reintroduce Tool VM `memory` rootfs as the normal path.
- OAuth refresh tokens, client secrets, and provider keys stay in the gateway/plugin environment or host secret resolver.
- OpenClaw approval remains separate. Use OpenClaw `tools.allow`, exec approvals, and `before_tool_call` hooks for read/write/action policy.

## Self-Review

- Spec coverage: naming decision, disk-backed rootfs defaults, non-root Tool VM execution, Tool VM mediation, runtime secret rotation, Google OAuth producer, controller route, plugin integration, and docs are all mapped to tasks.
- Placeholder scan: no `TODO`, `TBD`, or "implement later" placeholders are used.
- Type consistency: `toolVmAccess`, `SecretSourceConfig`, `updateLeaseSecret`, `ensureLeaseSecretsFresh`, `listMediatedSecrets`, `updateMediatedSecret`, and `deleteMediatedSecret` use the same names across tasks.
