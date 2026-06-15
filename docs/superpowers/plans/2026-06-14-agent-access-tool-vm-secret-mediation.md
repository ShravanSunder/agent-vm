# Agent Access Tool VM Secret Mediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add required inline `agentAccess` to Tool VM-reachable mediated zone secrets, and use it to prevent unauthorized OpenClaw Tool VM secret placeholders and raw host-side resolution.

**Architecture:** `zones[].secrets` remains the single authored secret catalog. Zod schema variants make `agentAccess` required for `http-mediation` secrets whose `audience` is `tool-vm` or `both`; runtime then threads trusted lease `agentId` into Tool VM creation and filters selected secret names before `SecretResolver.resolveAll`. Doctor, validate, repo docs, manual templates, and JSON schema artifacts all expose the new contract.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm, Gondolin Tool VM HTTP mediation, agent-vm CLI validate/doctor/manual surfaces.

---

## Source Coverage

- Spec read completely: `docs/superpowers/specs/2026-06-14-per-agent-tool-vm-secret-mediation.md`, 298 lines before cleanup, lines 1-298 read.
- Live code evidence inspected before planning:
  - `packages/agent-vm/src/config/system-config.ts` schema and cross-zone validation.
  - `packages/agent-vm/src/gateway/credential-manager.ts` batch resolution path.
  - `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts` Tool VM secret resolution path.
  - `packages/agent-vm/src/controller/controller-runtime.ts`, `controller-runtime-types.ts`, `leases/lease-manager.ts`, and `zone-runtimes/zone-runtime-types.ts` agent identity handoff.
  - `packages/agent-vm/src/operations/doctor.ts` and `config-validation.ts` OpenClaw setup checks.
  - Existing unit/integration/e2e test files named in the spec.

## Requirements And Proof Matrix

| Requirement | Owning Task | Proof owner: | Proof gate | Layer | Stale-proof guard: | Red/green |
| --- | --- | --- | --- | --- | --- | --- |
| Tool VM-reachable mediated secrets require inline `agentAccess` with no omitted default. | 1 | implementation executor | `pnpm vitest run packages/agent-vm/src/config/system-config.unit.test.ts` | unit | Re-read current Zod schema and JSON schema artifact after edits. | Required |
| `agentAccess` accepts exactly `"all"` or a non-empty array of declared OpenClaw agent ids. | 1 | implementation executor | `pnpm vitest run packages/agent-vm/src/config/system-config.unit.test.ts` | unit | Test both `createLoadedSystemConfig` and artifact shape, not only type inference. | Required |
| Worker zones reject Tool VM-reachable `agentAccess`; gateway-only mediated secrets reject `agentAccess`. | 1 | implementation executor | `pnpm vitest run packages/agent-vm/src/config/system-config.unit.test.ts` | unit | Include worker-zone and gateway-only negative cases. | Required |
| Unauthorized agent-scoped secrets are filtered before host-side secret resolution. | 2, 4 | implementation executor | `pnpm vitest run packages/agent-vm/src/gateway/credential-manager.unit.test.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.unit.test.ts` | unit | Assert `resolveAll` input, not only VM `secrets` output. | Required |
| Trusted `leaseOptions.agentId` reaches `createToolVm`. | 3 | implementation executor | `pnpm vitest run packages/agent-vm/src/controller/controller-runtime.unit.test.ts` | unit | Assert dependency call arguments from a lease request. | Required |
| Tool VM receives `"all"` secrets and only matching scoped secrets; bootstrap contains placeholders, not raw values. | 4 | implementation executor | `pnpm vitest run packages/agent-vm/src/tool-vm/tool-vm-lifecycle.unit.test.ts` | unit | Keep existing reserved env-name test passing with new required field. | Required |
| `agent-vm validate` reports actionable config failures and accepts valid `agentAccess` configs. | 5 | implementation executor | `pnpm vitest run packages/agent-vm/src/operations/config-validation.integration.test.ts` | integration | Exercise fixture config through existing validation command path. | Required |
| `agent-vm doctor` includes OpenClaw agent secret access checks. | 5 | implementation executor | `pnpm vitest run packages/agent-vm/src/operations/doctor.unit.test.ts` | unit | Assert named checks and hints for `"all"` and per-agent access. | Required |
| Deployment docs and generated manuals teach the new inline config shape. | 6 | implementation executor | `pnpm vitest run packages/agent-vm/src/cli/manual-templates.unit.test.ts` and `git diff --check` | docs/unit | Update canonical docs before generated manual copy. | Required |
| Live mediation still works and scoped secrets do not reach another agent in a production-shaped VM path. | 7 | implementation executor | `mise exec -- pnpm test:e2e:vm-mediation` | e2e | Use the live VM mediation project, not a fake integration test. | Required unless the environment lacks VM prerequisites; then record exact blocker. |
| Full repo quality remains green for the changed surfaces. | 7 | implementation executor | `pnpm check` | quality | Run after targeted tests and docs updates. | Required |

