# OpenClaw Gondolin Agent Scope Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-vm's OpenClaw/Gondolin lease boundary strict and explainable using only data our plugin already receives from OpenClaw today.

**Architecture:** We cannot patch OpenClaw, so the plugin derives `agentId` from the existing `sessionKey` using OpenClaw-equivalent fallback behavior, reads the resolved sandbox settings from `cfg`, and sends those facts to the controller with every `/lease` request. The controller treats the plugin as a trusted but bug-prone caller: it validates cross-field consistency for `agentId`, `sessionKey`, `scopeKey`, `backend="gondolin"`, `mode="all"`, `scope="agent"`, `workspaceAccess="rw"`, and resolved workspace mount paths before creating or reusing a Tool VM lease. `scopeKey` stays the lease reuse key; `agentId` becomes explicit request data for profile/seeding/policy decisions.

**Tech Stack:** TypeScript, pnpm, Vitest, Zod, Hono controller routes, OpenClaw sandbox-backend plugin.

---

## Current Evidence

- OpenClaw already passes the plugin `{ sessionKey, scopeKey, workspaceDir, agentWorkspaceDir, cfg }` in `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/sandbox/context.ts:159-166`.
- OpenClaw's resolved `cfg` includes `backend`, `mode`, `scope`, and `workspaceAccess` in `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/sandbox/config.ts:245-268`.
- OpenClaw does not require every `sessionKey` to be shaped as `agent:<agentId>:...`. `resolveAgentIdFromSessionKey` falls back to `DEFAULT_AGENT_ID = "main"` when parsing fails in `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/routing/session-key.ts:110-113`.
- OpenClaw's `scope="agent"` resolver returns `agent:${resolveAgentIdFromSessionKey(sessionKey)}` in `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/sandbox/shared.ts:24-34`; our plugin must mirror that behavior rather than invent a stricter session-key shape.
- Our plugin currently types `cfg` too narrowly and sends only `{ zoneId, profileId, scopeKey, workMountDir, agentWorkspaceDir }` in `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts:105-158`.
- Current controller schema has no `agentId`, `sessionKey`, or sandbox snapshot in `packages/agent-vm/src/controller/http/controller-request-schemas.ts:6-13`.
- Current controller derives `agentId` from `scopeKey` in `packages/agent-vm/src/controller/http/controller-http-routes.ts:240-255`; this is the part to replace.
- agent-vm already validates OpenClaw startup/static config for `backend`, `mode`, `scope`, and `workspaceAccess`; this plan makes the live lease request prove the same values at the boundary.

## Backward-Incompatible Contract Tightening

- Managed agent-vm/OpenClaw leases now require live sandbox values `backend="gondolin"`, `mode="all"`, `scope="agent"`, and `workspaceAccess="rw"` at `/lease`, not only in startup validation.
- Managed agent-vm/OpenClaw leases now require `scopeKey` to be exactly `agent:<resolvedAgentId>` for `scope="agent"`. Existing test fixtures or callers that pass longer agent scope keys such as `agent:<id>:discord:...` must be updated. OpenClaw supports those raw session keys as `sessionKey`, but for `scope="agent"` its resolved `scopeKey` is the collapsed `agent:<id>` form.
- The plugin mirrors OpenClaw's legacy session-key behavior: a non-agent-shaped `sessionKey` resolves to agent `main`. This avoids rejecting CLI, cron, or legacy callers that OpenClaw itself still supports.
- The controller validates trusted plugin payload consistency. It does not independently authenticate that a caller is allowed to claim an agent id; true authentication would require a separate zone/agent allow-list or token-bound lease API.

## File Structure

- Create `packages/openclaw-agent-vm-plugin/src/openclaw-gondolin-contract.ts`
  - Owns shared constants, sandbox snapshot type, session-key agent-id derivation, and user-facing guidance strings.

- Modify `packages/openclaw-agent-vm-plugin/src/index.ts`
  - Exports the shared contract helpers.

- Modify `packages/openclaw-agent-vm-plugin/src/openclaw-runtime-status.ts`
  - Reuses the shared requirement constants for startup status.

- Modify `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
  - Adds `agentId`, `sessionKey`, and `sandbox` to `requestLease`.
  - Preserves structured controller error responses in thrown error messages.

- Modify `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
  - Widens the plugin-side `cfg` type to include the resolved sandbox contract fields.
  - Derives `agentId` from `sessionKey`.
  - Preflights the contract before calling the controller.
  - Sends richer lease data to the controller.

- Modify `packages/agent-vm/src/controller/http/controller-request-schemas.ts`
  - Extends `/lease` request schema with `agentId`, `sessionKey`, and `sandbox`.

- Modify `packages/agent-vm/src/controller/http/controller-http-routes.ts`
  - Validates the enriched lease contract.
  - Uses `payload.agentId` for profile lookup instead of parsing `scopeKey`.
  - Returns structured, actionable error bodies.

- Modify `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts`
  - Accepts explicit `agentId` instead of parsing it from `scopeKey`.

- Modify tests:
  - `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`
  - `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`
  - `packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts`
  - `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts`
  - `packages/agent-vm/src/controller/http/controller-request-schemas.test.ts`
  - `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
  - `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts`
  - `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`

- Modify docs:
  - `docs/architecture/openclaw-gateway.md`
  - `docs/subsystems/controller.md`
  - `docs/reference/validate-and-doctor.md`
  - `packages/agent-vm/src/cli/manual-templates.ts`
  - `packages/agent-vm/src/cli/manual-templates.test.ts`

---

### Task 1: Add Shared OpenClaw/Gondolin Contract Helpers

**Files:**
- Create: `packages/openclaw-agent-vm-plugin/src/openclaw-gondolin-contract.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/index.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-runtime-status.ts`
- Test: `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts`

- [ ] **Step 1: Create shared contract helper**

Create `packages/openclaw-agent-vm-plugin/src/openclaw-gondolin-contract.ts`:

```ts
const agentIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;

export const OPENCLAW_DEFAULT_AGENT_ID = 'main';

export const OPENCLAW_GONDOLIN_SANDBOX_REQUIREMENTS = [
	{ expectedValue: 'gondolin', key: 'backend' },
	{ expectedValue: 'all', key: 'mode' },
	{ expectedValue: 'agent', key: 'scope' },
	{ expectedValue: 'rw', key: 'workspaceAccess' },
] as const;

export const OPENCLAW_GONDOLIN_LEASE_SCOPE_GUIDANCE =
	'Managed OpenClaw/Gondolin requires agents.*.sandbox.scope="agent"; the lease scopeKey must be agent:<agentId>, not a raw channel, session, or subagent key.';

export type OpenClawGondolinSandboxRequirement =
	(typeof OPENCLAW_GONDOLIN_SANDBOX_REQUIREMENTS)[number];

export type OpenClawGondolinSandboxRequirementKey = OpenClawGondolinSandboxRequirement['key'];

export interface OpenClawGondolinSandboxSnapshot {
	readonly backend?: unknown;
	readonly mode?: unknown;
	readonly scope?: unknown;
	readonly workspaceAccess?: unknown;
}

export interface OpenClawGondolinAgentConfig {
	readonly [key: string]: unknown;
	readonly id?: unknown;
	readonly sandbox?: OpenClawGondolinSandboxSnapshot & Record<string, unknown>;
	readonly workspace?: unknown;
}

export function isOpenClawAgentId(value: string): boolean {
	return agentIdPattern.test(value.trim());
}

export function effectiveOpenClawGondolinSandboxValue(
	defaults: OpenClawGondolinAgentConfig,
	agentConfig: OpenClawGondolinAgentConfig,
	key: OpenClawGondolinSandboxRequirementKey,
): unknown {
	return agentConfig.sandbox?.[key] ?? defaults.sandbox?.[key];
}