## File Structure

- Modify `packages/agent-vm/src/config/system-config.ts`: add `agentAccessSchema`; split mediated secret schemas into gateway-only and Tool VM-reachable variants; add cross-object membership and worker-zone validation.
- Modify `packages/agent-vm/src/config/system-config.unit.test.ts`: add positive and negative schema tests; update existing Tool VM-mediated fixtures to include `agentAccess`; assert JSON schema artifact exposes the field.
- Modify `packages/agent-vm/src/gateway/credential-manager.ts`: add optional `secretNames` filtering on Tool VM resolution so filtering happens before `resolveAll`.
- Modify `packages/agent-vm/src/gateway/credential-manager.unit.test.ts`: assert name filtering excludes unauthorized refs from `resolveAll`.
- Create `packages/agent-vm/src/tool-vm/tool-vm-secret-selection.ts`: pure helper for deciding whether a Tool VM-mediated secret targets an agent and returning the selected name set.
- Create `packages/agent-vm/src/tool-vm/tool-vm-secret-selection.unit.test.ts`: fast unit coverage for `"all"`, per-agent lists, non-Tool-VM audiences, and defensive missing `agentAccess`.
- Modify `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`: require `agentId` in `createToolVm` options and pass selected names to `resolveZoneSecrets`.
- Modify `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.unit.test.ts`: add agents to fixtures, pass `agentId`, and prove selection/resolution/bootstrap behavior.
- Modify `packages/agent-vm/src/controller/controller-runtime-types.ts`, `packages/agent-vm/src/controller/controller-runtime.ts`, and `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts`: include `agentId` in Tool VM dependency types and forwarding.
- Modify `packages/agent-vm/src/controller/controller-runtime.unit.test.ts`: add a lease request test that proves `agentId` reaches `createManagedToolVm`.
- Modify `packages/agent-vm/src/operations/doctor.ts` and `packages/agent-vm/src/operations/doctor.unit.test.ts`: add OpenClaw agent secret access checks.
- Modify `packages/agent-vm/src/operations/config-validation.ts` and `packages/agent-vm/src/operations/config-validation.integration.test.ts`: surface agent secret access in validate checks and fixture coverage.
- Modify `docs/reference/configuration/system-json.md`, `docs/subsystems/secrets-and-credentials.md`, `docs/reference/validate-and-doctor.md`, `packages/agent-vm/src/cli/manual-templates.ts`, and `packages/agent-vm/src/cli/manual-templates.unit.test.ts`: document required inline `agentAccess`.
- Modify or add a live mediation test under `packages/agent-vm/src/integration-tests/` if the current `vm-mediation` suite lacks two-agent scoped proof.

## Task 1: Schema Contract And Config Tests

**Files:**
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `packages/agent-vm/src/config/system-config.unit.test.ts`

- [ ] **Step 1: Add failing schema tests for accepted Tool VM agent access**

Add tests near the existing secret audience validation block:

```ts
test('accepts all-agent access on Tool VM mediated secrets', () => {
	const config = createValidSystemConfigInput();
	config.zones[0].secrets.GITHUB_TOKEN = {
		source: '1password',
		ref: 'op://agent-vm/example-sun-github/credential',
		injection: 'http-mediation',
		audience: 'tool-vm',
		hosts: ['api.github.com'],
		agentAccess: 'all',
	};
	config.zones[0].egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
	config.host.secretsProvider = { type: '1password', tokenSource: { type: 'env' } };

	expect(parseSystemConfigInputForTest(config).zones[0].secrets.GITHUB_TOKEN).toMatchObject({
		agentAccess: 'all',
	});
});

test('accepts per-agent access on Tool VM mediated secrets', () => {
	const config = createValidSystemConfigInput();
	config.zones[0].agents = [{ id: 'sun' }, { id: 'mak' }];
	config.zones[0].secrets.GITHUB_TOKEN = {
		source: '1password',
		ref: 'op://agent-vm/example-sun-github/credential',
		injection: 'http-mediation',
		audience: 'tool-vm',
		hosts: ['api.github.com'],
		agentAccess: ['sun'],
	};
	config.zones[0].egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
	config.host.secretsProvider = { type: '1password', tokenSource: { type: 'env' } };

	expect(parseSystemConfigInputForTest(config).zones[0].secrets.GITHUB_TOKEN).toMatchObject({
		agentAccess: ['sun'],
	});
});
```

Run: `pnpm vitest run packages/agent-vm/src/config/system-config.unit.test.ts --testNamePattern "agent access|Tool VM mediated"`

Expected: FAIL because `agentAccess` is currently an unrecognized key.

- [ ] **Step 2: Add failing schema tests for rejected shapes**

Add negative tests for missing `agentAccess`, empty arrays, unknown agent ids, worker zones, and gateway-only audience:

```ts
test('rejects Tool VM mediated secrets without agentAccess', () => {
	const config = createValidSystemConfigInput();
	config.zones[0].secrets.GITHUB_TOKEN = {
		source: '1password',
		ref: 'op://agent-vm/example-sun-github/credential',
		injection: 'http-mediation',
		audience: 'tool-vm',
		hosts: ['api.github.com'],
	};
	config.zones[0].egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
	config.host.secretsProvider = { type: '1password', tokenSource: { type: 'env' } };

	expect(() => parseSystemConfigInputForTest(config)).toThrow(/agentAccess/u);
});

test('rejects per-agent secret access for unknown agents', () => {
	const config = createValidSystemConfigInput();
	config.zones[0].agents = [{ id: 'sun' }];
	config.zones[0].secrets.GITHUB_TOKEN = {
		source: '1password',
		ref: 'op://agent-vm/example-sun-github/credential',
		injection: 'http-mediation',
		audience: 'tool-vm',
		hosts: ['api.github.com'],
		agentAccess: ['ember'],
	};
	config.zones[0].egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
	config.host.secretsProvider = { type: '1password', tokenSource: { type: 'env' } };

	expect(() => parseSystemConfigInputForTest(config)).toThrow(
		/secret 'GITHUB_TOKEN' agentAccess references unknown agent 'ember'/u,
	);
});
```

Run: `pnpm vitest run packages/agent-vm/src/config/system-config.unit.test.ts --testNamePattern "agentAccess|agent access"`

Expected: FAIL until schema and `superRefine` are updated.

- [ ] **Step 3: Implement schema variants**

In `system-config.ts`, add:

```ts
const agentAccessSchema = z.union([z.literal('all'), z.array(agentIdSchema).min(1)]);
const toolVmReachableAudienceSchema = z.enum(['tool-vm', 'both']);
```

Replace each current mediated schema with gateway-only and Tool VM-reachable variants. For 1Password:

```ts
const onePasswordGatewayMediatedSecretSchema = z
	.object({
		source: z.literal('1password'),
		ref: z.string().min(1),
		injection: z.literal('http-mediation'),
		audience: z.literal('gateway'),
		hosts: z.array(z.string().min(1)).min(1),
	})
	.strict();

const onePasswordToolVmMediatedSecretSchema = z
	.object({
		source: z.literal('1password'),
		ref: z.string().min(1),
		injection: z.literal('http-mediation'),
		audience: toolVmReachableAudienceSchema,
		hosts: z.array(z.string().min(1)).min(1),
		agentAccess: agentAccessSchema,
	})
	.strict();
```

Repeat the same split for `environment` and `config` mediated secrets. Build `secretReferenceSchema` from env schemas plus all six mediated variants.

- [ ] **Step 4: Implement cross-object validation**

Inside the existing per-zone loop in `superRefine`, add this after `const zoneAgents = zone.agents ?? []` is available, or move `zoneAgents` before secret validation:

```ts
const zoneAgentIds = new Set(zoneAgents.map((agent) => agent.id));
for (const [secretName, secret] of Object.entries(zone.secrets)) {
	if (
		secret.injection !== 'http-mediation' ||
		!targetsAudience(secret.audience, 'tool-vm') ||
		!('agentAccess' in secret)
	) {
		continue;
	}
	if (zone.gateway.type !== 'openclaw') {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: `Worker zone '${zone.id}' secret '${secretName}' must not declare agentAccess because worker zones do not boot OpenClaw Tool VMs.`,
			path: ['zones', zoneIndex, 'secrets', secretName, 'agentAccess'],
		});
		continue;
	}
	if (Array.isArray(secret.agentAccess)) {
		for (const [agentAccessIndex, agentId] of secret.agentAccess.entries()) {
			if (zoneAgentIds.has(agentId)) {
				continue;
			}
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Zone '${zone.id}' secret '${secretName}' agentAccess references unknown agent '${agentId}'.`,
				path: ['zones', zoneIndex, 'secrets', secretName, 'agentAccess', agentAccessIndex],
			});
		}
	}
}
```

Keep the existing mediated host validation unchanged.

- [ ] **Step 5: Update existing valid fixtures**

Search for Tool VM or `both` mediated secrets:

```bash
rg -n 'audience: .*(tool-vm|both)|"audience": "(tool-vm|both)"' packages/agent-vm/src/config packages/agent-vm/src -g '*.ts'
```

For tests that should remain valid, add `agentAccess: 'all'` or `agentAccess: ['sun']` and define `agents` when using a list.

- [ ] **Step 6: Add JSON schema artifact assertion**

Extend the existing `createSystemConfigSchemaArtifact` unit test:

```ts
const schemaMarkdown = createSystemConfigSchemaArtifact();
expect(schemaMarkdown).toContain('"agentAccess"');
expect(schemaMarkdown).toContain('"all"');
expect(schemaMarkdown).toContain('"tool-vm"');
```

Run: `pnpm vitest run packages/agent-vm/src/config/system-config.unit.test.ts`

Expected: PASS.

## Task 2: Pre-Resolution Secret Filtering

**Files:**
- Modify: `packages/agent-vm/src/gateway/credential-manager.ts`
- Modify: `packages/agent-vm/src/gateway/credential-manager.unit.test.ts`

- [ ] **Step 1: Add failing resolver filter test**

Add a test:

```ts
it('filters Tool VM secret names before resolving refs', async () => {
	const baseZone = systemConfig.zones[0];
	if (!baseZone) {
		throw new Error('Expected base test zone');
	}
	const filteredConfig = {
		...systemConfig,
		zones: [
			{
				...baseZone,
				secrets: {
					SHARED_TOKEN: {
						source: 'environment',
						envVar: 'SHARED_TOKEN',
						injection: 'http-mediation',
						audience: 'tool-vm',
						hosts: ['api.example.com'],
						agentAccess: 'all',
					},
					SUN_ONLY_TOKEN: {
						source: 'environment',
						envVar: 'SUN_ONLY_TOKEN',
						injection: 'http-mediation',
						audience: 'tool-vm',
						hosts: ['api.example.com'],
						agentAccess: ['sun'],
					},
				},
				egressHosts: [{ host: 'api.example.com', audience: 'tool-vm' }],
			},
		],
	} satisfies SystemConfig;
	const resolveAll = vi.fn(async () => ({ SHARED_TOKEN: 'shared' }));

	await resolveZoneSecrets({
		audience: 'tool-vm',
		injection: 'http-mediation',
		secretNames: new Set(['SHARED_TOKEN']),
		secretResolver: { resolve: async () => 'unused', resolveAll },
		systemConfig: filteredConfig,
		zoneId: 'shravan',
	});

	expect(resolveAll).toHaveBeenCalledWith({
		SHARED_TOKEN: { source: 'environment', ref: 'SHARED_TOKEN' },
	});
});
```

Run: `pnpm vitest run packages/agent-vm/src/gateway/credential-manager.unit.test.ts --testNamePattern "filters Tool VM secret names"`

Expected: FAIL because `secretNames` is not supported.

- [ ] **Step 2: Add `secretNames` option before `resolveAll`**

In `ResolveZoneSecretsOptions`, add this only to the Tool VM branch:

```ts
readonly secretNames?: ReadonlySet<string>;
```

In the loop, after audience and injection checks but before building `secretRefs`, add:

```ts
if (options.audience === 'tool-vm' && options.secretNames && !options.secretNames.has(secretName)) {
	continue;
}
```

Run: `pnpm vitest run packages/agent-vm/src/gateway/credential-manager.unit.test.ts`

Expected: PASS.

## Task 3: Agent Identity Plumbing

**Files:**
- Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts`
- Modify: `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.unit.test.ts`