export function formatOpenClawGondolinRequirementFieldPath(
	label: string,
	key: OpenClawGondolinSandboxRequirementKey,
): string {
	return `agents.${label}.sandbox.${key}`;
}

export function formatOpenClawGondolinRequirementFindingId(options: {
	readonly fieldPath: string;
	readonly label: string;
	readonly zoneId: string;
}): string {
	return `openclaw-tool-vm-${options.fieldPath.replace(/[.[\]]/gu, '-')}-${options.zoneId}-${options.label}`;
}

export function formatOpenClawGondolinRequirementHint(options: {
	readonly expectedValue: string;
	readonly fieldPath: string;
	readonly ok: boolean;
}): string {
	return options.ok
		? `${options.fieldPath}=${options.expectedValue}`
		: `Set ${options.fieldPath} to "${options.expectedValue}" for OpenClaw Tool VM mediation.`;
}

export function normalizeOpenClawAgentId(value: string | undefined | null): string {
	const trimmed = (value ?? '').trim().toLowerCase();
	return isOpenClawAgentId(trimmed) ? trimmed : OPENCLAW_DEFAULT_AGENT_ID;
}

export function resolveOpenClawAgentIdFromSessionKey(sessionKey: string): string {
	const parts = sessionKey.trim().split(':');
	if (parts[0] !== 'agent' || !parts[1]) {
		return OPENCLAW_DEFAULT_AGENT_ID;
	}
	return normalizeOpenClawAgentId(parts[1]);
}

export function expectedOpenClawGondolinScopeKey(agentId: string): string {
	return `agent:${agentId}`;
}

export function snapshotOpenClawGondolinSandboxConfig(cfg: OpenClawGondolinSandboxSnapshot): {
	readonly backend: unknown;
	readonly mode: unknown;
	readonly scope: unknown;
	readonly workspaceAccess: unknown;
} {
	return {
		backend: cfg.backend,
		mode: cfg.mode,
		scope: cfg.scope,
		workspaceAccess: cfg.workspaceAccess,
	};
}

export function findOpenClawGondolinSandboxMismatch(
	sandbox: OpenClawGondolinSandboxSnapshot,
): OpenClawGondolinSandboxRequirement | undefined {
	return OPENCLAW_GONDOLIN_SANDBOX_REQUIREMENTS.find(
		(requirement) => sandbox[requirement.key] !== requirement.expectedValue,
	);
}
```

- [ ] **Step 2: Export helper**

Modify `packages/openclaw-agent-vm-plugin/src/index.ts`:

```ts
export * from './sandbox-backend-factory.js';
export * from './gondolin-plugin-config.js';
export * from './controller-lease-client.js';
export * from './openclaw-plugin-registration.js';
export * from './openclaw-gondolin-contract.js';
export { default } from './openclaw-plugin-registration.js';

export const OPENCLAW_GONDOLIN_PLUGIN_PACKAGE_NAME = '@agent-vm/openclaw-agent-vm-plugin';
```

- [ ] **Step 3: Reuse requirement constants in runtime status**

Modify `packages/openclaw-agent-vm-plugin/src/openclaw-runtime-status.ts`.

Add import:

```ts
import {
	effectiveOpenClawGondolinSandboxValue,
	formatOpenClawGondolinRequirementFieldPath,
	formatOpenClawGondolinRequirementFindingId,
	formatOpenClawGondolinRequirementHint,
	OPENCLAW_GONDOLIN_SANDBOX_REQUIREMENTS,
	type OpenClawGondolinAgentConfig,
} from './openclaw-gondolin-contract.js';
```

Use the shared agent config type:

```ts
interface OpenClawRuntimeConfig {
	readonly [key: string]: unknown;
	readonly agents?: {
		readonly defaults?: OpenClawGondolinAgentConfig;
		readonly list?: readonly unknown[];
	};
}
```

Replace the local requirement finding implementation with:

```ts
function requirementFinding(options: {
	readonly actualValue: unknown;
	readonly expectedValue: string;
	readonly fieldPath: string;
	readonly label: string;
	readonly zoneId: string;
}): OpenClawRuntimeRequirementFinding {
	const ok = options.actualValue === options.expectedValue;
	return {
		id: formatOpenClawGondolinRequirementFindingId({
			fieldPath: options.fieldPath,
			label: options.label,
			zoneId: options.zoneId,
		}),
		ok,
		hint: formatOpenClawGondolinRequirementHint({
			expectedValue: options.expectedValue,
			fieldPath: options.fieldPath,
			ok,
		}),
	};
}
```

Replace the four hard-coded sandbox findings with:

```ts
...OPENCLAW_GONDOLIN_SANDBOX_REQUIREMENTS.map((requirement) =>
	requirementFinding({
		actualValue: effectiveOpenClawGondolinSandboxValue(
			defaults,
			agentConfig,
			requirement.key,
		),
		expectedValue: requirement.expectedValue,
		fieldPath: formatOpenClawGondolinRequirementFieldPath(label, requirement.key),
		label,
		zoneId: options.zoneId,
	}),
),
```

- [ ] **Step 4: Add focused contract helper test through plugin registration**

Modify `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts`.

In `publishes Tool VM runtime status from OpenClaw runtime config during full registration`, make the parsed body include finding details:

```ts
const body = JSON.parse(requestInit.body) as {
	readonly findings: readonly {
		readonly hint: string;
		readonly id: string;
		readonly ok: boolean;
	}[];
	readonly pluginId: string;
	readonly zoneId: string;
};
```

Add:

```ts
expect(body.findings).toEqual(
	expect.arrayContaining([
		expect.objectContaining({
			id: 'openclaw-tool-vm-agents-defaults-sandbox-backend-shravan-defaults',
			ok: true,
			hint: 'agents.defaults.sandbox.backend=gondolin',
		}),
		expect.objectContaining({
			id: 'openclaw-tool-vm-agents-defaults-sandbox-mode-shravan-defaults',
			ok: true,
			hint: 'agents.defaults.sandbox.mode=all',
		}),
		expect.objectContaining({
			id: 'openclaw-tool-vm-agents-defaults-sandbox-scope-shravan-defaults',
			ok: true,
			hint: 'agents.defaults.sandbox.scope=agent',
		}),
		expect.objectContaining({
			id: 'openclaw-tool-vm-agents-defaults-sandbox-workspaceAccess-shravan-defaults',
			ok: true,
			hint: 'agents.defaults.sandbox.workspaceAccess=rw',
		}),
	]),
);
```

- [ ] **Step 5: Run Task 1 tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add \
	packages/openclaw-agent-vm-plugin/src/openclaw-gondolin-contract.ts \
	packages/openclaw-agent-vm-plugin/src/index.ts \
	packages/openclaw-agent-vm-plugin/src/openclaw-runtime-status.ts \
	packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts
git commit -m "fix: share OpenClaw Gondolin contract helpers"
```

---

### Task 2: Enrich Plugin Lease Requests With Existing OpenClaw Data

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts`
- Test: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`
- Test: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`
- Test: `packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts`

- [ ] **Step 1: Update lease client request type and body**

Modify `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`.

Change `LeaseClient.requestLease` request type to:

```ts
requestLease(request: {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly profileId: string;
	readonly sandbox: {
		readonly backend: unknown;
		readonly mode: unknown;
		readonly scope: unknown;
		readonly workspaceAccess: unknown;
	};
	readonly scopeKey: string;
	readonly sessionKey: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}): Promise<ToolVmSshLease>;
```

In the `requestLease` fetch body, send:

```ts
body: JSON.stringify({
	agentId: request.agentId,
	agentWorkspaceDir: request.agentWorkspaceDir,
	profileId: request.profileId,
	sandbox: request.sandbox,
	scopeKey: request.scopeKey,
	sessionKey: request.sessionKey,
	workMountDir: request.workMountDir,
	zoneId: request.zoneId,
}),
```

- [ ] **Step 2: Update controller lease client tests**

Modify every valid `requestLease` call in `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts` to include:

```ts
agentId: 'main',
sandbox: {
	backend: 'gondolin',
	mode: 'all',
	scope: 'agent',
	workspaceAccess: 'rw',
},
sessionKey: 'agent:main:direct:test',
```

For tests using `scopeKey: 'agent:main:session-abc'`, change only the scope key to:

```ts
scopeKey: 'agent:main',
```

Keep `sessionKey` as the richer session identity:

```ts
sessionKey: 'agent:main:session-abc',
```

This proves `sessionKey` can be rich while `scopeKey` is agent-scoped.

- [ ] **Step 3: Widen plugin backend cfg type and preflight request**

Modify `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`.

Add imports:

```ts
import {
	expectedOpenClawGondolinScopeKey,
	findOpenClawGondolinSandboxMismatch,
	OPENCLAW_GONDOLIN_LEASE_SCOPE_GUIDANCE,
	resolveOpenClawAgentIdFromSessionKey,
	snapshotOpenClawGondolinSandboxConfig,
	type OpenClawGondolinSandboxSnapshot,
} from '../openclaw-gondolin-contract.js';
```

Change the factory param type:

```ts
readonly cfg: OpenClawGondolinSandboxSnapshot & {
	readonly docker?: {
		readonly env?: Record<string, string>;
	};
};
```

Add helper above `createGondolinSandboxBackendFactory`:

```ts
function resolveLeaseRequestAgentId(sessionKey: string): string {
	return resolveOpenClawAgentIdFromSessionKey(sessionKey);
}

function assertPluginLeaseContract(params: {
	readonly agentId: string;
	readonly cfg: OpenClawGondolinSandboxSnapshot;
	readonly scopeKey: string;
}): void {
	const mismatch = findOpenClawGondolinSandboxMismatch(params.cfg);
	if (mismatch) {
		throw new Error(
			`OpenClaw Gondolin sandbox requires ${mismatch.key}=${mismatch.expectedValue}; received ${String(params.cfg[mismatch.key])}.`,
		);
	}
	const expectedScopeKey = expectedOpenClawGondolinScopeKey(params.agentId);
	if (params.scopeKey !== expectedScopeKey) {
		throw new Error(
			`OpenClaw Gondolin sandbox requires scopeKey '${expectedScopeKey}' for agent '${params.agentId}'; received '${params.scopeKey}'. ${OPENCLAW_GONDOLIN_LEASE_SCOPE_GUIDANCE}`,
		);
	}
}
```

Inside the returned factory function, before cache key creation, add:

```ts
const agentId = resolveLeaseRequestAgentId(params.sessionKey);
assertPluginLeaseContract({
	agentId,
	cfg: params.cfg,
	scopeKey: params.scopeKey,
});
```

Change `requestLease` to:

```ts
const leaseResponse = await leaseClient.requestLease({
	agentId,
	agentWorkspaceDir: params.agentWorkspaceDir,
	profileId,
	sandbox: snapshotOpenClawGondolinSandboxConfig(params.cfg),
	scopeKey: params.scopeKey,
	sessionKey: params.sessionKey,
	workMountDir: params.workspaceDir,
	zoneId: options.zoneId,
});
```

- [ ] **Step 4: Add plugin backend preflight tests**

Modify `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`.

Add this helper near existing test setup helpers:

```ts
function gondolinSandboxConfig(
	overrides: Partial<{
		readonly backend: unknown;
		readonly mode: unknown;
		readonly scope: unknown;
		readonly workspaceAccess: unknown;
	}> = {},
) {
	return {
		backend: 'gondolin',
		mode: 'all',
		scope: 'agent',
		workspaceAccess: 'rw',
		...overrides,
	};
}
```

For valid factory calls, change `cfg: { docker: ... }` to:

```ts
cfg: {
	...gondolinSandboxConfig(),
	docker: {
		env: {
			OPENCLAW_LOG_LEVEL: 'debug',
		},
	},
},
scopeKey: 'agent:main',
sessionKey: 'agent:main:session-abc',
workspaceDir: '/home/openclaw/work',
agentWorkspaceDir: '/home/openclaw/work',
```

Add test:

```ts
it('rejects non-agent sandbox scope before requesting a lease', async () => {
	const requestLease = vi.fn();
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			createLeaseClient: () => ({
				endActiveUse: vi.fn(),
				heartbeatActiveUse: vi.fn(),
				peekLease: vi.fn(),
				publishOpenClawRuntimeStatus: vi.fn(),
				releaseLease: vi.fn(),
				renewLease: vi.fn(),
				requestLease,
				startActiveUse: vi.fn(),
			}),
			runRemoteShellScript: async () => ({
				code: 0,
				stderr: Buffer.from(''),
				stdout: Buffer.from(''),
			}),
		},
	);

	await expect(
		factory({
			agentWorkspaceDir: '/home/openclaw/work',
			cfg: gondolinSandboxConfig({ scope: 'session' }),
			scopeKey: 'agent:main:session-abc',
			sessionKey: 'agent:main:session-abc',
			workspaceDir: '/home/openclaw/work',
		}),
	).rejects.toThrow('OpenClaw Gondolin sandbox requires scope=agent; received session.');
	expect(requestLease).not.toHaveBeenCalled();
});
```

Add test:

```ts
it('rejects non-rw workspace access before requesting a lease', async () => {
	const requestLease = vi.fn();
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			createLeaseClient: () => ({
				endActiveUse: vi.fn(),
				heartbeatActiveUse: vi.fn(),
				peekLease: vi.fn(),
				publishOpenClawRuntimeStatus: vi.fn(),
				releaseLease: vi.fn(),
				renewLease: vi.fn(),
				requestLease,
				startActiveUse: vi.fn(),
			}),
			runRemoteShellScript: async () => ({
				code: 0,
				stderr: Buffer.from(''),
				stdout: Buffer.from(''),
			}),
		},
	);

	await expect(
			factory({
				agentWorkspaceDir: '/home/openclaw/work',
				cfg: gondolinSandboxConfig({ workspaceAccess: 'none' }),
				scopeKey: 'agent:main',
				sessionKey: 'agent:main:session-abc',
				workspaceDir: '/home/openclaw/work',
			}),
		).rejects.toThrow('OpenClaw Gondolin sandbox requires workspaceAccess=rw; received none.');
		expect(requestLease).not.toHaveBeenCalled();
	});