- [ ] **Step 1: Add failing controller runtime assertion**

Add or extend a lease test so it captures `createManagedToolVm` call options:

```ts
expect(createManagedToolVm).toHaveBeenCalledWith(
	expect.objectContaining({
		agentId: 'main',
		zoneId: 'shravan',
	}),
);
```

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-runtime.unit.test.ts --testNamePattern "agentId"`

Expected: FAIL until the dependency type and forwarding are updated.

- [ ] **Step 2: Add `agentId` to dependency types**

Add `readonly agentId: string;` to both `createManagedToolVm` option types in `controller-runtime-types.ts` and `zone-runtime-types.ts`.

- [ ] **Step 3: Forward `agentId` in production runtime**

In the default `createManagedToolVm` wrapper, call `createToolVm` with:

```ts
agentId: toolVmOptions.agentId,
```

In the lease manager callback, call `createManagedToolVm` with:

```ts
agentId: leaseOptions.agentId,
```

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-runtime.unit.test.ts`

Expected: PASS.

## Task 4: Tool VM Agent Secret Selection

**Files:**
- Create: `packages/agent-vm/src/tool-vm/tool-vm-secret-selection.ts`
- Create: `packages/agent-vm/src/tool-vm/tool-vm-secret-selection.unit.test.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.unit.test.ts`

- [ ] **Step 1: Write pure helper tests**

Create tests:

```ts
it('selects all-agent and matching scoped Tool VM mediated secrets', () => {
	const selected = selectToolVmMediatedSecretNamesForAgent({
		agentId: 'sun',
		zone: createZoneWithSecrets({
			SHARED_TOKEN: toolSecret({ agentAccess: 'all' }),
			SUN_TOKEN: toolSecret({ agentAccess: ['sun'] }),
			MAK_TOKEN: toolSecret({ agentAccess: ['mak'] }),
			GATEWAY_TOKEN: gatewaySecret(),
		}),
	});

	expect([...selected].sort()).toEqual(['SHARED_TOKEN', 'SUN_TOKEN']);
});
```

Run: `pnpm vitest run packages/agent-vm/src/tool-vm/tool-vm-secret-selection.unit.test.ts`

Expected: FAIL because the file does not exist.

- [ ] **Step 2: Implement helper**

Use this shape:

```ts
import { targetsAudience } from '@agent-vm/gateway-interface';

import type { SystemConfig } from '../config/system-config.js';

type ZoneConfig = SystemConfig['zones'][number];
type ZoneSecretConfig = ZoneConfig['secrets'][string];

export function secretTargetsToolVmAgent(options: {
	readonly agentId: string;
	readonly secret: ZoneSecretConfig;
	readonly secretName: string;
	readonly zoneId: string;
}): boolean {
	const { agentId, secret, secretName, zoneId } = options;
	if (secret.injection !== 'http-mediation' || !targetsAudience(secret.audience, 'tool-vm')) {
		return false;
	}
	if (!('agentAccess' in secret)) {
		throw new Error(
			`Tool VM mediated secret '${secretName}' in zone '${zoneId}' is missing required agentAccess.`,
		);
	}
	if (secret.agentAccess === 'all') {
		return true;
	}
	return secret.agentAccess.includes(agentId);
}

export function selectToolVmMediatedSecretNamesForAgent(options: {
	readonly agentId: string;
	readonly zone: ZoneConfig;
}): ReadonlySet<string> {
	const selectedNames = new Set<string>();
	for (const [secretName, secret] of Object.entries(options.zone.secrets)) {
		if (
			secretTargetsToolVmAgent({
				agentId: options.agentId,
				secret,
				secretName,
				zoneId: options.zone.id,
			})
		) {
			selectedNames.add(secretName);
		}
	}
	return selectedNames;
}
```

Run: `pnpm vitest run packages/agent-vm/src/tool-vm/tool-vm-secret-selection.unit.test.ts`

Expected: PASS.

- [ ] **Step 3: Thread selection into Tool VM lifecycle**

Add `readonly agentId: string;` to `createToolVm` options. Before `resolveZoneSecrets`, compute:

```ts
const toolVmSecretNames = selectToolVmMediatedSecretNamesForAgent({
	agentId: options.agentId,
	zone,
});
```

Call:

```ts
const resolvedSecrets = await resolveZoneSecrets({
	audience: 'tool-vm',
	injection: 'http-mediation',
	secretNames: toolVmSecretNames,
	secretResolver: options.secretResolver,
	systemConfig: options.systemConfig,
	zoneId: options.zoneId,
});
```

- [ ] **Step 4: Update lifecycle tests**

Add `agents: [{ id: 'sun' }, { id: 'mak' }, { id: 'ember' }]` to `createToolVmSystemConfig()` and add `agentId: 'sun'` to every `createToolVm` call.

In the mediated secret test, configure:

```ts
SHARED_TOKEN: {
	source: 'environment',
	envVar: 'SHARED_TOKEN',
	injection: 'http-mediation',
	audience: 'tool-vm',
	hosts: ['api.example.com'],
	agentAccess: 'all',
},
SUN_TOKEN: {
	source: 'environment',
	envVar: 'SUN_TOKEN',
	injection: 'http-mediation',
	audience: 'tool-vm',
	hosts: ['api.github.com'],
	agentAccess: ['sun'],
},
MAK_TOKEN: {
	source: 'environment',
	envVar: 'MAK_TOKEN',
	injection: 'http-mediation',
	audience: 'tool-vm',
	hosts: ['api.github.com'],
	agentAccess: ['mak'],
},
```

Assert:

```ts
expect(createManagedVm).toHaveBeenCalledWith(
	expect.objectContaining({
		secrets: {
			SHARED_TOKEN: { hosts: ['api.example.com'], value: 'shared-token' },
			SUN_TOKEN: { hosts: ['api.github.com'], value: 'sun-token' },
		},
	}),
);
expect(secretResolver.resolveAll).toHaveBeenCalledWith({
	SHARED_TOKEN: { source: 'environment', ref: 'SHARED_TOKEN' },
	SUN_TOKEN: { source: 'environment', ref: 'SUN_TOKEN' },
});
```

Run: `pnpm vitest run packages/agent-vm/src/tool-vm/tool-vm-secret-selection.unit.test.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.unit.test.ts`

Expected: PASS.

## Task 5: Validate And Doctor Surfaces

**Files:**
- Modify: `packages/agent-vm/src/operations/config-validation.ts`
- Modify: `packages/agent-vm/src/operations/config-validation.integration.test.ts`
- Modify: `packages/agent-vm/src/operations/doctor.ts`
- Modify: `packages/agent-vm/src/operations/doctor.unit.test.ts`

- [ ] **Step 1: Add doctor check helper**

Create a shared local helper shape in both validate and doctor files, following existing check style:

```ts
function formatAgentAccessHint(agentAccess: 'all' | readonly string[]): string {
	return agentAccess === 'all' ? 'all declared agents' : agentAccess.join(', ');
}
```

For each OpenClaw zone secret with `injection: 'http-mediation'` and Tool VM audience, emit:

```ts
{
	name: `zone-agent-secret-access-${zone.id}-${secretName}`,
	ok: true,
	hint: formatAgentAccessHint(secret.agentAccess),
} satisfies DoctorCheck
```

Use the existing validation load step to catch invalid configs before check collection.

- [ ] **Step 2: Add tests for doctor output**

In `doctor.unit.test.ts`, add a secret:

```ts
GITHUB_TOKEN: {
	source: 'environment',
	envVar: 'GITHUB_TOKEN',
	injection: 'http-mediation',
	audience: 'tool-vm',
	hosts: ['api.github.com'],
	agentAccess: ['shravan'],
},
```

Assert:

```ts
expect(result.checks).toContainEqual(
	expect.objectContaining({
		name: 'zone-agent-secret-access-shravan-GITHUB_TOKEN',
		ok: true,
		hint: 'shravan',
	}),
);
```

Run: `pnpm vitest run packages/agent-vm/src/operations/doctor.unit.test.ts --testNamePattern "agent secret access"`

Expected: FAIL before helper, PASS after helper.

- [ ] **Step 3: Add config-validation integration coverage**

Extend `writeOpenClawProjectFixture` with `agents: [{ id: 'shravan' }]` if absent in `system.json`, and add two tests:

```ts
it('accepts Tool VM mediated secrets with agentAccess', async () => {
	const configPath = await writeOpenClawProjectFixture(rootPath);
	await updateJsonFile(configPath, (config) => {
		const zone = (config.zones as Record<string, unknown>[])[0];
		const secrets = zone.secrets as Record<string, unknown>;
		secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.github.com'],
			agentAccess: ['shravan'],
		};
		zone.egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
	});

	const result = await runConfigValidation({ configPath, runCommand: successfulOpenClawValidationCommand });
	expect(result.ok).toBe(true);
});
```

Add the missing-`agentAccess` counterpart and assert `result.ok` is false or `loadSystemConfig` rejects with `agentAccess`.

Run: `pnpm vitest run packages/agent-vm/src/operations/config-validation.integration.test.ts`

Expected: PASS.

## Task 6: Docs, Manuals, And Schema Surfaces