```

Add test:

```ts
it('sends agentId, sessionKey, and sandbox contract to the controller lease API', async () => {
	const requestLease = vi.fn(async () => ({
		leaseId: 'lease-123',
		ssh: {
			command: 'ssh ...',
			host: 'tool-0.vm.host',
			identityFile: '/tmp/key',
			port: 19000,
			user: 'sandbox',
		},
		workdir: '/work',
	}));
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			createLeaseClient: () => ({
				endActiveUse: vi.fn(),
				heartbeatActiveUse: vi.fn(),
				peekLease: vi.fn(),
				publishOpenClawRuntimeStatus: vi.fn(),
				releaseLease: vi.fn(),
				renewLease: vi.fn(),
				requestLease,
				startActiveUse: vi.fn(),
			}),
			runRemoteShellScript: async () => ({
				code: 0,
				stderr: Buffer.from(''),
				stdout: Buffer.from(''),
			}),
		},
	);

	await factory({
		agentWorkspaceDir: '/home/openclaw/work',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta',
		sessionKey: 'agent:beta:discord:channel:123',
		workspaceDir: '/home/openclaw/work',
	});

	expect(requestLease).toHaveBeenCalledWith(
		expect.objectContaining({
			agentId: 'beta',
			agentWorkspaceDir: '/home/openclaw/work',
			sandbox: {
				backend: 'gondolin',
				mode: 'all',
				scope: 'agent',
				workspaceAccess: 'rw',
			},
			scopeKey: 'agent:beta',
			sessionKey: 'agent:beta:discord:channel:123',
			workMountDir: '/home/openclaw/work',
			zoneId: 'shravan',
		}),
	);
	});
```

- [ ] **Step 5: Add legacy session-key fallback test**

Modify `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`.

Add:

```ts
it('mirrors OpenClaw fallback for legacy session keys by resolving agent main', async () => {
	const requestLease = vi.fn(async () => ({
		leaseId: 'lease-legacy-main',
		ssh: {
			command: 'ssh ...',
			host: 'tool-0.vm.host',
			identityFile: '/tmp/key',
			port: 19000,
			user: 'sandbox',
		},
		workdir: '/work',
	}));
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			createLeaseClient: () => ({
				endActiveUse: vi.fn(),
				heartbeatActiveUse: vi.fn(),
				peekLease: vi.fn(),
				publishOpenClawRuntimeStatus: vi.fn(),
				releaseLease: vi.fn(),
				renewLease: vi.fn(),
				requestLease,
				startActiveUse: vi.fn(),
			}),
			runRemoteShellScript: async () => ({
				code: 0,
				stderr: Buffer.from(''),
				stdout: Buffer.from(''),
			}),
		},
	);

	await factory({
		agentWorkspaceDir: '/home/openclaw/work',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:main',
		sessionKey: 'session-abc',
		workspaceDir: '/home/openclaw/work',
	});

	expect(requestLease).toHaveBeenCalledWith(
		expect.objectContaining({
			agentId: 'main',
			scopeKey: 'agent:main',
			sessionKey: 'session-abc',
		}),
	);
});
```

- [ ] **Step 6: Update controller integration tests**

Modify `packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts`.

For the valid integration test, use a complete managed sandbox snapshot and a collapsed agent scope:

```ts
cfg: {
	backend: 'gondolin',
	mode: 'all',
	scope: 'agent',
	workspaceAccess: 'rw',
	docker: {
		env: {
			OPENCLAW_LOG_LEVEL: 'debug',
		},
	},
},
scopeKey: 'agent:main',
sessionKey: 'session-abc',
workspaceDir: '/home/openclaw/work',
agentWorkspaceDir: '/home/openclaw/work',
```

Replace the existing `does not reuse a cached handle when the same scopeKey changes workspace identity` test. That test's premise is no longer a supported managed contract: under `workspaceAccess="rw"`, OpenClaw should provide the resolved agent workspace as both the work mount source and agent workspace. Keep cache churn coverage by varying `profileId` instead:

```ts
it('does not reuse a cached handle when the requested profile changes', async () => {
	const requestLease = vi
		.fn()
		.mockResolvedValueOnce(createLeaseResponse('lease-1'))
		.mockResolvedValueOnce(createLeaseResponse('lease-2'));
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			profileId: 'standard',
			zoneId: 'shravan',
		},
		createIntegrationFactoryDeps({ requestLease }),
	);
	const fastFactory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			profileId: 'fast',
			zoneId: 'shravan',
		},
		createIntegrationFactoryDeps({ requestLease }),
	);

	await factory({
		agentWorkspaceDir: '/home/openclaw/work',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:main',
		sessionKey: 'session-1',
		workspaceDir: '/home/openclaw/work',
	});
	await fastFactory({
		agentWorkspaceDir: '/home/openclaw/work',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:main',
		sessionKey: 'session-1',
		workspaceDir: '/home/openclaw/work',
	});

	expect(requestLease).toHaveBeenCalledTimes(2);
	expect(requestLease).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({ profileId: 'standard' }),
	);
	expect(requestLease).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({ profileId: 'fast' }),
	);
});
```

Use the repo's existing helper/dependency style if this file already has equivalent helpers; the important contract is the test behavior, not the helper names above.

- [ ] **Step 7: Run Task 2 tests**

Run:

```bash
pnpm vitest run \
	packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts \
	packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts \
	packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add \
	packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts \
	packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts \
	packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts \
	packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts \
	packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts
git commit -m "fix: enrich OpenClaw Tool VM lease requests"
```

---

### Task 3: Validate Enriched Lease Requests in the Controller

**Files:**
- Modify: `packages/agent-vm/src/controller/http/controller-request-schemas.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-request-schemas.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts`

- [ ] **Step 1: Extend controller request schema**

Modify `packages/agent-vm/src/controller/http/controller-request-schemas.ts`.

Replace `controllerLeaseCreateRequestSchema` with:

```ts
export const controllerLeaseCreateRequestSchema = z.strictObject({
	agentId: z.string().min(1),
	agentWorkspaceDir: z.string().min(1),
	idleTtlMs: z.number().int().positive().optional(),
	profileId: z.string().min(1),
	sandbox: z.strictObject({
		backend: z.unknown(),
		mode: z.unknown(),
		scope: z.unknown(),
		workspaceAccess: z.unknown(),
	}),
	scopeKey: z.string().min(1),
	sessionKey: z.string().min(1),
	workMountDir: z.string().min(1),
	zoneId: z.string().min(1),
});
```

- [ ] **Step 2: Update schema tests**

Modify `packages/agent-vm/src/controller/http/controller-request-schemas.test.ts`.

Update the expected lease create schema required fields to include:

```ts
required: [
	'agentId',
	'agentWorkspaceDir',
	'profileId',
	'sandbox',
	'scopeKey',
	'sessionKey',
	'workMountDir',
	'zoneId',
],
```

Add an assertion that `sandbox` is required:

```ts
expect(schema.properties?.sandbox).toMatchObject({
	type: 'object',
	required: ['backend', 'mode', 'scope', 'workspaceAccess'],
});
```

- [ ] **Step 3: Add controller lease contract helpers**

Modify `packages/agent-vm/src/controller/http/controller-http-routes.ts`.

Add import:

```ts
import {
	expectedOpenClawGondolinScopeKey,
	findOpenClawGondolinSandboxMismatch,
	OPENCLAW_GONDOLIN_LEASE_SCOPE_GUIDANCE,
	resolveOpenClawAgentIdFromSessionKey,
} from '@agent-vm/openclaw-agent-vm-plugin';
```

Add helper near `formatInvalidAgentScopeReason`:

```ts
function leaseContractErrorBody(options: {
	readonly error: string;
	readonly guidance: string;
	readonly message: string;
	readonly received: Record<string, unknown>;
}) {
	return {
		error: options.error,
		message: options.message,
		guidance: options.guidance,
		received: options.received,
	};
}