**Files:**
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/subsystems/secrets-and-credentials.md`
- Modify: `docs/reference/validate-and-doctor.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.unit.test.ts`

- [ ] **Step 1: Update canonical docs**

In `system-json.md` under secrets, add this exact contract:

```md
For `http-mediation` secrets with `audience: "tool-vm"` or `"both"`, `agentAccess` is required. Use `"all"` to make the mediated placeholder available to every OpenClaw agent in the zone, or a non-empty array such as `["sun"]` to scope delivery to declared `zones[].agents[].id` values.
```

In `secrets-and-credentials.md`, update the boundary table row for Tool VM mediated secrets to say placeholder delivery is filtered by `agentAccess`.

In `validate-and-doctor.md`, mention that validate rejects missing/unknown `agentAccess` and doctor reports configured OpenClaw agent secret access.

- [ ] **Step 2: Update manual templates**

Search:

```bash
rg -n "http-mediation|Tool VM|secrets|agentToolVmProfiles" packages/agent-vm/src/cli/manual-templates.ts
```

Add the same short operational rule near the existing secret guidance. Include this sample:

```json
"GITHUB_TOKEN": {
  "source": "1password",
  "ref": "op://agent-vm/example-sun-github/credential",
  "injection": "http-mediation",
  "audience": "tool-vm",
  "hosts": ["api.github.com", "github.com"],
  "agentAccess": ["sun"]
}
```

- [ ] **Step 3: Update manual template tests**

In `manual-templates.unit.test.ts`, assert generated output includes:

```ts
expect(output).toContain('"agentAccess": ["sun"]');
expect(output).toContain('Tool VM');
```

Run: `pnpm vitest run packages/agent-vm/src/cli/manual-templates.unit.test.ts`

Expected: PASS.

## Task 7: Live Proof And Full Gates

**Files:**
- Modify or create: `packages/agent-vm/src/integration-tests/*vm-mediation*.vm.e2e.test.ts`
- No product changes unless a required proof exposes a scoped bug.

- [ ] **Step 1: Add live scoped mediation proof if missing**

Search current live tests:

```bash
rg -n "agentAccess|GITHUB_TOKEN|http-mediation|Tool VM" packages/agent-vm/src/integration-tests -g '*.vm.e2e.test.ts'
```

If there is no two-agent scoped proof, add one to the VM mediation project. The test must configure two Tool VM-mediated secrets:

```ts
SUN_ONLY_TOKEN: { audience: 'tool-vm', injection: 'http-mediation', hosts: ['auth.sun.test'], agentAccess: ['sun'] }
MAK_ONLY_TOKEN: { audience: 'tool-vm', injection: 'http-mediation', hosts: ['auth.mak.test'], agentAccess: ['mak'] }
```

The proof must assert Sun's Tool VM does not receive or resolve Mak's secret. If the current live harness cannot create two OpenClaw Tool VM leases in the VM-mediation lane, stop and replan the smallest harness extension instead of faking this at integration level.

- [ ] **Step 2: Run targeted test set**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.unit.test.ts
pnpm vitest run packages/agent-vm/src/gateway/credential-manager.unit.test.ts
pnpm vitest run packages/agent-vm/src/tool-vm/tool-vm-secret-selection.unit.test.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.unit.test.ts
pnpm vitest run packages/agent-vm/src/controller/controller-runtime.unit.test.ts
pnpm vitest run packages/agent-vm/src/operations/doctor.unit.test.ts packages/agent-vm/src/operations/config-validation.integration.test.ts
pnpm vitest run packages/agent-vm/src/cli/manual-templates.unit.test.ts
```

Expected: all targeted tests PASS.

- [ ] **Step 3: Run quality and live gates**

Run:

```bash
pnpm check
mise exec -- pnpm test:e2e:vm-mediation
git diff --check
```

Expected: all required gates PASS. If the live VM gate cannot run because Docker, QEMU, or pinned Zig is unavailable, record the exact failing prerequisite and keep the goal incomplete unless the user approves deferring that layer.

## Replan Triggers

- Zod JSON schema generation cannot represent the split mediated secret variants cleanly enough for deployment validation. Replan only the schema artifact strategy, not the runtime policy.
- TypeScript rejects passing `SystemConfig['zones'][number]['secrets']` to gateway lifecycle because of the new field. Prefer stripping `agentAccess` in `mapSystemGatewayZoneToLifecycleZone` over teaching gateway runtimes to use it.
- The live VM mediation harness cannot express two OpenClaw agents without broad harness changes. Stop and split a harness-enablement plan instead of claiming fake integration proof as live proof.

## Rollback And Recovery

- This is a hard cutover: old Tool VM-mediated secrets without `agentAccess` become invalid. Rollback is reverting the schema/runtime/docs changes together.
- Deployment recovery for Sun-only GitHub before release remains: remove shared `zones[].secrets.GITHUB_TOKEN` and keep `host.githubToken` for controller-owned `zone_git_push`.
- No migration shim or hidden default should be added; `"all"` is the explicit opt-in for all declared agents in the zone.