function validateOpenClawGondolinLeaseContract(payload: {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly sandbox: {
		readonly backend: unknown;
		readonly mode: unknown;
		readonly scope: unknown;
		readonly workspaceAccess: unknown;
	};
	readonly scopeKey: string;
	readonly sessionKey: string;
	readonly workMountDir: string;
}): ReturnType<typeof leaseContractErrorBody> | null {
	const sessionAgentId = resolveOpenClawAgentIdFromSessionKey(payload.sessionKey);
	if (sessionAgentId !== payload.agentId) {
		return leaseContractErrorBody({
			error: 'tool-vm-lease-agent-mismatch',
			message: `Lease agentId '${payload.agentId}' does not match sessionKey agent '${sessionAgentId}'.`,
			guidance:
				'The OpenClaw plugin must derive agentId from sessionKey and send both values unchanged to the controller.',
			received: {
				agentId: payload.agentId,
				sessionAgentId,
				sessionKey: payload.sessionKey,
			},
		});
	}
	const mismatch = findOpenClawGondolinSandboxMismatch(payload.sandbox);
	if (mismatch) {
		return leaseContractErrorBody({
			error: 'invalid-tool-vm-sandbox-contract',
			message: `Invalid OpenClaw sandbox contract: ${mismatch.key} must be ${mismatch.expectedValue}, received ${String(payload.sandbox[mismatch.key])}.`,
			guidance:
				'Managed OpenClaw/Gondolin requires backend="gondolin", mode="all", scope="agent", and workspaceAccess="rw".',
			received: {
				sandbox: payload.sandbox,
			},
		});
	}
	const expectedScopeKey = expectedOpenClawGondolinScopeKey(payload.agentId);
	if (payload.scopeKey !== expectedScopeKey) {
		return leaseContractErrorBody({
			error: 'invalid-tool-vm-lease-scope',
			message: `Invalid Tool VM lease scopeKey '${payload.scopeKey}': expected '${expectedScopeKey}'.`,
			guidance: OPENCLAW_GONDOLIN_LEASE_SCOPE_GUIDANCE,
			received: {
				agentId: payload.agentId,
				expectedScopeKey,
				scopeKey: payload.scopeKey,
				sessionKey: payload.sessionKey,
			},
		});
	}
	return null;
}
```

Do not compare `payload.workMountDir` and `payload.agentWorkspaceDir` as raw strings in this helper. They are gateway-originated path strings and can differ by trailing slash, symlink ancestor, or platform path alias while resolving to the same host path. Keep workspace mount validation in `resolveLeaseWorkMountDir`, which normalizes and realpaths the selected work mount before the lease is created.

- [ ] **Step 4: Use explicit agentId for profile lookup**

In the `/lease` route, replace:

```ts
const parsedScope = parseAgentScopeKey(payload.scopeKey);
if (parsedScope.kind !== 'agent') {
	const reason = formatInvalidAgentScopeReason(parsedScope);
	return context.json(
		{
			error: `Invalid Tool VM lease scope '${payload.scopeKey}': ${reason}`,
			kind: parsedScope.kind,
		},
		400,
	);
}
const agentId = parsedScope.agentId;
```

with:

```ts
const contractError = validateOpenClawGondolinLeaseContract(payload);
if (contractError) {
	return context.json(contractError, 400);
}
const agentId = payload.agentId;
```

Keep profile resolution:

```ts
const resolvedProfileId =
	(agentId ? options.zoneAgentToolVmProfiles?.[payload.zoneId]?.[agentId] : undefined) ??
	options.zoneDefaultToolVmProfiles?.[payload.zoneId] ??
	payload.profileId;
```

- [ ] **Step 5: Update valid controller lease tests**

Modify `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`.

For every valid `/lease` request body, add:

```ts
agentId: 'main',
sandbox: {
	backend: 'gondolin',
	mode: 'all',
	scope: 'agent',
	workspaceAccess: 'rw',
},
sessionKey: 'agent:main:session-abc',
```

Change valid `scopeKey` values from session-shaped strings to agent-shaped strings:

```ts
scopeKey: 'agent:main',
```

Ensure valid `workMountDir` and `agentWorkspaceDir` match in tests unless the test specifically covers conflict behavior:

```ts
agentWorkspaceDir: '/home/openclaw/work',
workMountDir: '/home/openclaw/work',
```

- [ ] **Step 6: Add controller rejection tests**

Add tests to `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`.

Agent/session mismatch:

```ts
it('rejects leases when agentId does not match sessionKey', async () => {
	const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
	const app = createControllerAppForTest({
		toolVmProfiles: {
			standard: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
		},
		leaseManager: {
			createLease,
			renewLease: vi.fn(),
			peekLease: vi.fn(),
			listLeases: vi.fn(() => []),
			releaseLease: vi.fn(async () => {}),
		},
	});

	const response = await app.request('/lease', {
		body: JSON.stringify({
			agentId: 'beta',
			agentWorkspaceDir: '/zone/agents/beta',
			profileId: 'standard',
			sandbox: {
				backend: 'gondolin',
				mode: 'all',
				scope: 'agent',
				workspaceAccess: 'rw',
			},
			scopeKey: 'agent:beta',
			sessionKey: 'agent:main:discord:channel:123',
			workMountDir: '/zone/agents/beta',
			zoneId: 'shravan',
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});

	expect(response.status).toBe(400);
	await expect(response.json()).resolves.toMatchObject({
		error: 'tool-vm-lease-agent-mismatch',
		message: "Lease agentId 'beta' does not match sessionKey agent 'main'.",
	});
	expect(createLease).not.toHaveBeenCalled();
});
```

Bad sandbox scope:

```ts
it('rejects leases when resolved sandbox scope is not agent', async () => {
	const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
	const app = createControllerAppForTest({
		toolVmProfiles: {
			standard: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
		},
		leaseManager: {
			createLease,
			renewLease: vi.fn(),
			peekLease: vi.fn(),
			listLeases: vi.fn(() => []),
			releaseLease: vi.fn(async () => {}),
		},
	});

	const response = await app.request('/lease', {
		body: JSON.stringify({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'standard',
				sandbox: {
					backend: 'gondolin',
					mode: 'all',
					scope: 'session',
					workspaceAccess: 'rw',
				},
				scopeKey: 'agent:main',
				sessionKey: 'agent:main:discord:channel:123',
				workMountDir: '/home/openclaw/work',
				zoneId: 'shravan',
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});

	expect(response.status).toBe(400);
	await expect(response.json()).resolves.toMatchObject({
		error: 'invalid-tool-vm-sandbox-contract',
		message: 'Invalid OpenClaw sandbox contract: scope must be agent, received session.',
	});
	expect(createLease).not.toHaveBeenCalled();
	});
```

Bad workspace access:

```ts
it('rejects leases when resolved sandbox workspaceAccess is not rw', async () => {
	const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
	const app = createControllerAppForTest({
		toolVmProfiles: {
			standard: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
		},
		leaseManager: {
			createLease,
			renewLease: vi.fn(),
			peekLease: vi.fn(),
			listLeases: vi.fn(() => []),
			releaseLease: vi.fn(async () => {}),
		},
	});

	const response = await app.request('/lease', {
		body: JSON.stringify({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'standard',
			sandbox: {
				backend: 'gondolin',
				mode: 'all',
				scope: 'agent',
				workspaceAccess: 'ro',
			},
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:discord:channel:123',
			workMountDir: '/home/openclaw/work',
			zoneId: 'shravan',
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});

	expect(response.status).toBe(400);
	await expect(response.json()).resolves.toMatchObject({
		error: 'invalid-tool-vm-sandbox-contract',
		message: 'Invalid OpenClaw sandbox contract: workspaceAccess must be rw, received ro.',
	});
	expect(createLease).not.toHaveBeenCalled();
});
```

Bad work mount:

```ts
it('rejects leases when workMountDir is not the resolved rw agent workspace', async () => {
	const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
	const app = createControllerAppForTest({
		toolVmProfiles: {
			standard: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
		},
		leaseManager: {
			createLease,
			renewLease: vi.fn(),
			peekLease: vi.fn(),
			listLeases: vi.fn(() => []),
			releaseLease: vi.fn(async () => {}),
		},
		resolveLeaseWorkMountDir: vi.fn(async () => {
			throw new LeaseWorkMountValidationError(
				'outside-allowed-roots',
				'workMountDir outside allowed OpenClaw roots',
			);
		}),
	});

	const response = await app.request('/lease', {
		body: JSON.stringify({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'standard',
			sandbox: {
				backend: 'gondolin',
				mode: 'all',
				scope: 'agent',
				workspaceAccess: 'rw',
			},
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:discord:channel:123',
			workMountDir: '/work',
			zoneId: 'shravan',
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});

	expect(response.status).toBe(400);
	await expect(response.json()).resolves.toEqual({
		error: 'workMountDir outside allowed OpenClaw roots',
		kind: 'outside-allowed-roots',
	});
	expect(createLease).not.toHaveBeenCalled();
});
```

Legacy session-key fallback:

```ts
it('accepts legacy session keys when they resolve to OpenClaw default agent main', async () => {
	const createLease = vi.fn(async () => createLeaseStub('lease-legacy-main', 0));
	const app = createControllerAppForTest({
		toolVmProfiles: {
			standard: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
		},
		leaseManager: {
			createLease,
			renewLease: vi.fn(),
			peekLease: vi.fn(),
			listLeases: vi.fn(() => []),
			releaseLease: vi.fn(async () => {}),
		},
	});

	const response = await app.request('/lease', {
		body: JSON.stringify({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'standard',
			sandbox: {
				backend: 'gondolin',
				mode: 'all',
				scope: 'agent',
				workspaceAccess: 'rw',
			},
			scopeKey: 'agent:main',
			sessionKey: 'session-abc',
			workMountDir: '/home/openclaw/work',
			zoneId: 'shravan',
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});

	expect(response.status).toBe(200);
	expect(createLease).toHaveBeenCalledWith(
		expect.objectContaining({
			scopeKey: 'agent:main',
		}),
	);
});
```

- [ ] **Step 7: Add path normalization coverage**

Modify `packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts`.

Add a regression test that proves trailing slashes and symlinked host roots are handled by the existing resolver path, not by raw string equality in the `/lease` route:

```ts
it('normalizes trailing slashes and symlinked allowed roots before comparing containment', async () => {
	const tmp = await mkdtemp(path.join(tmpdir(), 'agent-vm-lease-paths-'));
	const realZoneFilesDir = path.join(tmp, 'real-zone-files');
	const symlinkZoneFilesDir = path.join(tmp, 'zone-files-link');
	const agentWorkspace = path.join(realZoneFilesDir, 'agents', 'main');
	await mkdir(agentWorkspace, { recursive: true });
	await symlink(realZoneFilesDir, symlinkZoneFilesDir);

	const resolved = await resolveLeaseWorkMountDir({
		runtimeDir: path.join(tmp, 'runtime'),
		workMountDir: '/zone/agents/main/',
		zone: createOpenClawZoneConfig({
			zoneFilesDir: symlinkZoneFilesDir,
		}),
	});

	expect(resolved.guestWorkdir).toBe('/zone/agents/main');
	expect(resolved.hostWorkMountDir).toBe(await realpath(agentWorkspace));
});
```

Use this file's existing temporary-directory and zone-config helpers if the names differ. The required behavior is: normalize the guest path, resolve the symlinked allowed root, and return the real host work mount.

- [ ] **Step 8: Run Task 3 tests**

Run:

```bash
pnpm vitest run \
	packages/agent-vm/src/controller/http/controller-request-schemas.test.ts \
	packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
	packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add \
	packages/agent-vm/src/controller/http/controller-request-schemas.ts \
	packages/agent-vm/src/controller/http/controller-request-schemas.test.ts \
	packages/agent-vm/src/controller/http/controller-http-routes.ts \
	packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
	packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts
git commit -m "fix: validate enriched OpenClaw lease contract"
```

---

### Task 4: Use Explicit Agent Id for Seeding and Profile-Sensitive Paths

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Test: `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts`
- Test: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`

- [ ] **Step 1: Change seeding function to accept explicit agentId**

Modify `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts`.

Add import:

```ts
import { isOpenClawAgentId } from '@agent-vm/openclaw-agent-vm-plugin';
```

Extend `AgentSandboxSeedResult`:

```ts
| {
		readonly agentId: string;
		readonly kind: 'malformed-agent-id';
		readonly reason: string;
		readonly scopeKey: string;
		readonly zoneId: string;
  }
```

Change function signature:

```ts
export async function seedAgentSandboxWorkspace(options: {
	readonly agentId: string;
	readonly scopeKey: string;
	readonly secretResolver: SecretResolver;
	readonly hostWorkMountDir: string;
	readonly zone: ZoneConfig;
}): Promise<AgentSandboxSeedResult> {
```

Remove the `parseAgentScopeKey(options.scopeKey)` block and replace it with:

```ts
const agentId = options.agentId;
if (!isOpenClawAgentId(agentId)) {
	return {
		agentId,
		kind: 'malformed-agent-id',
		reason: `invalid agent id '${agentId}'`,
		scopeKey: options.scopeKey,
		zoneId: options.zone.id,
	};
}
```

Keep existing seed lookup:

```ts
const seeds = options.zone.agentSandboxSeeds?.[agentId] ?? [];
```

- [ ] **Step 2: Pass explicit agentId from controller route**

Modify the seeding call in `packages/agent-vm/src/controller/http/controller-http-routes.ts`.

Where `seedAgentSandboxWorkspace` is called, pass:

```ts
agentId: payload.agentId,
```

Keep:

```ts
scopeKey: payload.scopeKey,
```

because scope remains useful in logs/results, but no longer owns agent identity.

- [ ] **Step 3: Update seeding tests**

Modify `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts`.

For each `seedAgentSandboxWorkspace` call, add:

```ts
agentId: 'shravan',
```

For the old test that expected Discord sub-scopes to seed for the owning agent, keep that behavior valid by making the explicit agent id the source of truth:

```ts
const result = await seedAgentSandboxWorkspace({
	agentId: 'shravan',
	scopeKey: 'agent:shravan:discord:channel:123:thread:456',
	secretResolver: createSecretResolver(),
	hostWorkMountDir,
	zone,
});

expect(result.kind).toBe('seeded');
```

For the unsafe scope id test, replace the expected malformed scope result with an explicit-agent behavior test:

```ts
const result = await seedAgentSandboxWorkspace({
	agentId: 'shravan',
	scopeKey: 'agent:../shravan',
	secretResolver: createSecretResolver(),
	hostWorkMountDir,
	zone,
});

expect(result.kind).toBe('seeded');
```

This test proves seeding no longer trusts `scopeKey` for agent identity when the explicit `agentId` is valid.

Add the direct-call defense test:

```ts
const result = await seedAgentSandboxWorkspace({
	agentId: '../shravan',
	scopeKey: 'agent:shravan',
	secretResolver: createSecretResolver(),
	hostWorkMountDir,
	zone,
});

expect(result).toMatchObject({
	agentId: '../shravan',
	kind: 'malformed-agent-id',
	reason: "invalid agent id '../shravan'",
	scopeKey: 'agent:shravan',
	zoneId: zone.id,
});
```

This test proves the seeding function is safe even if a future caller invokes it without passing through the `/lease` route first.

- [ ] **Step 4: Run Task 4 tests**

Run:

```bash
pnpm vitest run \
	packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts \
	packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add \
	packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts \
	packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts \
	packages/agent-vm/src/controller/http/controller-http-routes.ts \
	packages/agent-vm/src/controller/http/controller-http-routes.test.ts
git commit -m "fix: use explicit agent id for sandbox seeding"
```

---

### Task 5: Surface Structured Lease Errors to Agents

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
- Test: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`
- Test: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`

- [ ] **Step 1: Add structured error message test**

Modify `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`.

Add:

```ts
it('includes structured controller lease guidance in request errors', async () => {
	const fetchImpl = vi.fn(async () =>
		new Response(
			JSON.stringify({
				error: 'invalid-tool-vm-sandbox-contract',
				message: 'Invalid OpenClaw sandbox contract: scope must be agent, received session.',
				guidance:
					'Managed OpenClaw/Gondolin requires backend="gondolin", mode="all", scope="agent", and workspaceAccess="rw".',
				received: {
					sandbox: {
						backend: 'gondolin',
						mode: 'all',
						scope: 'session',
						workspaceAccess: 'rw',
					},
				},
			}),
			{ status: 400 },
		),
	);
	const client = createLeaseClient({
		controllerUrl: 'http://controller.vm.host:18800',
		fetchImpl,
	});

	await expect(
		client.requestLease({
			agentId: 'main',
			agentWorkspaceDir: '/zone/agents/main',
			profileId: 'standard',
			sandbox: {
				backend: 'gondolin',
				mode: 'all',
				scope: 'session',
				workspaceAccess: 'rw',
			},
			scopeKey: 'agent:main:discord:channel:123',
			sessionKey: 'agent:main:discord:channel:123',
			workMountDir: '/zone/agents/main',
			zoneId: 'shravan',
		}),
	).rejects.toThrow(
		'Controller lease API returned HTTP 400 (client-error): Invalid OpenClaw sandbox contract: scope must be agent, received session. Guidance: Managed OpenClaw/Gondolin requires backend="gondolin", mode="all", scope="agent", and workspaceAccess="rw".',
	);
});
```

- [ ] **Step 2: Implement structured error suffix**

Modify `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`.

Add above `ControllerLeaseRequestError`:

```ts
function stringField(value: unknown, key: string): string | undefined {
	const record = objectValue(value);
	if (!record) {
		return undefined;
	}
	const field = Reflect.get(record, key);
	return typeof field === 'string' && field.trim() ? field : undefined;
}

function formatStructuredErrorSuffix(responseBody: unknown): string {
	const message = stringField(responseBody, 'message');
	const guidance = stringField(responseBody, 'guidance');
	const parts = [
		message,
		guidance ? `Guidance: ${guidance}` : undefined,
	].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? `: ${parts.join(' ')}` : '';
}
```

Change constructor `super(...)` to:

```ts
super(
	`${options.context} returned HTTP ${String(options.status)} (${kind})${formatStructuredErrorSuffix(
		options.responseBody,
	)}`,
);
```

- [ ] **Step 3: Include structured response in plugin logs**

Modify `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`.

Add helper:

```ts
function formatControllerLeaseRequestError(error: ControllerLeaseRequestError): string {
	const responseBody =
		typeof error.responseBody === 'object' && error.responseBody !== null
			? JSON.stringify(error.responseBody)
			: error.bodyText;
	return `${error.message}; response=${responseBody}`;
}
```

Update `formatUnknownError`:

```ts
function formatUnknownError(error: unknown): string {
	if (error instanceof ControllerLeaseRequestError) {
		return formatControllerLeaseRequestError(error);
	}
	return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Run Task 5 tests**

Run:

```bash
pnpm vitest run \
	packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts \
	packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add \
	packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts \
	packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts \
	packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts \
	packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts
git commit -m "fix: surface OpenClaw lease contract errors"
```

---

### Task 6: Keep Static Validation and Docs Aligned

**Files:**
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-requirements.ts`
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/subsystems/controller.md`
- Modify: `docs/reference/validate-and-doctor.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Reuse shared requirement constants in static validation**

Modify `packages/agent-vm/src/operations/openclaw-deployment-requirements.ts`.

Import:

```ts
import {
	effectiveOpenClawGondolinSandboxValue,
	formatOpenClawGondolinRequirementFieldPath,
	formatOpenClawGondolinRequirementFindingId,
	formatOpenClawGondolinRequirementHint,
	OPENCLAW_GONDOLIN_SANDBOX_REQUIREMENTS,
	type OpenClawGondolinAgentConfig,
} from '@agent-vm/openclaw-agent-vm-plugin';
```

Change `OpenClawAgentConfig`:

```ts
interface OpenClawAgentConfig extends OpenClawGondolinAgentConfig {
	readonly model?: unknown;
	readonly tools?: OpenClawToolPolicyConfig;
}
```

Replace local `effectiveSandboxValue` and local hard-coded sandbox findings with:

```ts
...OPENCLAW_GONDOLIN_SANDBOX_REQUIREMENTS.map((requirement) =>
	requirementFinding({
		actualValue: effectiveOpenClawGondolinSandboxValue(defaults, config, requirement.key),
		expectedValue: requirement.expectedValue,
		fieldPath: formatOpenClawGondolinRequirementFieldPath(label, requirement.key),
		label,
		zoneId: target.zoneId,
	}),
),
```

Use shared finding formatting in `requirementFinding`:

```ts
function requirementFinding(options: {
	readonly actualValue: unknown;
	readonly expectedValue: string;
	readonly fieldPath: string;
	readonly label: string;
	readonly zoneId: string;
}): OpenClawDeploymentRequirementFinding {
	const ok = options.actualValue === options.expectedValue;
	return {
		id: formatOpenClawGondolinRequirementFindingId({
			fieldPath: options.fieldPath,
			label: options.label,
			zoneId: options.zoneId,
		}),
		ok,
		hint: formatOpenClawGondolinRequirementHint({
			expectedValue: options.expectedValue,
			fieldPath: options.fieldPath,
			ok,
		}),
	};
}
```

- [ ] **Step 2: Add doctor coverage for per-agent bad overrides**

Modify `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`.

Add:

```ts
it('flags per-agent sandbox overrides that break the managed Gondolin contract', () => {
	const checks = buildOpenClawDeploymentDoctorChecks([
		{
			kind: 'readable',
			zoneId: 'shravan',
			config: {
				agents: {
					defaults: {
						sandbox: {
							backend: 'gondolin',
							mode: 'all',
							scope: 'agent',
							workspaceAccess: 'rw',
						},
						workspace: '/zone/agents/default',
					},
					list: [
						{
							id: 'beta',
							sandbox: {
								scope: 'session',
								workspaceAccess: 'ro',
							},
							workspace: '/zone/agents/beta',
						},
					],
				},
			},
		},
	]);

	expect(
		checks.find(
			(check) => check.name === 'openclaw-tool-vm-agents-agent-beta-sandbox-scope-shravan-agent-beta',
		),
	).toMatchObject({
		ok: false,
		hint: 'Set agents.agent-beta.sandbox.scope to "agent" for OpenClaw Tool VM mediation.',
	});
	expect(
		checks.find(
			(check) =>
				check.name ===
				'openclaw-tool-vm-agents-agent-beta-sandbox-workspaceAccess-shravan-agent-beta',
		),
	).toMatchObject({
		ok: false,
		hint: 'Set agents.agent-beta.sandbox.workspaceAccess to "rw" for OpenClaw Tool VM mediation.',
	});
});
```

- [ ] **Step 3: Update architecture docs**

In `docs/architecture/openclaw-gateway.md`, add:

```md
### Managed OpenClaw/Gondolin lease contract

Managed OpenClaw zones use the `@agent-vm/openclaw-agent-vm-plugin` sandbox
backend. agent-vm supports this OpenClaw sandbox contract:

- `agents.*.sandbox.backend: "gondolin"`
- `agents.*.sandbox.mode: "all"`
- `agents.*.sandbox.scope: "agent"`
- `agents.*.sandbox.workspaceAccess: "rw"`
- `agents.*.workspace` points at a non-root agent workspace such as `/zone/agents/default`

The plugin receives OpenClaw's existing backend parameters and sends the
controller a richer lease request:

- `agentId` resolved from `sessionKey` using OpenClaw-equivalent fallback behavior
- `sessionKey` for diagnostics and consistency validation
- `scopeKey` for lease reuse identity
- `sandbox` snapshot containing backend/mode/scope/workspaceAccess
- `workMountDir` copied from OpenClaw's resolved `workspaceDir`
- `agentWorkspaceDir` copied from OpenClaw's canonical agent workspace

The controller validates that `scopeKey` is `agent:<agentId>` because managed
Gondolin only supports OpenClaw `scope="agent"`. It does not use `scopeKey` as
the source of truth for `agentId`; `agentId` is explicit request data derived
from `sessionKey`. This is a trusted-plugin consistency check, not independent
agent authentication; adding true controller-side agent authentication would
require a separate allow-list or token-bound lease API.
```

- [ ] **Step 4: Update controller docs**

In `docs/subsystems/controller.md`, update the lease route shape:

```md
POST /lease {
  zoneId,
  agentId,
  sessionKey,
  scopeKey,
  profileId,
  sandbox: { backend, mode, scope, workspaceAccess },
  agentWorkspaceDir,
  workMountDir,
  idleTtlMs?
}
```

Add:

```md
For OpenClaw/Gondolin leases, `agentId` and `sessionKey` must be internally
consistent with OpenClaw's session-key resolution rules, `scopeKey` controls
lease reuse, and `profileId` is only the requested fallback.
The controller resolves the effective Tool VM profile from
`agentToolVmProfiles[agentId]`, then `defaultToolVmProfile`, then the requested
`profileId`.
```

- [ ] **Step 5: Update validate/doctor docs**

Modify `docs/reference/validate-and-doctor.md`.

Replace the OpenClaw Tool VM bullet with:

```md
- OpenClaw Tool VM deployment requirements are enforced for OpenClaw zones:
  `agents.*.sandbox.backend: "gondolin"`, `mode: "all"`, `scope: "agent"`,
  `workspaceAccess: "rw"`, and a non-root agent workspace. At runtime, the
  plugin also sends these resolved sandbox values to `/lease`; the controller
  rejects leases whose live sandbox contract does not match the static
  requirements.
```

- [ ] **Step 6: Update generated manual template**

Modify `packages/agent-vm/src/cli/manual-templates.ts`.

Ensure the OpenClaw Tool VM manual section contains:

```md
Agent-vm managed OpenClaw requires:

- `agents.*.sandbox.backend: "gondolin"`
- `agents.*.sandbox.mode: "all"`
- `agents.*.sandbox.scope: "agent"`
- `agents.*.sandbox.workspaceAccess: "rw"`
- a non-root agent workspace such as `/zone/agents/default`

The OpenClaw plugin sends `agentId`, `sessionKey`, `scopeKey`, the resolved
sandbox values, and workspace paths to the controller for every Tool VM lease.
The controller uses `agentId` for policy/profile lookup and `scopeKey` for lease
reuse, after checking that the trusted plugin payload is internally consistent.
Do not use raw channel/session/subagent keys as the managed lease scope; with
`scope="agent"`, the scope key must be `agent:<agentId>`.
```

- [ ] **Step 7: Update manual template test**

Modify `packages/agent-vm/src/cli/manual-templates.test.ts`.

Add:

```ts
expect(manual).toContain('agents.*.sandbox.workspaceAccess: "rw"');
expect(manual).toContain('The controller uses `agentId` for policy/profile lookup');
expect(manual).toContain('scope key must be `agent:<agentId>`');
```

- [ ] **Step 8: Run Task 6 tests**

Run:

```bash
pnpm vitest run \
	packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts \
	packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 6**

```bash
git add \
	packages/agent-vm/src/operations/openclaw-deployment-requirements.ts \
	packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts \
	docs/architecture/openclaw-gateway.md \
	docs/subsystems/controller.md \
	docs/reference/validate-and-doctor.md \
	packages/agent-vm/src/cli/manual-templates.ts \
	packages/agent-vm/src/cli/manual-templates.test.ts
git commit -m "docs: align OpenClaw lease contract guidance"
```

---

### Task 7: Full Verification

**Files:**
- No planned file edits.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run \
	packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts \
	packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts \
	packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts \
	packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts \
	packages/agent-vm/src/controller/http/controller-request-schemas.test.ts \
	packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
	packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts \
	packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts \
	packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts \
	packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

- [ ] **Step 2: Check for stale long agent scope fixtures**

Run:

```bash
rg -n "scopeKey: ['\"]agent:[^'\"]+:" packages
```

Expected: no matches in valid-path fixtures. Matches are allowed only when the test name explicitly covers rejecting or ignoring malformed/stale scope keys.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS with exit code 0.

- [ ] **Step 4: Run formatter check**

Run:

```bash
pnpm fmt:check
```

Expected: PASS with exit code 0.

- [ ] **Step 5: Run lint**

Run:

```bash
pnpm lint
```

Expected: PASS with exit code 0.

- [ ] **Step 6: Run full gate**

Run:

```bash
pnpm check
```

Expected: PASS with exit code 0.

- [ ] **Step 7: Check diff hygiene**

Run:

```bash
git diff --stat
git diff --check
```

Expected:

```text
git diff --check exits 0 and prints no whitespace errors.
```

- [ ] **Step 8: Commit verification fixes if needed**

If verification required follow-up edits:

```bash
git add <changed-files>
git commit -m "test: verify OpenClaw lease contract"
```

If no follow-up edits were required, do not create an empty commit.

---

## Self-Review

Spec coverage:

- No OpenClaw patch required: Tasks 2 and 3 use only existing backend params.
- `agentId` is not inferred from `scopeKey`: Tasks 2 and 3 resolve it from `sessionKey` using OpenClaw-equivalent fallback behavior and send it explicitly.
- Legacy/raw OpenClaw session keys still work: Tasks 2 and 3 cover fallback to agent `main`.
- We still only allow `scope="agent"`: Tasks 2, 3, and 6 enforce and document it.
- Lease receives more data: Tasks 2 and 3 add `agentId`, `sessionKey`, and `sandbox` to `/lease`.
- Controller knows what is valid: Task 3 validates trusted plugin payload consistency and returns structured errors.
- Raw workspace string equality is not used: Task 3 keeps path validation in the resolver and adds normalization coverage.
- Agent sees better responses: Task 5 preserves `message` and `guidance` in plugin errors/logs.
- Static validate/startup checks remain aligned: Tasks 1 and 6 share constants and update docs.
- `ro`/`none` are rejected for managed Gondolin: Tasks 2 and 3 check `workspaceAccess="rw"`.

Placeholder scan:

- No placeholder markers from the forbidden list.
- No deferred implementation language.
- No generic error-handling instruction without concrete code.
- Every code-changing step includes concrete code or an exact replacement pattern.

Type consistency:

- `OpenClawGondolinSandboxSnapshot` is used in plugin preflight and request payload construction.
- `/lease` schema, plugin request type, and controller route all use `agentId`, `sessionKey`, `scopeKey`, `sandbox`, `workMountDir`, and `agentWorkspaceDir`.
- `profileId` remains the requested fallback while controller resolution still prefers system config mappings.
