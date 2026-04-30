# Multi-Zone Controller Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one `agent-vm controller start` process control all configured zones, with partial-start semantics, route dispatch by target zone, and per-agent tool VM profile selection inside a zone.

**Architecture:** Use a BC-combined design: a `ZoneRuntimeRegistry` owns lifecycle and partial-start state for every selected zone, while type-specific zone runtimes (`OpenClawZoneRuntime`, `WorkerZoneRuntime`) own the behavior each gateway type supports. The controller keeps one shared HTTP server, secret resolver, TCP pool, lease manager, idle reaper, and task registry; every `/zones/:zoneId/...` route dispatches through the target zone runtime instead of through one process-wide active zone. Tool VM leases stay zone-scoped for reuse and locking, but resolve their tool VM profile from `scopeKey` so multiple agents in the same zone can receive distinct tool VM images.

**Tech Stack:** TypeScript, Node 24, Hono, Vitest, pnpm, OXC formatting/linting, existing Gondolin gateway lifecycle APIs.

---

## Required Branch Preflight

Before implementing this plan, update the implementation branch to current `origin/master`. The `zone-fix` worktree used to write this plan was behind `origin/master` at validation time:

```text
zone-fix HEAD:     7cd7eb8 Merge pull request #29 from ShravanSunder/feat/tool-lease-scope-git-pull
origin/master:     c7998b5 docs: document local npm publish flow
missing from zone-fix:
  b085e05 Merge pull request #30 from ShravanSunder/feat/pinned-tool-realfs
  8eea6e4 Merge pull request #31 from ShravanSunder/codex/lease-peek-keepalive
  c7998b5 docs: document local npm publish flow
```

Use:

```bash
git fetch origin --prune --tags
git merge --ff-only origin/master
```

Expected: fast-forward succeeds because `zone-fix` has no commits beyond the old merge base. If it does not, stop and resolve the branch sync first; do not implement multi-zone runtime work on a branch missing PR #30/PR #31.

Validation note: this worktree was fast-forwarded to `c7998b5` after the stale-branch finding. Keep this preflight in the plan so a fresh implementation agent repeats the check before writing code.

## File Structure

Create these focused files:

- `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-errors.ts`
  - Defines typed runtime errors used by HTTP routes to return `404`, `405`, `409`, or `503` instead of generic `500`.
- `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts`
  - Defines `ControllerZoneRuntime`, `OpenClawZoneRuntime`, `WorkerZoneRuntime`, lifecycle-state snapshots, and shared runtime dependencies.
- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`
  - Owns persistent OpenClaw gateway lifecycle for one zone: start, stop, restart, logs, SSH, exec, credentials refresh, upgrade, destroy support.
- `packages/agent-vm/src/controller/zone-runtimes/worker-zone-runtime.ts`
  - Owns Agent Worker behavior for one zone: task preparation/execution, task state, close, push branches, pull default, destroy support.
- `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.ts`
  - Builds one typed runtime per selected zone, starts all selected zones with partial-start semantics, exposes per-zone dispatch and all-zone shutdown.
- `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts`
  - Unit tests for partial-start, per-zone routing, and isolated restart/stop behavior.
- `packages/agent-vm/src/controller/leases/tool-vm-profile-selection.ts`
  - Resolves the effective tool VM profile for a lease by parsing `scopeKey` and applying `zone.agentToolVmProfiles[agentId]` before falling back to `zone.defaultToolVmProfile`.
- `packages/agent-vm/src/controller/leases/tool-vm-profile-selection.test.ts`
  - Unit tests for `agent:<agentId>` parsing, fallback behavior, and invalid/missing profile errors.
- `packages/agent-vm/src/controller/leases/lease-scope.ts`
  - Shared `scopeKey` parsing helpers, including `parseAgentIdFromScopeKey`, used by sandbox seeding, TTL policy, and tool VM profile selection.
- `packages/agent-vm/src/controller/leases/lease-idle-policy.ts`
  - Parses `scopeKey` and chooses idle TTL policy so each scope kind or exact scope key can have a distinct idle timeout.
- `packages/agent-vm/src/controller/leases/lease-idle-policy.test.ts`
  - Unit tests for per-scope TTL selection and fallback behavior.
- `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts`
  - Idempotently seeds first-boot per-agent sandbox files before a tool VM lease mounts the workspace.
- `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts`
  - Unit tests for safe target paths, idempotency, per-agent locking, and configured file/directory copies.

Modify these existing files:

- `packages/gateway-interface/src/gateway-lifecycle.ts`
  - Replace single `authProfilesRef` with explicit per-agent auth profile references on OpenClaw gateway config.
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
  - Write `auth-profiles.json` for every configured agent under `stateDir/agents/<agentId>/agent/` instead of hardcoding `main`.
- `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`
  - Assert per-agent auth profiles are written and missing agent mappings fail loudly.
- `packages/agent-vm/src/controller/controller-runtime.ts`
  - Remove process-wide `activeZone`; create shared services, create registry, wire operations from registry, close all zones.
- `packages/agent-vm/src/config/system-config.ts`
  - Add `zones[].agentToolVmProfiles`, `zones[].agentSandboxSeeds`, OpenClaw `gateway.authProfilesByAgent`, `leaseIdleTtl`, and cross-field validation.
- `packages/agent-vm/src/controller/http/controller-http-routes.ts`
  - Replace zone-only lease profile selection with `selectToolVmProfileForLease({ scopeKey, zone })`; run per-agent sandbox seeding after workspace resolution and before lease creation.
- `packages/agent-vm/src/controller/controller-runtime-operations.ts`
  - Replace `activeZoneId` guard with registry-backed dispatch operations.
- `packages/agent-vm/src/controller/controller-runtime-types.ts`
  - Replace `zoneId` option with optional `zoneIds`; replace single `gateway` return with per-zone status summary.
- `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`
  - Map typed runtime errors to stable HTTP statuses.
- `packages/agent-vm/src/operations/controller-status.ts`
  - Build status from per-zone snapshots rather than one `activeZoneId`.
- `packages/agent-vm/src/operations/doctor.ts`
  - Add zone/tool-vm-profile setup checks so `doctor` shows fallback and per-agent tool VM profile mappings.
- `packages/agent-vm/src/operations/config-validation.ts`
  - Include the same zone/tool-vm-profile setup checks in `agent-vm validate`.
- `packages/agent-vm/src/cli/commands/controller-definition.ts`
  - Make `controller start --zone <id>` optional; no `--zone` starts all zones; output per-zone results.
- `packages/agent-vm/src/cli/vm-host-system-templates.ts`
  - Remove hardcoded `--zone` from generated controller start script.
- `packages/agent-vm/src/controller/leases/idle-reaper.ts`
  - Replace one global `ttlMs` with per-lease TTL resolution.
- `packages/agent-vm/src/controller/git-push-operations.ts`
  - Remove stale retry-after wording that tells agents to start a new task.
- `packages/agent-vm/src/controller/git-pull-default-operations.ts`
  - Remove stale retry-after wording that tells agents to start a new task.
- `packages/agent-vm/src/cli/init-command.ts`
  - Keep generated `tcpPool.size` at `12` and ensure tests/docs continue to assert that default.
- `docs/reference/configuration/system-json.md`
  - Document `agentToolVmProfiles`, `authProfilesByAgent`, lease idle policy, and validation rules.
- `docs/reference/validate-and-doctor.md`
  - Document manual preflight commands and the new validate/doctor setup checks.
- `docs/architecture/overview.md`
  - Update the high-level system model: one controller, multiple typed zone runtimes, per-zone/per-agent auth, sandbox seeding, and per-scope lease TTL.
- `docs/architecture/openclaw-gateway.md`
  - Update the OpenClaw gateway model for per-zone/per-agent auth profiles, per-agent sandbox seeding, and per-agent tool VM profile selection.
- `docs/architecture/storage-model.md`
  - Update state and zone-file ownership for `agents/<agentId>/agent/auth-profiles.json` and sandbox seed markers.
- `docs/architecture/storage-matrix.md`
  - Update durable/ephemeral classifications for per-agent auth profiles and sandbox seeds.
- `docs/subsystems/controller.md`
  - Update lifecycle docs from active-zone to multi-zone registry.
- `docs/subsystems/gateway-lifecycle.md`
  - Replace `agents/main/agent/auth-profiles.json` docs with per-agent auth profile materialization.
- `docs/subsystems/secrets-and-credentials.md`
  - Document per-agent OpenClaw auth profile secrets.
- `docs/getting-started/openclaw-guide.md`
  - Update the example config to use `authProfilesByAgent`, `agentToolVmProfiles`, `agentSandboxSeeds`, and the `tcpPool.size: 12` default.
- Tests in:
  - `packages/gateway-interface/src/gateway-lifecycle.test.ts` if interface-level compile tests exist; otherwise cover through dependent packages.
  - `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`
  - `packages/agent-vm/src/controller/controller-runtime.test.ts`
  - `packages/agent-vm/src/controller/controller-runtime-operations.test.ts`
  - `packages/agent-vm/src/config/system-config.test.ts`
  - `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
  - `packages/agent-vm/src/controller/leases/tool-vm-profile-selection.test.ts`
  - `packages/agent-vm/src/controller/leases/lease-idle-policy.test.ts`
  - `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts`
  - `packages/agent-vm/src/operations/config-validation.test.ts`
  - `packages/agent-vm/src/operations/doctor.test.ts`
  - `packages/agent-vm/src/operations/controller-status.test.ts`
  - `packages/agent-vm/src/cli/controller-operation-commands.test.ts`
  - `packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts`
  - `packages/agent-vm/src/cli/commands/controller-definition.test.ts`
  - `packages/agent-vm/src/cli/vm-host-system-templates.test.ts`
  - `packages/agent-vm/src/integration-tests/live-api-smoke.integration.test.ts`

Out of scope:

- No npm publishing.
- No release tags.
- No change to lease peek/keepalive behavior from PR #31.
- No fd-rooted RealFS provider work.
- No schema change for per-zone TCP pools; current `tcpPool.size` remains global controller capacity.
- No per-agent zones. Agents share a zone and get per-agent tool VM profiles through lease profile selection.

---

### Task 1: Add Runtime Errors and Per-Zone Status Model

**Files:**
- Create: `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-errors.ts`
- Modify: `packages/agent-vm/src/operations/controller-status.ts`
- Test: `packages/agent-vm/src/operations/controller-status.test.ts`

- [ ] **Step 1: Write failing status tests for multiple running/failed/stopped zones**

Add these tests to `packages/agent-vm/src/operations/controller-status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { buildControllerStatus, buildControllerZoneStatus } from './controller-status.js';

const systemConfig = {
	host: {
		controllerPort: 18800,
		projectNamespace: 'multi-zone-test',
	},
	cacheDir: './cache',
	runtimeDir: './runtime',
	imageProfiles: {
		gateways: {
			openclaw: { type: 'openclaw', buildConfig: './gateway.json' },
			worker: { type: 'worker', buildConfig: './worker.json' },
		},
		toolVms: {
			standard: { type: 'toolVm', buildConfig: './tool.json' },
		},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './shravan/openclaw.json',
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
			},
			secrets: {},
			allowedHosts: ['api.openai.com'],
			websocketBypass: [],
			agentToolVmProfiles: {},
},
		{
			id: 'alevtina',
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18792,
				config: './alevtina/openclaw.json',
				stateDir: './state/alevtina',
				zoneFilesDir: './zone-files/alevtina',
			},
			secrets: {},
			allowedHosts: ['api.openai.com'],
			websocketBypass: [],
			agentToolVmProfiles: {},
},
		{
			id: 'worker-zone',
			gateway: {
				type: 'worker',
				imageProfile: 'worker',
				memory: '2G',
				cpus: 2,
				port: 18793,
				config: './worker/worker.json',
				stateDir: './state/worker',
			},
			secrets: {},
			allowedHosts: ['api.openai.com'],
			websocketBypass: [],
		},
	],
	toolVmProfiles: {
		standard: {
			cpus: 1,
			imageProfile: 'standard',
			memory: '1G',
		},
	},
	tcpPool: { basePort: 19000, size: 5 },
} satisfies SystemConfig;

describe('buildControllerStatus', () => {
	it('summarizes multiple zone lifecycle states from runtime snapshots', () => {
		const status = buildControllerStatus(systemConfig, {
			activeLeases: [{ zoneId: 'shravan' }, { zoneId: 'shravan' }, { zoneId: 'alevtina' }],
			zones: {
				shravan: {
					bootedAt: '2026-04-30T10:00:00.000Z',
					lifecycleState: 'running',
					gateway: {
						ingress: { host: '127.0.0.1', port: 18791 },
						vm: { id: 'vm-shravan' },
					},
				},
				alevtina: {
					lastError: 'gateway boot failed',
					lifecycleState: 'failed',
				},
				'worker-zone': {
					lifecycleState: 'stopped',
				},
			},
		});

		expect(status).toEqual({
			controllerPort: 18800,
			toolVmProfiles: ['standard'],
			zones: [
				{
					activeLeaseCount: 2,
					bootedAt: '2026-04-30T10:00:00.000Z',
					gatewayType: 'openclaw',
					id: 'shravan',
					ingressHost: '127.0.0.1',
					ingressPort: 18791,
					lifecycleState: 'running',
					running: true,
					agentToolVmProfiles: {},
vmId: 'vm-shravan',
				},
				{
					activeLeaseCount: 1,
					gatewayType: 'openclaw',
					id: 'alevtina',
					ingressPort: 18792,
					lastError: 'gateway boot failed',
					lifecycleState: 'failed',
					running: false,
					agentToolVmProfiles: {},
},
				{
					activeLeaseCount: 0,
					gatewayType: 'worker',
					id: 'worker-zone',
					ingressPort: 18793,
					lifecycleState: 'stopped',
					running: false,
				},
			],
		});
	});

	it('returns one zone status from the same per-zone runtime snapshot', () => {
		const zoneStatus = buildControllerZoneStatus(systemConfig, 'alevtina', {
			zones: {
				alevtina: {
					lastError: 'gateway boot failed',
					lifecycleState: 'failed',
				},
			},
		});

		expect(zoneStatus).toMatchObject({
			id: 'alevtina',
			lastError: 'gateway boot failed',
			lifecycleState: 'failed',
			running: false,
		});
	});
});
```

- [ ] **Step 2: Run the focused failing tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/operations/controller-status.test.ts
```

Expected: FAIL because `ControllerRuntimeStatus` does not have `zones`, and status output does not include `lifecycleState`.

- [ ] **Step 3: Add typed runtime errors**

Create `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-errors.ts`:

```ts
export class ControllerZoneNotFoundError extends Error {
	public constructor(zoneId: string) {
		super(`Unknown zone '${zoneId}'.`);
		this.name = 'ControllerZoneNotFoundError';
	}
}

export class ControllerZoneOperationUnsupportedError extends Error {
	public constructor(zoneId: string, operationName: string, gatewayType: string) {
		super(`Zone '${zoneId}' with gateway type '${gatewayType}' does not support ${operationName}.`);
		this.name = 'ControllerZoneOperationUnsupportedError';
	}
}

export class ControllerZoneRuntimeUnavailableError extends Error {
	public constructor(zoneId: string, lastError?: string) {
		super(
			lastError
				? `Gateway runtime for zone '${zoneId}' is unavailable. Last error: ${lastError}`
				: `Gateway runtime for zone '${zoneId}' is unavailable.`,
		);
		this.name = 'ControllerZoneRuntimeUnavailableError';
	}
}

export class ControllerZoneRuntimeStartError extends Error {
	public constructor(zoneId: string, cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to start zone '${zoneId}': ${message}`, { cause });
		this.name = 'ControllerZoneRuntimeStartError';
	}
}
```

- [ ] **Step 4: Implement per-zone status input**

Replace the single-gateway status model in `packages/agent-vm/src/operations/controller-status.ts` with:

```ts
import type { SystemConfig } from '../config/system-config.js';

export type ControllerZoneLifecycleState = 'running' | 'failed' | 'stopped';

export interface ControllerRuntimeZoneStatus {
	readonly bootedAt?: string;
	readonly gateway?: {
		readonly ingress: {
			readonly host: string;
			readonly port: number;
		};
		readonly vm: {
			readonly id: string;
		};
	};
	readonly lastError?: string;
	readonly lifecycleState: ControllerZoneLifecycleState;
}

export interface ControllerRuntimeStatus {
	readonly activeLeases?: readonly { readonly zoneId: string }[];
	readonly zones?: Readonly<Record<string, ControllerRuntimeZoneStatus>>;
}

export interface ControllerZoneStatusSummary {
	readonly activeLeaseCount: number;
	readonly bootedAt?: string;
	readonly gatewayType: SystemConfig['zones'][number]['gateway']['type'];
	readonly id: string;
	readonly ingressHost?: string;
	readonly ingressPort: number;
	readonly lastError?: string;
	readonly lifecycleState: ControllerZoneLifecycleState;
	readonly running: boolean;
	readonly defaultToolVmProfile?: string;
	readonly vmId?: string;
}

export interface ControllerStatusSummary {
	readonly controllerPort: number;
	readonly toolVmProfiles: string[];
	readonly zones: ControllerZoneStatusSummary[];
}

function buildZoneStatus(
	zone: SystemConfig['zones'][number],
	runtimeStatus: ControllerRuntimeStatus,
): ControllerZoneStatusSummary {
	const zoneRuntimeStatus = runtimeStatus.zones?.[zone.id] ?? {
		lifecycleState: 'stopped' as const,
	};
	const running =
		zoneRuntimeStatus.lifecycleState === 'running' && zoneRuntimeStatus.gateway !== undefined;
	const activeLeaseCount =
		runtimeStatus.activeLeases?.filter((activeLease) => activeLease.zoneId === zone.id).length ?? 0;

	return {
		activeLeaseCount,
		gatewayType: zone.gateway.type,
		id: zone.id,
		ingressPort: running ? zoneRuntimeStatus.gateway.ingress.port : zone.gateway.port,
		lifecycleState: zoneRuntimeStatus.lifecycleState,
		running,
		...(running && zoneRuntimeStatus.bootedAt ? { bootedAt: zoneRuntimeStatus.bootedAt } : {}),
		...(running
			? {
					ingressHost: zoneRuntimeStatus.gateway.ingress.host,
					vmId: zoneRuntimeStatus.gateway.vm.id,
				}
			: {}),
		...(zoneRuntimeStatus.lastError ? { lastError: zoneRuntimeStatus.lastError } : {}),
		...(zone.defaultToolVmProfile ? { defaultToolVmProfile: zone.defaultToolVmProfile } : {}),
	};
}

export function buildControllerStatus(
	systemConfig: SystemConfig,
	runtimeStatus: ControllerRuntimeStatus = {},
): ControllerStatusSummary {
	return {
		controllerPort: systemConfig.host.controllerPort,
		toolVmProfiles: Object.keys(systemConfig.toolVmProfiles),
		zones: systemConfig.zones.map((zone) => buildZoneStatus(zone, runtimeStatus)),
	};
}

export function buildControllerZoneStatus(
	systemConfig: SystemConfig,
	zoneId: string,
	runtimeStatus: ControllerRuntimeStatus = {},
): ControllerZoneStatusSummary {
	const zone = systemConfig.zones.find((configuredZone) => configuredZone.id === zoneId);
	if (!zone) {
		throw new Error(`Unknown zone '${zoneId}'.`);
	}
	return buildZoneStatus(zone, runtimeStatus);
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/operations/controller-status.test.ts
```

Expected: PASS for controller status tests.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/zone-runtimes/zone-runtime-errors.ts packages/agent-vm/src/operations/controller-status.ts packages/agent-vm/src/operations/controller-status.test.ts
git commit -m "feat: model per-zone controller status" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Define Typed Zone Runtime Interfaces

**Files:**
- Create: `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts`
- Test: `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts`

- [ ] **Step 1: Add a compile-oriented test for the registry contract**

Create `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts` with this first test:

```ts
import { describe, expect, it } from 'vitest';

import type {
	ControllerZoneRuntime,
	OpenClawZoneRuntime,
	WorkerZoneRuntime,
} from './zone-runtime-types.js';

describe('zone runtime contracts', () => {
	it('keeps OpenClaw and Worker runtimes behind one discriminated zone runtime interface', () => {
		const openClawRuntime = {
			gatewayType: 'openclaw',
			zoneId: 'shravan',
			getSnapshot: () => ({ lifecycleState: 'stopped' }),
			start: async () => {},
			stop: async () => {},
			restart: async () => {},
			getLogs: async () => ({ output: 'logs', zoneId: 'shravan' }),
			enableSsh: async () => ({ command: 'ssh root@127.0.0.1' }),
			exec: async () => ({ exitCode: 0, stderr: '', stdout: 'ok' }),
			refreshCredentials: async () => ({ ok: true, zoneId: 'shravan' }),
			upgrade: async () => ({ ok: true, zoneId: 'shravan' }),
			destroy: async () => ({ ok: true, purged: false, zoneId: 'shravan' }),
		} satisfies OpenClawZoneRuntime;

		const workerRuntime = {
			gatewayType: 'worker',
			zoneId: 'worker-zone',
			getSnapshot: () => ({ lifecycleState: 'stopped' }),
			shutdown: async () => {},
			destroy: async () => ({ ok: true, purged: false, zoneId: 'worker-zone' }),
			closeTaskForZone: async () => ({ status: 'closed' }),
			executeWorkerTask: async () => undefined,
			getTaskState: async () => null,
			prepareWorkerTask: async (input) => ({
				eventLogPath: '/tmp/events.jsonl',
				input,
				recordEvent: async () => {},
				taskId: 'task-1',
				taskRuntimeDir: '/tmp/runtime/task-1',
				zoneId: 'worker-zone',
			}),
			pullDefaultForTask: async () => ({ kind: 'advanced' }),
			pushTaskBranches: async () => ({ pushed: [] }),
		} satisfies WorkerZoneRuntime;

		const runtimes: readonly ControllerZoneRuntime[] = [openClawRuntime, workerRuntime];

		expect(runtimes.map((runtime) => runtime.gatewayType)).toEqual(['openclaw', 'worker']);
	});
});
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
```

Expected: FAIL because `zone-runtime-types.ts` does not exist.

- [ ] **Step 3: Add runtime interfaces**

Create `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts`:

```ts
import type { GatewayProcessSpec } from '@agent-vm/gateway-interface';
import type { ManagedVm, SecretResolver } from '@agent-vm/gondolin-adapter';
import type { TaskState } from '@agent-vm/agent-vm-worker';

import type { LoadedSystemConfig, SystemConfig } from '../../config/system-config.js';
import type { GatewayZoneStartResult } from '../../gateway/gateway-zone-support.js';
import type { RunTaskFn } from '../../shared/run-task.js';
import type { ActiveTaskRegistry } from '../active-task-registry.js';
import type { PullDefaultRequest } from '../git-pull-default-operations.js';
import type { PullDefaultResult } from '../git-pull-default-operations.js';
import type { PushBranchesResult } from '../git-push-operations.js';
import type { PushBranchRequest } from '../git-push-operations.js';
import type { LeaseManager, ToolVmProfile } from '../leases/lease-manager.js';
import type { RequestHeartbeatRegistry } from '../request-heartbeat-registry.js';
import type { PreparedWorkerTask, WorkerTaskInput } from '../worker-task-runner.js';
import type {
	ControllerRuntimeZoneStatus,
	ControllerZoneLifecycleState,
} from '../../operations/controller-status.js';

export type ControllerZoneConfig = SystemConfig['zones'][number];

export interface GatewayZoneRuntimeHandle {
	readonly ingress: GatewayZoneStartResult['ingress'];
	readonly processSpec: GatewayProcessSpec;
	readonly vm: Pick<ManagedVm, 'close' | 'enableSsh' | 'exec' | 'id'>;
}

export interface ControllerZoneRuntimeSnapshot extends ControllerRuntimeZoneStatus {
	readonly lifecycleState: ControllerZoneLifecycleState;
}

export interface ControllerZoneRuntimeBase {
	readonly gatewayType: ControllerZoneConfig['gateway']['type'];
	readonly zoneId: string;
	destroy(purge: boolean): Promise<{ readonly ok: true; readonly purged: boolean; readonly zoneId: string }>;
	getSnapshot(): ControllerZoneRuntimeSnapshot;
	shutdown(): Promise<void>;
}

export interface OpenClawZoneRuntime extends ControllerZoneRuntimeBase {
	readonly gatewayType: 'openclaw';
	enableSsh(): ReturnType<ManagedVm['enableSsh']>;
	exec(command: string): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }>;
	getLogs(): Promise<{ readonly output: string; readonly zoneId: string }>;
	refreshCredentials(): Promise<{ readonly ok: true; readonly zoneId: string }>;
	restart(): Promise<void>;
	start(): Promise<void>;
	stop(): Promise<void>;
	upgrade(): Promise<{ readonly ok: true; readonly zoneId: string }>;
}

export interface WorkerZoneRuntime extends ControllerZoneRuntimeBase {
	readonly gatewayType: 'worker';
	closeTaskForZone(
		taskId: string,
	): Promise<{ readonly status: 'closed' }>;
	executeWorkerTask(prepared: PreparedWorkerTask): Promise<unknown>;
	getTaskState(taskId: string): Promise<TaskState | null>;
	prepareWorkerTask(input: WorkerTaskInput): Promise<PreparedWorkerTask>;
	pullDefaultForTask(taskId: string, input: PullDefaultRequest): Promise<PullDefaultResult>;
	pushTaskBranches(
		taskId: string,
		input: { readonly branches: readonly PushBranchRequest[] },
	): Promise<PushBranchesResult>;
}

export type ControllerZoneRuntime = OpenClawZoneRuntime | WorkerZoneRuntime;

export interface SharedZoneRuntimeDependencies {
	readonly activeTaskRegistry: ActiveTaskRegistry;
	readonly controllerGithubToken: string | null;
	readonly createManagedToolVm: (options: {
		readonly profile: ToolVmProfile;
		readonly tcpSlot: number;
		readonly workspaceDir: string;
		readonly zoneId: string;
	}) => Promise<ManagedVm>;
	readonly deleteGatewayRuntimeRecord: (stateDirectory: string) => Promise<void>;
	readonly leaseManager: LeaseManager;
	readonly now: () => number;
	readonly requestHeartbeatRegistry: RequestHeartbeatRegistry;
	readonly runTask: RunTaskFn;
	readonly secretResolver: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
}
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
```

Expected: PASS for the runtime contract test.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
git commit -m "feat: define controller zone runtime contracts" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Implement OpenClaw Zone Runtime

**Files:**
- Create: `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`
- Test: `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts`

- [ ] **Step 1: Add OpenClaw runtime lifecycle tests**

Append to `zone-runtime-registry.test.ts`:

```ts
import { createOpenClawZoneRuntime } from './openclaw-zone-runtime.js';

describe('createOpenClawZoneRuntime', () => {
	it('starts, snapshots, reads logs, and stops one OpenClaw gateway zone', async () => {
		const close = vi.fn(async () => {});
		const exec = vi.fn(async (command: string) => ({
			exitCode: 0,
			stderr: '',
			stdout: command.startsWith('cat ') ? 'gateway log output' : 'command output',
		}));
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-04-30T10:00:00.000Z'),
			restartGatewayZone: async (zoneId) => {
				expect(zoneId).toBe('shravan');
				return {
					image: { fingerprint: 'fingerprint', imagePath: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/' },
						logPath: '/tmp/openclaw.log',
						startCommand: 'start',
					},
					vm: {
						close,
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({ command: 'ssh root@127.0.0.1' })),
						exec,
						getVmInstance: vi.fn(),
						id: 'vm-shravan',
						setIngressRoutes: vi.fn(),
					},
					zone: {
						...openClawZone,
						id: 'shravan',
					},
				};
			},
			runControllerCredentialsRefresh: async (_options, dependencies) => {
				await dependencies.refreshZoneSecrets('shravan');
				await dependencies.restartGatewayZone('shravan');
				return { ok: true, zoneId: 'shravan' };
			},
			runControllerDestroy: async (options, dependencies) => {
				await dependencies.stopGatewayZone(options.zoneId);
				await dependencies.releaseZoneLeases(options.zoneId);
				return { ok: true, purged: options.purge, zoneId: options.zoneId };
			},
			runControllerLogs: async (options, dependencies) => ({
				output: await dependencies.readGatewayLogs(options.zoneId),
				zoneId: options.zoneId,
			}),
			runControllerUpgrade: async (_options, dependencies) => {
				await dependencies.rebuildGatewayImage('shravan');
				await dependencies.restartGatewayZone('shravan');
				return { ok: true, zoneId: 'shravan' };
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			zone: openClawZone,
		});

		await runtime.start();

		expect(runtime.getSnapshot()).toMatchObject({
			bootedAt: '2026-04-30T10:00:00.000Z',
			gateway: {
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: { id: 'vm-shravan' },
			},
			lifecycleState: 'running',
		});
		await expect(runtime.getLogs()).resolves.toEqual({
			output: 'gateway log output',
			zoneId: 'shravan',
		});
		await runtime.stop();
		expect(close).toHaveBeenCalledTimes(1);
		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'stopped' });
	});

	it('records startup failure and keeps the zone inspectable', async () => {
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-04-30T10:00:00.000Z'),
			restartGatewayZone: async () => {
				throw new Error('gateway boot failed');
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			zone: openClawZone,
		});

		await expect(runtime.start()).rejects.toThrow("Failed to start zone 'shravan'");
		expect(runtime.getSnapshot()).toEqual({
			lastError: 'gateway boot failed',
			lifecycleState: 'failed',
		});
		await expect(runtime.getLogs()).rejects.toThrow(
			"Gateway runtime for zone 'shravan' is unavailable. Last error: gateway boot failed",
		);
	});
});
```

Add reusable fixtures near the top of the test file:

```ts
const openClawZone = systemConfig.zones.find((zone) => zone.id === 'shravan');
if (!openClawZone || openClawZone.gateway.type !== 'openclaw') {
	throw new Error('Expected shravan OpenClaw test zone.');
}
```

- [ ] **Step 2: Run the focused failing tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
```

Expected: FAIL because `createOpenClawZoneRuntime` does not exist.

- [ ] **Step 3: Implement OpenClaw runtime**

Create `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`:

```ts
import { resolveZoneSecrets } from '../../gateway/credential-manager.js';
import { deleteGatewayRuntimeRecord as deleteGatewayRuntimeRecordDefault } from '../../gateway/gateway-runtime-record.js';
import { startGatewayZone } from '../../gateway/gateway-zone-orchestrator.js';
import { runControllerCredentialsRefresh as runControllerCredentialsRefreshDefault } from '../../operations/credentials-refresh.js';
import { runControllerDestroy as runControllerDestroyDefault } from '../../operations/destroy-zone.js';
import { runControllerUpgrade as runControllerUpgradeDefault } from '../../operations/upgrade-zone.js';
import { runControllerLogs as runControllerLogsDefault } from '../../operations/zone-logs.js';
import {
	ControllerZoneRuntimeStartError,
	ControllerZoneRuntimeUnavailableError,
} from './zone-runtime-errors.js';
import type {
	ControllerZoneConfig,
	GatewayZoneStartResult,
	GatewayZoneRuntimeHandle,
	OpenClawZoneRuntime,
	SharedZoneRuntimeDependencies,
} from './zone-runtime-types.js';

interface CreateOpenClawZoneRuntimeOptions
	extends Pick<
		SharedZoneRuntimeDependencies,
		'leaseManager' | 'now' | 'secretResolver' | 'systemConfig'
	> {
	readonly deleteGatewayRuntimeRecord?: (stateDirectory: string) => Promise<void>;
	readonly restartGatewayZone?: (zoneId: string) => Promise<GatewayZoneStartResult>;
	readonly runControllerCredentialsRefresh?: typeof runControllerCredentialsRefreshDefault;
	readonly runControllerDestroy?: typeof runControllerDestroyDefault;
	readonly runControllerLogs?: typeof runControllerLogsDefault;
	readonly runControllerUpgrade?: typeof runControllerUpgradeDefault;
	readonly zone: ControllerZoneConfig & { readonly gateway: Extract<ControllerZoneConfig['gateway'], { readonly type: 'openclaw' }> };
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createOpenClawZoneRuntime(options: CreateOpenClawZoneRuntimeOptions): OpenClawZoneRuntime {
	let gateway: GatewayZoneRuntimeHandle | undefined;
	let bootedAt: string | undefined;
	let lastError: string | undefined;

	const startGateway = async (): Promise<GatewayZoneRuntimeHandle> =>
		options.restartGatewayZone
			? await options.restartGatewayZone(options.zone.id)
			: await startGatewayZone({
					secretResolver: options.secretResolver,
					systemConfig: options.systemConfig,
					zoneId: options.zone.id,
				});

	const requireGateway = (): GatewayZoneRuntimeHandle => {
		if (!gateway) {
			throw new ControllerZoneRuntimeUnavailableError(options.zone.id, lastError);
		}
		return gateway;
	};

	const stop = async (): Promise<void> => {
		const activeGateway = gateway;
		gateway = undefined;
		bootedAt = undefined;
		lastError = undefined;
		if (activeGateway) {
			await activeGateway.vm.close();
		}
		await (options.deleteGatewayRuntimeRecord ?? deleteGatewayRuntimeRecordDefault)(
			options.zone.gateway.stateDir,
		);
	};

	const start = async (): Promise<void> => {
		try {
			const startedGateway = await startGateway();
			gateway = startedGateway;
			bootedAt = new Date(options.now()).toISOString();
			lastError = undefined;
		} catch (error) {
			gateway = undefined;
			bootedAt = undefined;
			lastError = formatUnknownError(error);
			throw new ControllerZoneRuntimeStartError(options.zone.id, error);
		}
	};

	const restart = async (): Promise<void> => {
		await stop();
		await start();
	};

	return {
		gatewayType: 'openclaw',
		zoneId: options.zone.id,
		start,
		stop,
		shutdown: stop,
		restart,
		getSnapshot: () =>
			gateway
				? {
						bootedAt,
						gateway: {
							ingress: gateway.ingress,
							vm: { id: gateway.vm.id },
						},
						lifecycleState: 'running',
					}
				: lastError
					? { lastError, lifecycleState: 'failed' }
					: { lifecycleState: 'stopped' },
		enableSsh: async () => await requireGateway().vm.enableSsh(),
		exec: async (command) => await requireGateway().vm.exec(command),
		getLogs: async () => {
			const activeGateway = requireGateway();
			return await (options.runControllerLogs ?? runControllerLogsDefault)(
				{ zoneId: options.zone.id },
				{
					readGatewayLogs: async () =>
						(await activeGateway.vm.exec(`cat ${activeGateway.processSpec.logPath} 2>/dev/null || echo ""`))
							.stdout,
				},
			);
		},
		refreshCredentials: async () =>
			await (options.runControllerCredentialsRefresh ?? runControllerCredentialsRefreshDefault)(
				{ zoneId: options.zone.id },
				{
					refreshZoneSecrets: async (zoneId) => {
						await resolveZoneSecrets({
							secretResolver: options.secretResolver,
							systemConfig: options.systemConfig,
							zoneId,
						});
					},
					restartGatewayZone: async () => await restart(),
				},
			),
		upgrade: async () =>
			await (options.runControllerUpgrade ?? runControllerUpgradeDefault)(
				{ systemConfig: options.systemConfig, zoneId: options.zone.id },
				{
					rebuildGatewayImage: async () => {},
					restartGatewayZone: async () => await restart(),
				},
			),
		destroy: async (purge) =>
			await (options.runControllerDestroy ?? runControllerDestroyDefault)(
				{ purge, systemConfig: options.systemConfig, zoneId: options.zone.id },
				{
					releaseZoneLeases: async (zoneId) => {
						for (const lease of options.leaseManager
							.listLeases()
							.filter((activeLease) => activeLease.zoneId === zoneId)) {
							await options.leaseManager.releaseLease(lease.id);
						}
					},
					stopGatewayZone: async () => await stop(),
				},
			),
	};
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
```

Expected: PASS for OpenClaw runtime tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
git commit -m "feat: add OpenClaw zone runtime" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Implement Worker Zone Runtime

**Files:**
- Create: `packages/agent-vm/src/controller/zone-runtimes/worker-zone-runtime.ts`
- Test: `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts`

- [ ] **Step 1: Add worker runtime tests**

Append to `zone-runtime-registry.test.ts`:

```ts
import { createWorkerZoneRuntime } from './worker-zone-runtime.js';

const workerZone = systemConfig.zones.find((zone) => zone.id === 'worker-zone');
if (!workerZone || workerZone.gateway.type !== 'worker') {
	throw new Error('Expected worker test zone.');
}

describe('createWorkerZoneRuntime', () => {
	it('prepares worker tasks through the worker runtime and reports stopped lifecycle state', async () => {
		const prepareWorkerTask = vi.fn(async (options) => ({
			input: options.input,
			taskId: 'task-1',
			zoneId: options.zoneId,
		}));
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: {
				tryReserve: vi.fn(() => 'reservation-1'),
				activateReservation: vi.fn(),
				releaseReservation: vi.fn(),
				clear: vi.fn(),
				get: vi.fn(),
				listForZone: vi.fn(() => []),
				setWorkerIngress: vi.fn(),
			},
			controllerGithubToken: null,
			executeWorkerTask: vi.fn(async () => undefined),
			prepareWorkerTask,
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
				stopAll: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			zone: workerZone,
		});

		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'stopped' });
		await expect(
			runtime.prepareWorkerTask({
				context: {},
				prompt: 'test',
				repos: [],
				requestTaskId: 'request-1',
				resources: { externalResources: {} },
			}),
		).resolves.toMatchObject({
			taskId: 'task-1',
			zoneId: 'worker-zone',
		});
		expect(prepareWorkerTask).toHaveBeenCalledWith(
			expect.objectContaining({
				zoneId: 'worker-zone',
			}),
		);
	});

	it('destroys worker zone runtime by clearing active tasks for that zone', async () => {
		const clear = vi.fn();
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: {
				tryReserve: vi.fn(() => 'reservation-1'),
				activateReservation: vi.fn(),
				releaseReservation: vi.fn(),
				clear,
				get: vi.fn(),
				listForZone: vi.fn(() => [
					createActiveWorkerTask('task-1'),
					createActiveWorkerTask('task-2'),
				]),
				setWorkerIngress: vi.fn(),
			},
			controllerGithubToken: null,
			executeWorkerTask: vi.fn(async () => undefined),
			prepareWorkerTask: vi.fn(),
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
				stopAll: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			zone: workerZone,
		});

		await expect(runtime.destroy(false)).resolves.toEqual({
			ok: true,
			purged: false,
			zoneId: 'worker-zone',
		});
		expect(clear).toHaveBeenCalledWith('worker-zone', 'task-1');
		expect(clear).toHaveBeenCalledWith('worker-zone', 'task-2');
	});

	it('does not clear active worker tasks during normal shutdown', async () => {
		const clear = vi.fn();
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: {
				tryReserve: vi.fn(() => 'reservation-1'),
				activateReservation: vi.fn(),
				releaseReservation: vi.fn(),
				clear,
				get: vi.fn(),
				listForZone: vi.fn(() => [createActiveWorkerTask('task-1')]),
				setWorkerIngress: vi.fn(),
			},
			controllerGithubToken: null,
			executeWorkerTask: vi.fn(async () => undefined),
			prepareWorkerTask: vi.fn(),
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
				stopAll: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			zone: workerZone,
		});

		await runtime.shutdown();

		expect(clear).not.toHaveBeenCalled();
	});
});

function createActiveWorkerTask(taskId: string) {
	return {
		branchPrefix: `agent-vm/${taskId}`,
		eventLogPath: `/tmp/${taskId}/events.jsonl`,
		repos: [],
		taskId,
		taskRoot: `/tmp/${taskId}`,
		workerIngress: null,
		zoneId: 'worker-zone',
	};
}
```

- [ ] **Step 2: Run the focused failing tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
```

Expected: FAIL because `createWorkerZoneRuntime` does not exist.

- [ ] **Step 3: Implement Worker runtime by moving existing worker closures behind one object**

Create `packages/agent-vm/src/controller/zone-runtimes/worker-zone-runtime.ts`:

```ts
import { appendEvent, type TaskEvent } from '@agent-vm/agent-vm-worker';

import {
	pullDefaultForTask,
	PullDefaultValidationError,
	type PullDefaultRequest,
} from '../git-pull-default-operations.js';
import {
	pushBranchesForTask,
	PushBranchesValidationError,
	type PushBranchRequest,
} from '../git-push-operations.js';
import { ControllerRuntimeAtCapacityError, ControllerTaskNotReadyError } from '../http/controller-http-route-support.js';
import { createTaskStateReader } from '../task-state-reader.js';
import {
	executeWorkerTask as executeWorkerTaskDefault,
	type PreparedWorkerTask,
	prepareWorkerTask as prepareWorkerTaskDefault,
	type WorkerTaskInput,
} from '../worker-task-runner.js';
import type {
	ControllerZoneConfig,
	WorkerZoneRuntime,
} from './zone-runtime-types.js';
import type { ActiveTaskRegistry } from '../active-task-registry.js';
import type { RequestHeartbeatRegistry } from '../request-heartbeat-registry.js';
import type { LoadedSystemConfig } from '../../config/system-config.js';

const MAX_ACTIVE_TASKS_PER_RUNTIME = 1;

interface CreateWorkerZoneRuntimeOptions {
	readonly activeTaskRegistry: Pick<ActiveTaskRegistry, 'activateReservation' | 'clear' | 'get' | 'listForZone' | 'releaseReservation' | 'setWorkerIngress' | 'tryReserve'>;
	readonly controllerGithubToken: string | null;
	readonly executeWorkerTask?: (
		prepared: PreparedWorkerTask,
		dependencies: Parameters<typeof executeWorkerTaskDefault>[1],
	) => ReturnType<typeof executeWorkerTaskDefault>;
	readonly onWorkerTaskFinished?: (zoneId: string, taskId: string) => void | Promise<void>;
	readonly onWorkerTaskIngress?: (
		zoneId: string,
		taskId: string,
		workerIngress: { readonly host: string; readonly port: number },
	) => void | Promise<void>;
	readonly onWorkerTaskPrepared?: (task: unknown) => void | Promise<void>;
	readonly prepareWorkerTask?: typeof prepareWorkerTaskDefault;
	readonly requestHeartbeatRegistry: Pick<RequestHeartbeatRegistry, 'acquire' | 'release'>;
	readonly secretResolver: import('@agent-vm/gondolin-adapter').SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
	readonly zone: ControllerZoneConfig & { readonly gateway: Extract<ControllerZoneConfig['gateway'], { readonly type: 'worker' }> };
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function recordActiveTaskEvent(options: {
	readonly event: TaskEvent;
	readonly eventLogPath: string;
	readonly taskId: string;
}): Promise<void> {
	await appendEvent(options.eventLogPath, options.event);
}

export function createWorkerZoneRuntime(options: CreateWorkerZoneRuntimeOptions): WorkerZoneRuntime {
	const readTaskState = createTaskStateReader({ systemConfig: options.systemConfig }).read;

	return {
		gatewayType: 'worker',
		zoneId: options.zone.id,
		getSnapshot: () => ({ lifecycleState: 'stopped' }),
		shutdown: async () => {},
		destroy: async (purge) => {
			for (const activeTask of options.activeTaskRegistry.listForZone(options.zone.id)) {
				options.activeTaskRegistry.clear(activeTask.zoneId, activeTask.taskId);
			}
			return { ok: true, purged: purge, zoneId: options.zone.id };
		},
		prepareWorkerTask: async (input: WorkerTaskInput) => {
			const reservationId = options.activeTaskRegistry.tryReserve(
				options.zone.id,
				MAX_ACTIVE_TASKS_PER_RUNTIME,
			);
			if (!reservationId) {
				throw new ControllerRuntimeAtCapacityError(
					`Worker pod for zone '${options.zone.id}' is at capacity.`,
				);
			}
			try {
				return await (options.prepareWorkerTask ?? prepareWorkerTaskDefault)({
					input,
					systemConfig: options.systemConfig,
					zoneId: options.zone.id,
					...(options.controllerGithubToken ? { githubToken: options.controllerGithubToken } : {}),
					onTaskPrepared: async (task) => {
						options.activeTaskRegistry.activateReservation(options.zone.id, reservationId, task);
						await options.onWorkerTaskPrepared?.(task);
					},
				});
			} catch (error) {
				options.activeTaskRegistry.releaseReservation(options.zone.id, reservationId);
				throw error;
			}
		},
		executeWorkerTask: async (prepared: PreparedWorkerTask) => {
			let heartbeatAcquired = false;
			try {
				const callerUrl = process.env.CALLER_URL;
				if (callerUrl) {
					options.requestHeartbeatRegistry.acquire(prepared.input.requestTaskId, callerUrl);
					heartbeatAcquired = true;
				}
				return await (options.executeWorkerTask ?? executeWorkerTaskDefault)(prepared, {
					secretResolver: options.secretResolver,
					systemConfig: options.systemConfig,
					onWorkerTaskIngress: async (zoneId, taskId, workerIngress) => {
						options.activeTaskRegistry.setWorkerIngress(zoneId, taskId, workerIngress);
						await options.onWorkerTaskIngress?.(zoneId, taskId, workerIngress);
					},
					onTaskFinished: async (zoneId, taskId) => {
						options.activeTaskRegistry.clear(zoneId, taskId);
						await options.onWorkerTaskFinished?.(zoneId, taskId);
					},
				});
			} catch (error) {
				if (options.activeTaskRegistry.get(prepared.zoneId, prepared.taskId)) {
					options.activeTaskRegistry.clear(prepared.zoneId, prepared.taskId);
				}
				throw error;
			} finally {
				if (heartbeatAcquired) {
					options.requestHeartbeatRegistry.release(prepared.input.requestTaskId);
				}
			}
		},
		getTaskState: async (taskId) => await readTaskState(options.zone.id, taskId),
		closeTaskForZone: async (taskId) => {
			const activeTask = options.activeTaskRegistry.get(options.zone.id, taskId);
			if (!activeTask) {
				throw new Error(`Task '${taskId}' is not active for zone '${options.zone.id}'.`);
			}
			if (!activeTask.workerIngress) {
				throw new ControllerTaskNotReadyError(
					`Task '${taskId}' in zone '${options.zone.id}' does not have a worker ingress yet.`,
				);
			}
			const response = await fetch(
				`http://${activeTask.workerIngress.host}:${String(activeTask.workerIngress.port)}/tasks/${taskId}/close`,
				{ method: 'POST' },
			);
			if (!response.ok) {
				throw new Error(`worker close returned HTTP ${String(response.status)}`);
			}
			return { status: 'closed' };
		},
		pushTaskBranches: async (
			taskId: string,
			input: { readonly branches: readonly PushBranchRequest[] },
		) => {
			const activeTask = options.activeTaskRegistry.get(options.zone.id, taskId);
			if (!activeTask) {
				throw new PushBranchesValidationError(
					`Task '${taskId}' is not active for zone '${options.zone.id}'.`,
				);
			}
			if (!options.controllerGithubToken) {
				throw new Error(
					'Controller GitHub token is not configured. Set host.githubToken or process.env.GITHUB_TOKEN.',
				);
			}
			return await pushBranchesForTask({
				activeTask,
				branches: input.branches,
				githubToken: options.controllerGithubToken,
				recordEvent: async (event) => {
					await recordActiveTaskEvent({
						event,
						eventLogPath: activeTask.eventLogPath,
						taskId,
					}).catch((error) => {
						throw new Error(formatUnknownError(error));
					});
				},
			});
		},
		pullDefaultForTask: async (taskId: string, input: PullDefaultRequest) => {
			const activeTask = options.activeTaskRegistry.get(options.zone.id, taskId);
			if (!activeTask) {
				throw new PullDefaultValidationError(
					`Task '${taskId}' is not active for zone '${options.zone.id}'.`,
				);
			}
			if (!options.controllerGithubToken) {
				throw new Error(
					'Controller GitHub token is not configured. Set host.githubToken or process.env.GITHUB_TOKEN.',
				);
			}
			return await pullDefaultForTask({
				activeTask,
				...(input.currentBranch !== undefined ? { currentBranch: input.currentBranch } : {}),
				...(input.currentHead !== undefined ? { currentHead: input.currentHead } : {}),
				repoUrl: input.repoUrl,
				githubToken: options.controllerGithubToken,
				recordEvent: async (event) => {
					await recordActiveTaskEvent({
						event,
						eventLogPath: activeTask.eventLogPath,
						taskId,
					});
				},
				...(input.worktreeDirty !== undefined ? { worktreeDirty: input.worktreeDirty } : {}),
			});
		},
	};
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
pnpm typecheck
```

Expected: Runtime tests pass and typecheck exits `0`. `CreateWorkerZoneRuntimeOptions.activeTaskRegistry` must use the concrete `ActiveTaskRegistry` methods `tryReserve`, `activateReservation`, `releaseReservation`, `get`, `listForZone`, `setWorkerIngress`, and `clear`.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/zone-runtimes/worker-zone-runtime.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
git commit -m "feat: add worker zone runtime" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Implement Zone Runtime Registry With Partial Start

**Files:**
- Create: `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.ts`
- Test: `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts`

- [ ] **Step 1: Add registry tests for partial start and per-zone dispatch**

Append to `zone-runtime-registry.test.ts`:

```ts
import { createZoneRuntimeRegistry } from './zone-runtime-registry.js';

describe('createZoneRuntimeRegistry', () => {
	it('starts all selected zones with partial-start semantics', async () => {
		const shravanRuntime = createFakeOpenClawRuntime('shravan');
		const alevtinaRuntime = createFakeOpenClawRuntime('alevtina', {
			getSnapshot: () => ({
				lastError: 'alevtina boot failed',
				lifecycleState: 'failed',
			}),
			start: async () => {
				throw new Error('alevtina boot failed');
			},
		});
		const registry = createZoneRuntimeRegistry({
			createRuntimeForZone: (zone) =>
				zone.id === 'shravan' ? shravanRuntime : alevtinaRuntime,
			systemConfig: {
				...systemConfig,
				zones: [openClawZone, { ...openClawZone, id: 'alevtina' }],
			},
			zoneIds: ['shravan', 'alevtina'],
		});

		await registry.startSelectedZones();

		expect(registry.getSnapshotByZone()).toEqual({
			shravan: { lifecycleState: 'running' },
			alevtina: {
				lastError: 'alevtina boot failed',
				lifecycleState: 'failed',
			},
		});
		await expect(registry.getOpenClawRuntime('shravan').getLogs()).resolves.toEqual({
			output: 'logs for shravan',
			zoneId: 'shravan',
		});
		await expect(registry.getOpenClawRuntime('alevtina').getLogs()).rejects.toThrow(
			"Gateway runtime for zone 'alevtina' is unavailable",
		);
	});

	it('rejects unsupported operations by target zone type', () => {
		const registry = createZoneRuntimeRegistry({
			createRuntimeForZone: (zone) =>
				zone.gateway.type === 'worker'
					? createFakeWorkerRuntime(zone.id)
					: createFakeOpenClawRuntime(zone.id),
			systemConfig,
			zoneIds: ['shravan', 'worker-zone'],
		});

		expect(() => registry.getOpenClawRuntime('worker-zone')).toThrow(
			"Zone 'worker-zone' with gateway type 'worker' does not support OpenClaw operations.",
		);
		expect(() => registry.getWorkerRuntime('shravan')).toThrow(
			"Zone 'shravan' with gateway type 'openclaw' does not support worker operations.",
		);
		expect(() => registry.getRuntime('missing-zone')).toThrow("Unknown zone 'missing-zone'.");
	});
});
```

Add helpers:

```ts
function createFakeOpenClawRuntime(
	zoneId: string,
	overrides: Partial<OpenClawZoneRuntime> = {},
): OpenClawZoneRuntime {
	let lifecycleState: 'running' | 'failed' | 'stopped' = 'stopped';
	let lastError: string | undefined;
	return {
		gatewayType: 'openclaw',
		zoneId,
		start: overrides.start ?? (async () => {
			lifecycleState = 'running';
			lastError = undefined;
		}),
		stop: async () => {
			lifecycleState = 'stopped';
		},
		restart: async () => {},
		getSnapshot: () =>
			lastError
				? { lastError, lifecycleState: 'failed' }
				: { lifecycleState },
		shutdown: async () => {
			lifecycleState = 'stopped';
		},
		getLogs: async () => ({ output: `logs for ${zoneId}`, zoneId }),
		enableSsh: async () => ({}),
		exec: async () => ({ exitCode: 0, stderr: '', stdout: zoneId }),
		refreshCredentials: async () => ({ ok: true, zoneId }),
		upgrade: async () => ({ ok: true, zoneId }),
		destroy: async (purged) => ({ ok: true, purged, zoneId }),
		...overrides,
	};
}

function createFakeWorkerRuntime(zoneId: string): WorkerZoneRuntime {
	return {
		gatewayType: 'worker',
		zoneId,
		getSnapshot: () => ({ lifecycleState: 'stopped' }),
		shutdown: async () => {},
		closeTaskForZone: async () => ({ status: 'closed' }),
		destroy: async (purged) => ({ ok: true, purged, zoneId }),
		executeWorkerTask: async () => ({}),
		getTaskState: async () => null,
		prepareWorkerTask: async (input) => ({
			eventLogPath: '/tmp/events.jsonl',
			input,
			recordEvent: async () => {},
			taskId: 'task-1',
			taskRuntimeDir: '/tmp/runtime/task-1',
			zoneId,
		}),
		pullDefaultForTask: async () => ({}),
		pushTaskBranches: async () => ({}),
	};
}
```

- [ ] **Step 2: Run the focused failing tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
```

Expected: FAIL because `createZoneRuntimeRegistry` does not exist.

- [ ] **Step 3: Implement registry**

Create `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.ts`:

```ts
import type { LoadedSystemConfig } from '../../config/system-config.js';
import { findConfiguredZone } from '../controller-runtime-support.js';
import {
	ControllerZoneNotFoundError,
	ControllerZoneOperationUnsupportedError,
} from './zone-runtime-errors.js';
import type {
	ControllerZoneRuntime,
	ControllerZoneRuntimeSnapshot,
	OpenClawZoneRuntime,
	WorkerZoneRuntime,
} from './zone-runtime-types.js';

export interface ZoneRuntimeRegistry {
	readonly selectedZoneIds: readonly string[];
	getOpenClawRuntime(zoneId: string): OpenClawZoneRuntime;
	getRuntime(zoneId: string): ControllerZoneRuntime;
	getSnapshotByZone(): Readonly<Record<string, ControllerZoneRuntimeSnapshot>>;
	getWorkerRuntime(zoneId: string): WorkerZoneRuntime;
	startSelectedZones(): Promise<void>;
	stopAllZones(): Promise<void>;
}

export function createZoneRuntimeRegistry(options: {
	readonly createRuntimeForZone: (
		zone: LoadedSystemConfig['zones'][number],
	) => ControllerZoneRuntime;
	readonly startupFailures?: readonly {
		readonly lastError: string;
		readonly zoneId: string;
	}[];
	readonly systemConfig: LoadedSystemConfig;
	readonly zoneIds?: readonly string[];
}): ZoneRuntimeRegistry {
	const runtimeZoneIds = options.zoneIds ?? options.systemConfig.zones.map((zone) => zone.id);
	const startupFailuresByZoneId = new Map(
		(options.startupFailures ?? []).map((failure) => [failure.zoneId, failure]),
	);
	const selectedZoneIds = [
		...runtimeZoneIds,
		...startupFailuresByZoneId.keys(),
	];
	const runtimesByZoneId = new Map<string, ControllerZoneRuntime>();

	for (const zoneId of runtimeZoneIds) {
		const zone = findConfiguredZone(options.systemConfig, zoneId);
		runtimesByZoneId.set(zoneId, options.createRuntimeForZone(zone));
	}

	const getRuntime = (zoneId: string): ControllerZoneRuntime => {
		const runtime = runtimesByZoneId.get(zoneId);
		if (!runtime) {
			throw new ControllerZoneNotFoundError(zoneId);
		}
		return runtime;
	};

	return {
		selectedZoneIds,
		getRuntime,
		getOpenClawRuntime(zoneId) {
			const runtime = getRuntime(zoneId);
			if (runtime.gatewayType !== 'openclaw') {
				throw new ControllerZoneOperationUnsupportedError(
					zoneId,
					'OpenClaw operations',
					runtime.gatewayType,
				);
			}
			return runtime;
		},
		getWorkerRuntime(zoneId) {
			const runtime = getRuntime(zoneId);
			if (runtime.gatewayType !== 'worker') {
				throw new ControllerZoneOperationUnsupportedError(
					zoneId,
					'worker operations',
					runtime.gatewayType,
				);
			}
			return runtime;
		},
		getSnapshotByZone() {
			return {
				...Object.fromEntries(
					[...startupFailuresByZoneId.entries()].map(([zoneId, failure]) => [
						zoneId,
						{
							lastError: failure.lastError,
							lifecycleState: 'failed',
						},
					]),
				),
				...Object.fromEntries(
					[...runtimesByZoneId.entries()].map(([zoneId, runtime]) => [
						zoneId,
						runtime.getSnapshot(),
					]),
				),
			};
		},
		async startSelectedZones() {
			for (const runtime of runtimesByZoneId.values()) {
				if (runtime.gatewayType !== 'openclaw') {
					continue;
				}
				try {
					await runtime.start();
				} catch {
					// Partial start: failed runtimes keep their own lastError snapshot.
				}
			}
		},
		async stopAllZones() {
			const stopErrors: Error[] = [];
			for (const runtime of runtimesByZoneId.values()) {
				try {
					await runtime.shutdown();
				} catch (error) {
					stopErrors.push(error instanceof Error ? error : new Error(String(error)));
				}
			}
			if (stopErrors.length > 0) {
				throw new AggregateError(stopErrors, 'Failed to stop one or more gateway zones.');
			}
		},
	};
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
git commit -m "feat: add zone runtime registry" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Route Controller Operations Through the Registry

**Files:**
- Modify: `packages/agent-vm/src/controller/controller-runtime-operations.ts`
- Test: `packages/agent-vm/src/controller/controller-runtime-operations.test.ts`

- [ ] **Step 1: Replace active-zone tests with registry dispatch tests**

In `controller-runtime-operations.test.ts`, add or replace tests with:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createControllerRuntimeOperations } from './controller-runtime-operations.js';
import type { OpenClawZoneRuntime } from './zone-runtimes/zone-runtime-types.js';

describe('createControllerRuntimeOperations', () => {
	it('dispatches OpenClaw operations to the requested zone runtime', async () => {
		const shravanRuntime = {
			enableSsh: vi.fn(async () => ({ command: 'ssh shravan' })),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'shravan' })),
			getLogs: vi.fn(async () => ({ output: 'shravan logs', zoneId: 'shravan' })),
			refreshCredentials: vi.fn(async () => ({ ok: true, zoneId: 'shravan' })),
			upgrade: vi.fn(async () => ({ ok: true, zoneId: 'shravan' })),
			destroy: vi.fn(async (purged: boolean) => ({ ok: true, purged, zoneId: 'shravan' })),
		} satisfies Pick<
			OpenClawZoneRuntime,
			'destroy' | 'enableSsh' | 'exec' | 'getLogs' | 'refreshCredentials' | 'upgrade'
		>;
		const alevtinaRuntime = {
			enableSsh: vi.fn(async () => ({ command: 'ssh alevtina' })),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'alevtina' })),
			getLogs: vi.fn(async () => ({ output: 'alevtina logs', zoneId: 'alevtina' })),
			refreshCredentials: vi.fn(async () => ({ ok: true, zoneId: 'alevtina' })),
			upgrade: vi.fn(async () => ({ ok: true, zoneId: 'alevtina' })),
			destroy: vi.fn(async (purged: boolean) => ({ ok: true, purged, zoneId: 'alevtina' })),
		} satisfies Pick<
			OpenClawZoneRuntime,
			'destroy' | 'enableSsh' | 'exec' | 'getLogs' | 'refreshCredentials' | 'upgrade'
		>;
		const operations = createControllerRuntimeOperations({
			getActiveLeases: () => [],
			getRuntimeStatusByZone: () => ({
				shravan: { lifecycleState: 'running' },
				alevtina: { lifecycleState: 'running' },
			}),
			getOpenClawRuntime: (zoneId) =>
				zoneId === 'shravan'
					? shravanRuntime
					: alevtinaRuntime,
			systemConfig,
		});

		await expect(operations.getZoneLogs('alevtina')).resolves.toEqual({
			output: 'alevtina logs',
			zoneId: 'alevtina',
		});
		await expect(operations.execInZone('shravan', 'pwd')).resolves.toEqual({
			exitCode: 0,
			stderr: '',
			stdout: 'shravan',
		});
		await expect(operations.destroyZone('alevtina', true)).resolves.toEqual({
			ok: true,
			purged: true,
			zoneId: 'alevtina',
		});

		expect(alevtinaRuntime.getLogs).toHaveBeenCalledTimes(1);
		expect(shravanRuntime.exec).toHaveBeenCalledWith('pwd');
		expect(alevtinaRuntime.destroy).toHaveBeenCalledWith(true);
	});
});
```

- [ ] **Step 2: Run failing operation tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/controller-runtime-operations.test.ts
```

Expected: FAIL because `createControllerRuntimeOperations` still requires `activeZoneId`.

- [ ] **Step 3: Replace operation implementation**

Update `packages/agent-vm/src/controller/controller-runtime-operations.ts` so `createControllerRuntimeOperations` takes:

```ts
export function createControllerRuntimeOperations(options: {
	readonly getActiveLeases: () => readonly { readonly zoneId: string }[];
	readonly getOpenClawRuntime: (zoneId: string) => Pick<
		OpenClawZoneRuntime,
		'destroy' | 'enableSsh' | 'exec' | 'getLogs' | 'refreshCredentials' | 'upgrade'
	>;
	readonly getRuntime: (zoneId: string) => Pick<ControllerZoneRuntime, 'destroy'>;
	readonly getRuntimeStatusByZone: () => ControllerRuntimeStatus['zones'];
	readonly systemConfig: SystemConfig;
}): ControllerRuntimeOperations {
	const buildRuntimeStatus = (): ControllerRuntimeStatus => ({
		activeLeases: options.getActiveLeases(),
		zones: options.getRuntimeStatusByZone(),
	});

	return {
		enableSshForZone: async (targetZoneId) =>
			await options.getOpenClawRuntime(targetZoneId).enableSsh(),
		execInZone: async (targetZoneId, command) =>
			await options.getOpenClawRuntime(targetZoneId).exec(command),
		destroyZone: async (targetZoneId, purge) =>
			await options.getRuntime(targetZoneId).destroy(purge),
		getStatus: async () => buildControllerStatus(options.systemConfig, buildRuntimeStatus()),
		getZoneStatus: async (targetZoneId) =>
			buildControllerZoneStatus(options.systemConfig, targetZoneId, buildRuntimeStatus()),
		getZoneLogs: async (targetZoneId) =>
			await options.getOpenClawRuntime(targetZoneId).getLogs(),
		refreshZoneCredentials: async (targetZoneId) =>
			await options.getOpenClawRuntime(targetZoneId).refreshCredentials(),
		upgradeZone: async (targetZoneId) =>
			await options.getOpenClawRuntime(targetZoneId).upgrade(),
	};
}
```

Keep `createStopControllerOperation`, but change its options from one `stopGatewayZone` to `stopAllZones`.

```ts
export function createStopControllerOperation(options: {
	readonly clearReaperTimer: () => void;
	readonly closeControllerServer: () => void;
	readonly getLeases: () => readonly { readonly id: string }[];
	readonly releaseLease: (leaseId: string) => Promise<void>;
	readonly stopAllZones: () => Promise<void>;
}): () => Promise<{ readonly ok: true }> {
	return async (): Promise<{ readonly ok: true }> => {
		options.clearReaperTimer();
		for (const lease of options.getLeases()) {
			await options.releaseLease(lease.id);
		}
		try {
			await options.stopAllZones();
		} finally {
			options.closeControllerServer();
		}
		return { ok: true } as const;
	};
}
```

- [ ] **Step 4: Run operation tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/controller-runtime-operations.test.ts packages/agent-vm/src/operations/controller-status.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/controller-runtime-operations.ts packages/agent-vm/src/controller/controller-runtime-operations.test.ts
git commit -m "feat: dispatch controller operations by zone runtime" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Wire Registry Into Controller Runtime

**Files:**
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts`
- Test: `packages/agent-vm/src/controller/controller-runtime.test.ts`

- [ ] **Step 1: Add controller runtime tests for two OpenClaw zones and partial start**

Add tests to `controller-runtime.test.ts`:

```ts
it('starts multiple OpenClaw zones in one controller process and routes logs by zone', async () => {
	const twoZoneConfig = {
		...systemConfig,
		zones: [
			systemConfig.zones[0],
			{
				...systemConfig.zones[0],
				id: 'alevtina',
				gateway: {
					...systemConfig.zones[0].gateway,
					port: 18792,
					stateDir: './state/alevtina',
					zoneFilesDir: './zone-files/alevtina',
				},
			},
		],
	};
	const startGatewayZone = vi.fn(async ({ zoneId }) => createStartedGateway(zoneId));
	let app: { request(path: string, init?: RequestInit): Response | Promise<Response> } | undefined;
	const runtime = await startControllerRuntime(
		{ systemConfig: twoZoneConfig },
		{
			createSecretResolver: async () => ({ resolve: async () => '', resolveAll: async () => ({}) }),
			startGatewayZone,
			startHttpServer: async (options) => {
				app = options.app;
				return { close: async () => {} };
			},
			setIntervalImpl: vi.fn(() => fakeInterval),
			clearIntervalImpl: vi.fn(),
		},
	);

	expect(startGatewayZone).toHaveBeenCalledWith(expect.objectContaining({ zoneId: 'shravan' }));
	expect(startGatewayZone).toHaveBeenCalledWith(expect.objectContaining({ zoneId: 'alevtina' }));
	expect(runtime.zones).toEqual([
		expect.objectContaining({ zoneId: 'shravan' }),
		expect.objectContaining({ zoneId: 'alevtina' }),
	]);

	const shravanLogs = await app?.request('/zones/shravan/logs');
	const alevtinaLogs = await app?.request('/zones/alevtina/logs');
	await expect(shravanLogs?.json()).resolves.toEqual({ output: 'logs for shravan', zoneId: 'shravan' });
	await expect(alevtinaLogs?.json()).resolves.toEqual({ output: 'logs for alevtina', zoneId: 'alevtina' });

	await runtime.close();
});

it('partially starts when one selected OpenClaw zone fails', async () => {
	const twoZoneConfig = {
		...systemConfig,
		zones: [
			systemConfig.zones[0],
			{
				...systemConfig.zones[0],
				id: 'alevtina',
				gateway: {
					...systemConfig.zones[0].gateway,
					port: 18792,
					stateDir: './state/alevtina',
					zoneFilesDir: './zone-files/alevtina',
				},
			},
		],
	};
	let app: { request(path: string, init?: RequestInit): Response | Promise<Response> } | undefined;
	const runtime = await startControllerRuntime(
		{ systemConfig: twoZoneConfig },
		{
			createSecretResolver: async () => ({ resolve: async () => '', resolveAll: async () => ({}) }),
			startGatewayZone: vi.fn(async ({ zoneId }) => {
				if (zoneId === 'alevtina') {
					throw new Error('alevtina boot failed');
				}
				return createStartedGateway(zoneId);
			}),
			startHttpServer: async (options) => {
				app = options.app;
				return { close: async () => {} };
			},
			setIntervalImpl: vi.fn(() => fakeInterval),
			clearIntervalImpl: vi.fn(),
		},
	);

	const statusResponse = await app?.request('/controller-status');
	await expect(statusResponse?.json()).resolves.toMatchObject({
		zones: expect.arrayContaining([
			expect.objectContaining({ id: 'shravan', lifecycleState: 'running', running: true }),
			expect.objectContaining({
				id: 'alevtina',
				lastError: expect.stringContaining('alevtina boot failed'),
				lifecycleState: 'failed',
				running: false,
			}),
		]),
	});

	await runtime.close();
});
```

Add `createStartedGateway(zoneId: string)` helper in the test file:

```ts
function createStartedGateway(zoneId: string) {
	return {
		image: { fingerprint: `fingerprint-${zoneId}`, imagePath: `/tmp/${zoneId}.img` },
		ingress: { host: '127.0.0.1', port: zoneId === 'alevtina' ? 18792 : 18791 },
		processSpec: openClawProcessSpec,
		vm: {
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ command: `ssh ${zoneId}` })),
			exec: vi.fn(async (command: string) => ({
				exitCode: 0,
				stderr: '',
				stdout: command.startsWith('cat ') ? `logs for ${zoneId}` : zoneId,
			})),
			getVmInstance: vi.fn(),
			id: `gateway-${zoneId}`,
			setIngressRoutes: vi.fn(),
		},
		zone: systemConfig.zones[0],
	};
}
```

- [ ] **Step 2: Run failing runtime tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/controller-runtime.test.ts
```

Expected: FAIL because `StartControllerRuntimeOptions` still requires `zoneId` and runtime returns one `gateway`.

- [ ] **Step 3: Update runtime types**

Change `packages/agent-vm/src/controller/controller-runtime-types.ts`:

```ts
export interface ControllerRuntime {
	readonly controllerPort: number;
	readonly zones: readonly {
		readonly ingress?: {
			readonly host: string;
			readonly port: number;
		};
		readonly lifecycleState: 'running' | 'failed' | 'stopped';
		readonly lastError?: string;
		readonly vmId?: string;
		readonly zoneId: string;
	}[];
	close(): Promise<void>;
}

export interface StartControllerRuntimeOptions {
	readonly systemConfig: LoadedSystemConfig;
	readonly startupFailures?: readonly {
		readonly lastError: string;
		readonly zoneId: string;
	}[];
	readonly zoneIds?: readonly string[];
}
```

- [ ] **Step 4: Wire registry in `startControllerRuntime`**

In `controller-runtime.ts`, remove `activeZone`, scalar `gateway`, scalar `stopGatewayZone`, and scalar worker route gates. Build a registry:

Import `PreparedWorkerTask` from `./worker-task-runner.js` so worker execution does not need a runtime cast.

```ts
const registry = createZoneRuntimeRegistry({
	systemConfig: options.systemConfig,
	...(options.zoneIds ? { zoneIds: options.zoneIds } : {}),
	...(options.startupFailures ? { startupFailures: options.startupFailures } : {}),
	createRuntimeForZone: (zone) =>
		zone.gateway.type === 'openclaw'
			? createOpenClawZoneRuntime({
					leaseManager,
					now,
					secretResolver,
					systemConfig: options.systemConfig,
					zone,
				})
			: createWorkerZoneRuntime({
					activeTaskRegistry,
					controllerGithubToken,
					executeWorkerTask: dependencies.executeWorkerTask,
					onWorkerTaskFinished: dependencies.onWorkerTaskFinished,
					onWorkerTaskIngress: dependencies.onWorkerTaskIngress,
					onWorkerTaskPrepared: dependencies.onWorkerTaskPrepared,
					prepareWorkerTask: dependencies.prepareWorkerTask,
					requestHeartbeatRegistry,
					secretResolver,
					systemConfig: options.systemConfig,
					zone,
				}),
});

await runTaskStep('Starting selected gateway zones', async () => {
	await registry.startSelectedZones();
});
```

Then create operations:

```ts
const controllerOperations = {
	...createControllerRuntimeOperations({
		getActiveLeases: () => leaseManager.listLeases(),
		getOpenClawRuntime: (zoneId) => registry.getOpenClawRuntime(zoneId),
		getRuntime: (zoneId) => registry.getRuntime(zoneId),
		getRuntimeStatusByZone: () => registry.getSnapshotByZone(),
		systemConfig: options.systemConfig,
	}),
	stopController,
	prepareWorkerTask: async (zoneId: string, input: WorkerTaskInput) =>
		await registry.getWorkerRuntime(zoneId).prepareWorkerTask(input),
	executeWorkerTask: async (prepared: PreparedWorkerTask) => {
		const zoneId = prepared.zoneId;
		return await registry.getWorkerRuntime(zoneId).executeWorkerTask(prepared);
	},
	getTaskState: async (zoneId: string, taskId: string) =>
		await registry.getWorkerRuntime(zoneId).getTaskState(taskId),
	closeTaskForZone: async (zoneId: string, taskId: string) =>
		await registry.getWorkerRuntime(zoneId).closeTaskForZone(taskId),
	pushTaskBranches: async (zoneId: string, taskId: string, input: { readonly branches: readonly PushBranchRequest[] }) =>
		await registry.getWorkerRuntime(zoneId).pushTaskBranches(taskId, input),
	pullDefaultForTask: async (zoneId: string, taskId: string, input: PullDefaultRequest) =>
		await registry.getWorkerRuntime(zoneId).pullDefaultForTask(taskId, input),
};
```

`getWorkerRuntime(zoneId)` is the only unsupported-operation boundary here. Once it returns a `WorkerZoneRuntime`, worker methods are required and must not use optional chaining.

Preserve the shutdown cleanup that existed before the registry split. `close()` must clear the reaper timer, stop request heartbeats, release leases, attempt every zone cleanup, close the HTTP server, and still surface cleanup errors:

```ts
async close(): Promise<void> {
	clearReaperTimer();
	requestHeartbeatRegistry.stopAll();
	const releaseError = await releaseAllLeases();
	let stopError: Error | undefined;
	try {
		await registry.stopAllZones();
	} catch (error) {
		stopError = error instanceof Error ? error : new Error(formatUnknownError(error));
	} finally {
		await serverRef.current?.close();
	}
	if (releaseError) {
		throw releaseError;
	}
	if (stopError) {
		throw stopError;
	}
}
```

- [ ] **Step 5: Run runtime tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/controller-runtime.test.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime-types.ts packages/agent-vm/src/controller/controller-runtime.test.ts
git commit -m "feat: wire multi-zone runtime registry into controller" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 8: Map Runtime Errors to HTTP Status Codes

**Files:**
- Modify: `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`
- Test: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`

- [ ] **Step 1: Add route error mapping tests**

Add tests:

```ts
import {
	ControllerZoneNotFoundError,
	ControllerZoneOperationUnsupportedError,
	ControllerZoneRuntimeUnavailableError,
	ControllerZoneRuntimeStartError,
} from '../zone-runtimes/zone-runtime-errors.js';

it('maps typed zone runtime errors to stable HTTP statuses', async () => {
	const app = createControllerApp({
		leaseManager,
		operations: {
			destroyZone: vi.fn(async () => {
				throw new ControllerZoneNotFoundError('missing');
			}),
			getStatus: vi.fn(async () => ({})),
			getZoneLogs: vi.fn(async () => {
				throw new ControllerZoneOperationUnsupportedError('worker-zone', 'OpenClaw operations', 'worker');
			}),
			getZoneStatus: vi.fn(async () => {
				throw new ControllerZoneRuntimeUnavailableError('shravan', 'boot failed');
			}),
			refreshZoneCredentials: vi.fn(async () => {
				throw new ControllerZoneRuntimeStartError('shravan', new Error('restart failed'));
			}),
			upgradeZone: vi.fn(async () => ({})),
		},
	});

	expect(
		(
			await app.request('/zones/missing/destroy', {
				body: '{"purge":false}',
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			})
		).status,
	).toBe(404);
	expect((await app.request('/zones/worker-zone/logs')).status).toBe(405);
	expect((await app.request('/zones/shravan/status')).status).toBe(409);
	expect((await app.request('/zones/shravan/credentials/refresh', { method: 'POST' })).status).toBe(503);
});

it('maps worker task route unsupported errors to 405', async () => {
	const operations = {
		destroyZone: vi.fn(async () => ({})),
		getStatus: vi.fn(async () => ({})),
		getZoneLogs: vi.fn(async () => ({})),
		getZoneStatus: vi.fn(async () => ({})),
		refreshZoneCredentials: vi.fn(async () => ({})),
		upgradeZone: vi.fn(async () => ({})),
		prepareWorkerTask: vi.fn(async () => {
			throw new ControllerZoneOperationUnsupportedError('shravan', 'worker operations', 'openclaw');
		}),
		executeWorkerTask: vi.fn(async () => undefined),
		closeTaskForZone: vi.fn(async () => {
			throw new ControllerZoneOperationUnsupportedError('shravan', 'worker operations', 'openclaw');
		}),
		pushTaskBranches: vi.fn(async () => {
			throw new ControllerZoneOperationUnsupportedError('shravan', 'worker operations', 'openclaw');
		}),
		pullDefaultForTask: vi.fn(async () => {
			throw new ControllerZoneOperationUnsupportedError('shravan', 'worker operations', 'openclaw');
		}),
	};
	const app = createControllerApp({ leaseManager, operations });

	expect(
		(
			await app.request('/zones/shravan/worker-tasks', {
				body: JSON.stringify({
					context: {},
					prompt: 'wrong zone type',
					repos: [],
					requestTaskId: 'request-1',
					resources: { externalResources: {} },
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			})
		).status,
	).toBe(405);
	expect((await app.request('/zones/shravan/tasks/task-1')).status).toBe(405);
	expect((await app.request('/zones/shravan/tasks/task-1/close', { method: 'POST' })).status).toBe(405);
	expect(
		(
			await app.request('/zones/shravan/tasks/task-1/push-branches', {
				body: JSON.stringify({ branches: [] }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			})
		).status,
	).toBe(405);
	expect(
		(
			await app.request('/zones/shravan/tasks/task-1/pull-default', {
				body: JSON.stringify({ repoUrl: 'https://github.com/example/repo.git' }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			})
		).status,
	).toBe(405);
});

it('returns failed zone status snapshots as 200 so operators can inspect lastError', async () => {
	const app = createControllerApp({
		leaseManager,
		operations: {
			destroyZone: vi.fn(async () => ({})),
			getStatus: vi.fn(async () => ({})),
			getZoneLogs: vi.fn(async () => ({})),
			getZoneStatus: vi.fn(async () => ({
				id: 'alevtina',
				lastError: 'gateway boot failed',
				lifecycleState: 'failed',
				running: false,
			})),
			refreshZoneCredentials: vi.fn(async () => ({})),
			upgradeZone: vi.fn(async () => ({})),
		},
	});

	const response = await app.request('/zones/alevtina/status');

	expect(response.status).toBe(200);
	await expect(response.json()).resolves.toMatchObject({
		id: 'alevtina',
		lastError: 'gateway boot failed',
		lifecycleState: 'failed',
	});
});
```

- [ ] **Step 2: Run failing route tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: FAIL because typed errors are still returned as `500`.

- [ ] **Step 3: Add route error serializer**

In `controller-zone-operation-routes.ts`, add:

```ts
function zoneRuntimeErrorStatus(error: unknown): 404 | 405 | 409 | 503 | 500 {
	if (error instanceof ControllerZoneNotFoundError) {
		return 404;
	}
	if (error instanceof ControllerZoneOperationUnsupportedError) {
		return 405;
	}
	if (error instanceof ControllerZoneRuntimeUnavailableError) {
		return 409;
	}
	if (error instanceof ControllerZoneRuntimeStartError) {
		return 503;
	}
	return 500;
}

function zoneRuntimeErrorBody(error: unknown): { readonly error: string } {
	return {
		error: error instanceof Error ? error.message : 'zone-operation-failed',
	};
}
```

Wrap zone-operation route bodies with `try/catch` and return:

```ts
return context.json(zoneRuntimeErrorBody(error), zoneRuntimeErrorStatus(error));
```

Apply this to:

- `/zones/:zoneId/status`
- `/zones/:zoneId/logs`
- `/zones/:zoneId/credentials/refresh`
- `/zones/:zoneId/destroy`
- `/zones/:zoneId/upgrade`
- `/zones/:zoneId/enable-ssh`
- `/zones/:zoneId/execute-command`
- `/zones/:zoneId/worker-tasks`
- `/zones/:zoneId/tasks/:taskId`
- `/zones/:zoneId/tasks/:taskId/close`
- `/zones/:zoneId/tasks/:taskId/push-branches`
- `/zones/:zoneId/tasks/:taskId/pull-default`

For worker-task routes, check typed runtime errors first in the catch block and only then fall back to the existing route-specific branches such as task capacity `409` or validation `400`:

```ts
} catch (error) {
	const runtimeStatus = zoneRuntimeErrorStatus(error);
	if (runtimeStatus !== 500) {
		return context.json(zoneRuntimeErrorBody(error), runtimeStatus);
	}
	if (error instanceof ControllerRuntimeAtCapacityError) {
		return context.json({ error: error.message }, 409);
	}
	return context.json(zoneRuntimeErrorBody(error), 500);
}
```

`GET /zones/:zoneId/status` must return a failed-zone snapshot with HTTP `200`. It should only return `409` when a typed runtime dependency error prevents building the snapshot at all.

- [ ] **Step 4: Run route tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
git commit -m "feat: map zone runtime errors to HTTP statuses" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 9: Update Controller Start CLI for All-Zone Default

**Files:**
- Modify: `packages/agent-vm/src/cli/commands/controller-definition.ts`
- Modify: `packages/agent-vm/src/cli/vm-host-system-templates.ts`
- Test: `packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts`
- Test: `packages/agent-vm/src/cli/commands/controller-definition.test.ts`
- Test: `packages/agent-vm/src/cli/vm-host-system-templates.test.ts`

- [ ] **Step 1: Add CLI tests**

In `agent-vm-entrypoint.test.ts`, replace the current “rejects controller start when multiple zones are configured” expectation with:

```ts
it('starts all configured zones when controller start omits --zone', async () => {
	const baseSystemConfig = createCliBuildSystemConfig();
	const primaryZone = baseSystemConfig.zones[0];
	if (!primaryZone) {
		throw new Error('Expected primary zone in test system config');
	}
	const startControllerRuntime = vi.fn(async () => ({
		controllerPort: 18800,
		zones: [
			{ lifecycleState: 'running', zoneId: 'shravan', vmId: 'vm-shravan' },
			{ lifecycleState: 'running', zoneId: 'alevtina', vmId: 'vm-alevtina' },
		],
		close: async () => {},
	}));

	await runAgentVmCli(
		['controller', 'start'],
		{ stderr: { write: () => true }, stdout: { write: () => true } },
		{
			...defaultCliDependencies,
			isGatewayImageCached: async () => true,
			loadSystemConfig: async () => ({
				...baseSystemConfig,
				zones: [primaryZone, { ...primaryZone, id: 'alevtina' }],
			}),
			startControllerRuntime,
		},
	);

	expect(startControllerRuntime).toHaveBeenCalledWith(
		expect.objectContaining({
			zoneIds: undefined,
		}),
		{ runTask: expect.any(Function) },
	);
});
```

Keep the explicit `--zone alevtina` test, but update it to expect `zoneIds: ['alevtina']`.

Add a partial-start CLI test for missing image cache in all-zone mode:

```ts
it('skips uncached zones in all-zone mode and still starts cached zones', async () => {
	const baseSystemConfig = createCliBuildSystemConfig();
	const primaryZone = baseSystemConfig.zones[0];
	if (!primaryZone) {
		throw new Error('Expected primary zone in test system config');
	}
	const startControllerRuntime = vi.fn(async () => ({
		controllerPort: 18800,
		zones: [
			{ lifecycleState: 'running', zoneId: 'shravan', vmId: 'vm-shravan' },
			{
				lastError: 'Gateway image not cached for zone alevtina',
				lifecycleState: 'failed',
				zoneId: 'alevtina',
			},
		],
		close: async () => {},
	}));

	await runAgentVmCli(
		['controller', 'start'],
		{ stderr: { write: () => true }, stdout: { write: () => true } },
		{
			...defaultCliDependencies,
			isGatewayImageCached: async (systemConfig, zoneId) => zoneId === 'shravan',
			loadSystemConfig: async () => ({
				...baseSystemConfig,
				zones: [primaryZone, { ...primaryZone, id: 'alevtina' }],
			}),
			startControllerRuntime,
		},
	);

	expect(startControllerRuntime).toHaveBeenCalledWith(
		expect.objectContaining({
			zoneIds: ['shravan'],
			startupFailures: [
				expect.objectContaining({
					lastError: expect.stringContaining('Gateway image not cached'),
					zoneId: 'alevtina',
				}),
			],
		}),
		{ runTask: expect.any(Function) },
	);
});
```

In `vm-host-system-templates.test.ts`, change the start script assertion:

```ts
expect(startScript).toContain('agent-vm controller start --config /etc/agent-vm/system.json');
expect(startScript).not.toContain('--zone coding-agent');
```

- [ ] **Step 2: Run failing CLI tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts packages/agent-vm/src/cli/commands/controller-definition.test.ts packages/agent-vm/src/cli/vm-host-system-templates.test.ts
```

Expected: FAIL because CLI still requires `--zone` for `controller start` and generated start script still includes `--zone`.

- [ ] **Step 3: Update start command selection**

In `controller-definition.ts`, make `zone` optional and compute:

```ts
const selectedZoneIds = zone ? [requireZone(systemConfig, zone).id] : undefined;
const cachedZoneIds: string[] = [];
const startupFailures: { readonly lastError: string; readonly zoneId: string }[] = [];
for (const zoneId of selectedZoneIds ?? systemConfig.zones.map((configuredZone) => configuredZone.id)) {
	if (!zone) {
		const isCached = await dependencies.isGatewayImageCached(systemConfig, zoneId);
		if (!isCached) {
			startupFailures.push({
				lastError: `Gateway image not cached for zone '${zoneId}'. Run \`agent-vm build --zone ${zoneId}\` before expecting this zone to start.`,
				zoneId,
			});
			continue;
		}
		cachedZoneIds.push(zoneId);
		continue;
	}
	await requireGatewayImageCache(systemConfig, zoneId, dependencies);
	cachedZoneIds.push(zoneId);
}
const runtime = await dependencies.startControllerRuntime(
	{
		systemConfig,
		zoneIds: cachedZoneIds,
		...(startupFailures.length > 0 ? { startupFailures } : {}),
	},
	{ runTask },
);
```

All-zone mode preserves partial start: uncached zones are represented as failed startup snapshots while cached zones still boot. Explicit `--zone` remains fail-fast for maintenance/debugging because the operator asked for exactly one zone.

Output:

```ts
{
	controllerPort: runtime.controllerPort,
	zones: runtime.zones,
}
```

Change cache error text to remove the stale mandatory `--zone` guidance:

```ts
`[start] Gateway image not cached for zone '${zoneId}'. Run \`agent-vm build\` first, then retry \`agent-vm controller start\`.`
```

In `packages/agent-vm/src/cli/agent-vm-cli-support.ts`, update `CliDependencies.startControllerRuntime` to match the new runtime contract:

```ts
readonly startControllerRuntime: (
	options: {
		readonly systemConfig: LoadedSystemConfig;
		readonly startupFailures?: readonly {
			readonly lastError: string;
			readonly zoneId: string;
		}[];
		readonly zoneIds?: readonly string[];
	},
	dependencies?: ControllerRuntimeDependencies,
) => Promise<ControllerRuntime>;
```

The `defaultCliDependencies.startControllerRuntime` implementation remains a pass-through to `startControllerRuntime(runtimeOptions, runtimeDependencies ?? {})`.

- [ ] **Step 4: Remove `--zone` from generated VM host start script**

In `vm-host-system-templates.ts`, change:

```sh
exec agent-vm controller start --config /etc/agent-vm/system.json --zone ${options.zoneId}
```

to:

```sh
exec agent-vm controller start --config /etc/agent-vm/system.json
```

- [ ] **Step 5: Run CLI tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts packages/agent-vm/src/cli/commands/controller-definition.test.ts packages/agent-vm/src/cli/vm-host-system-templates.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/cli/commands/controller-definition.ts packages/agent-vm/src/cli/vm-host-system-templates.ts packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts packages/agent-vm/src/cli/commands/controller-definition.test.ts packages/agent-vm/src/cli/vm-host-system-templates.test.ts
git commit -m "feat: start all controller zones by default" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 10: Add Local Smoke Test for Multi-Zone Controller API

**Files:**
- Modify: `packages/agent-vm/src/integration-tests/live-api-smoke.integration.test.ts`

- [ ] **Step 1: Add smoke test with fake runtime dependencies and real HTTP server**

Add a non-QEMU smoke test that starts the controller HTTP server with two fake OpenClaw gateways through `startControllerRuntime`, then calls real HTTP routes:

```ts
it('smoke: one controller serves two OpenClaw zones over real HTTP routes', async () => {
	const controllerPort = await findAvailablePort();
	currentSmokeSystemConfig = createTwoZoneOpenClawSystemConfig(controllerPort);
	const runtime = await startControllerRuntime(
		{ systemConfig: currentSmokeSystemConfig },
		{
			createSecretResolver: async () => ({
				resolve: async () => '',
				resolveAll: async () => ({}),
			}),
			startGatewayZone: async ({ zoneId }) => createFakeGatewayStartResult(zoneId),
		},
	);
	try {
		const statusResponse = await fetch(`http://127.0.0.1:${controllerPort}/controller-status`);
		expect(statusResponse.status).toBe(200);
		await expect(statusResponse.json()).resolves.toMatchObject({
			zones: expect.arrayContaining([
				expect.objectContaining({ id: 'shravan', lifecycleState: 'running' }),
				expect.objectContaining({ id: 'alevtina', lifecycleState: 'running' }),
			]),
		});

		const shravanLogsResponse = await fetch(`http://127.0.0.1:${controllerPort}/zones/shravan/logs`);
		const alevtinaLogsResponse = await fetch(`http://127.0.0.1:${controllerPort}/zones/alevtina/logs`);
		expect(shravanLogsResponse.status).toBe(200);
		expect(alevtinaLogsResponse.status).toBe(200);
		await expect(shravanLogsResponse.json()).resolves.toEqual({
			output: 'logs for shravan',
			zoneId: 'shravan',
		});
		await expect(alevtinaLogsResponse.json()).resolves.toEqual({
			output: 'logs for alevtina',
			zoneId: 'alevtina',
		});
	} finally {
		await runtime.close();
	}
});
```

- [ ] **Step 2: Add mixed OpenClaw + Worker smoke test**

Add a second smoke test in the same file:

```ts
it('smoke: one controller dispatches mixed OpenClaw and Worker zones by runtime type', async () => {
	const controllerPort = await findAvailablePort();
	currentSmokeSystemConfig = createMixedZoneSystemConfig(controllerPort);
	const prepareWorkerTask = vi.fn(async (options) => ({
		input: options.input,
		recordEvent: vi.fn(async () => {}),
		taskId: 'worker-task-1',
		zoneId: options.zoneId,
	}));
	const executeWorkerTask = vi.fn(async () => undefined);
	const runtime = await startControllerRuntime(
		{ systemConfig: currentSmokeSystemConfig },
		{
			createSecretResolver: async () => ({
				resolve: async () => '',
				resolveAll: async () => ({}),
			}),
			executeWorkerTask,
			prepareWorkerTask,
			startGatewayZone: async ({ zoneId }) => createFakeGatewayStartResult(zoneId),
		},
	);
	try {
		const openClawLogsResponse = await fetch(
			`http://127.0.0.1:${controllerPort}/zones/shravan/logs`,
		);
		expect(openClawLogsResponse.status).toBe(200);

		const workerTaskResponse = await fetch(
			`http://127.0.0.1:${controllerPort}/zones/worker-zone/worker-tasks`,
			{
				body: JSON.stringify({
					context: {},
					prompt: 'test worker task',
					repos: [],
					requestTaskId: 'request-1',
					resources: { externalResources: {} },
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			},
		);
		expect(workerTaskResponse.status).toBe(202);
		await expect(workerTaskResponse.json()).resolves.toEqual({
			status: 'accepted',
			taskId: 'worker-task-1',
		});

		const wrongRouteResponse = await fetch(
			`http://127.0.0.1:${controllerPort}/zones/shravan/worker-tasks`,
			{
				body: JSON.stringify({
					context: {},
					prompt: 'wrong zone type',
					repos: [],
					requestTaskId: 'request-2',
					resources: { externalResources: {} },
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			},
		);
		expect(wrongRouteResponse.status).toBe(405);

		const missingZoneWorkerResponse = await fetch(
			`http://127.0.0.1:${controllerPort}/zones/missing-zone/worker-tasks`,
			{
				body: JSON.stringify({
					context: {},
					prompt: 'missing zone',
					repos: [],
					requestTaskId: 'request-3',
					resources: { externalResources: {} },
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			},
		);
		expect(missingZoneWorkerResponse.status).toBe(404);

		const wrongCloseRouteResponse = await fetch(
			`http://127.0.0.1:${controllerPort}/zones/shravan/tasks/task-1/close`,
			{ method: 'POST' },
		);
		expect(wrongCloseRouteResponse.status).toBe(405);
	} finally {
		await runtime.close();
	}
});
```

Add helper functions in the same test file:

```ts
function createTwoZoneOpenClawSystemConfig(controllerPort: number): LoadedSystemConfig {
	const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-multizone-smoke-'));
	return createLoadedSystemConfig(
		{
			cacheDir: path.join(tempDirectory, 'cache'),
			runtimeDir: path.join(tempDirectory, 'runtime'),
			host: {
				controllerPort,
				projectNamespace: 'multizone-smoke',
			},
			imageProfiles: {
				gateways: {
					openclaw: { type: 'openclaw', buildConfig: path.join(tempDirectory, 'gateway.json') },
				},
				toolVms: {
					standard: { type: 'toolVm', buildConfig: path.join(tempDirectory, 'tool.json') },
				},
			},
			tcpPool: { basePort: controllerPort + 100, size: 5 },
			toolVmProfiles: {
				standard: { cpus: 1, imageProfile: 'standard', memory: '1G' },
			},
			zones: ['shravan', 'alevtina'].map((zoneId, index) => ({
				allowedHosts: ['api.openai.com'],
				gateway: {
					type: 'openclaw',
					imageProfile: 'openclaw',
					cpus: 1,
					config: path.join(tempDirectory, `${zoneId}.json`),
					memory: '1G',
					port: controllerPort + 200 + index,
					stateDir: path.join(tempDirectory, 'state', zoneId),
					zoneFilesDir: path.join(tempDirectory, 'zone-files', zoneId),
				},
				id: zoneId,
				secrets: {},
				agentToolVmProfiles: {},
websocketBypass: [],
			})),
	},
	{ systemConfigPath: path.join(tempDirectory, 'system.json') },
);
}

function createMixedZoneSystemConfig(controllerPort: number): LoadedSystemConfig {
	const baseConfig = createTwoZoneOpenClawSystemConfig(controllerPort);
	const openClawZone = baseConfig.zones.find((zone) => zone.id === 'shravan');
	if (!openClawZone) {
		throw new Error('Expected mixed smoke config to include shravan zone.');
	}
	const tempDirectory = path.dirname(baseConfig.systemConfigPath);
	return {
		...baseConfig,
		zones: [
			openClawZone,
			{
				allowedHosts: ['api.openai.com'],
				gateway: {
					type: 'worker',
					imageProfile: 'worker',
					cpus: 1,
					config: path.join(tempDirectory, 'worker.json'),
					memory: '1G',
					port: controllerPort + 250,
					stateDir: path.join(tempDirectory, 'state', 'worker-zone'),
				},
				id: 'worker-zone',
				secrets: {},
				websocketBypass: [],
			},
		],
		imageProfiles: {
			...baseConfig.imageProfiles,
			gateways: {
				...baseConfig.imageProfiles.gateways,
				worker: {
					type: 'worker',
					buildConfig: path.join(tempDirectory, 'worker-gateway.json'),
				},
			},
		},
	};
}
	
let currentSmokeSystemConfig: LoadedSystemConfig;

function createFakeGatewayStartResult(zoneId: string) {
	const zone = currentSmokeSystemConfig.zones.find((candidateZone) => candidateZone.id === zoneId);
	if (!zone) {
		throw new Error(`Expected smoke system config to define zone '${zoneId}'.`);
	}
	return {
		image: { fingerprint: `fingerprint-${zoneId}`, imagePath: `/tmp/${zoneId}.img` },
		ingress: { host: '127.0.0.1', port: zoneId === 'shravan' ? 18791 : 18792 },
		processSpec: {
			bootstrapCommand: 'bootstrap',
			guestListenPort: 18789,
			healthCheck: { type: 'http', port: 18789, path: '/' },
			logPath: '/tmp/openclaw.log',
			startCommand: 'start',
		},
		vm: {
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ command: `ssh ${zoneId}` })),
			exec: vi.fn(async (command: string) => ({
				exitCode: 0,
				stderr: '',
				stdout: command.startsWith('cat ') ? `logs for ${zoneId}` : zoneId,
			})),
			getVmInstance: vi.fn(),
			id: `vm-${zoneId}`,
			setIngressRoutes: vi.fn(),
		},
		zone,
	};
}
```

- [ ] **Step 3: Run the failing smoke tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/integration-tests/live-api-smoke.integration.test.ts
```

Expected before prior tasks: FAIL because runtime cannot start multiple zones. Expected after prior tasks: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/integration-tests/live-api-smoke.integration.test.ts
git commit -m "test: smoke test multi-zone controller routes" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 11: Add Per-Zone, Per-Agent OpenClaw Auth Profiles

**Files:**
- Modify: `packages/gateway-interface/src/gateway-lifecycle.ts`
- Modify: `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- Test: `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Test: `packages/agent-vm/src/config/system-config.test.ts`
- Modify: `packages/agent-vm/src/operations/doctor.ts`
- Test: `packages/agent-vm/src/operations/doctor.test.ts`
- Modify: `packages/agent-vm/src/operations/config-validation.ts`
- Test: `packages/agent-vm/src/operations/config-validation.test.ts`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/subsystems/gateway-lifecycle.md`
- Modify: `docs/subsystems/secrets-and-credentials.md`

- [ ] **Step 1: Add failing schema tests for per-zone, per-agent auth profiles**

Add these tests to `packages/agent-vm/src/config/system-config.test.ts` near existing auth profile tests:

```ts
test('loads OpenClaw auth profiles separately per zone and per agent', async () => {
	const config = createValidSystemConfigInput();
	config.zones = [
		{
			...config.zones[0],
			id: 'home',
			gateway: {
				...config.zones[0].gateway,
				stateDir: '../state/home',
				zoneFilesDir: '../zone-files/home',
				authProfilesByAgent: {
					alevtina: { source: 'environment', envVar: 'HOME_ALEVTINA_AUTH_PROFILES' },
					shravan: { source: '1password', ref: 'op://agent-vm/home-shravan-auth-profiles/credential' },
				},
			},
		},
		{
			...config.zones[0],
			id: 'work',
			gateway: {
				...config.zones[0].gateway,
				stateDir: '../state/work',
				zoneFilesDir: '../zone-files/work',
				authProfilesByAgent: {
					shravan: { source: '1password', ref: 'op://agent-vm/work-shravan-auth-profiles/credential' },
				},
			},
		},
	];
	const configPath = await writeSystemConfigForTest('agent-vm-system-agent-auth-', config);

	await expect(loadSystemConfig(configPath)).resolves.toMatchObject({
		zones: [
			expect.objectContaining({
				id: 'home',
				gateway: expect.objectContaining({
					authProfilesByAgent: {
						alevtina: { source: 'environment', envVar: 'HOME_ALEVTINA_AUTH_PROFILES' },
						shravan: { source: '1password', ref: 'op://agent-vm/home-shravan-auth-profiles/credential' },
					},
				}),
			}),
			expect.objectContaining({
				id: 'work',
				gateway: expect.objectContaining({
					authProfilesByAgent: {
						shravan: { source: '1password', ref: 'op://agent-vm/work-shravan-auth-profiles/credential' },
					},
				}),
			}),
		],
	});
});

test('rejects legacy OpenClaw authProfilesRef because auth must be keyed by agent', async () => {
	const config = createValidSystemConfigInput();
	config.zones = [
		{
			...config.zones[0],
			gateway: {
				...config.zones[0].gateway,
				authProfilesRef: { source: '1password', ref: 'op://agent-vm/shared-auth/credential' },
			},
		},
	];
	const configPath = await writeSystemConfigForTest('agent-vm-system-legacy-auth-ref-', config);

	await expect(loadSystemConfig(configPath)).rejects.toThrow(/authProfilesRef/u);
});

test('rejects authProfilesByAgent keys that are not safe agent identifiers', async () => {
	const config = createValidSystemConfigInput();
	config.zones = [
		{
			...config.zones[0],
			gateway: {
				...config.zones[0].gateway,
				authProfilesByAgent: {
					'../shravan': { source: '1password', ref: 'op://agent-vm/bad/credential' },
				},
			},
		},
	];
	const configPath = await writeSystemConfigForTest('agent-vm-system-bad-agent-auth-', config);

	await expect(loadSystemConfig(configPath)).rejects.toThrow(/authProfilesByAgent/u);
});
```

- [ ] **Step 2: Replace legacy auth profile schema with per-agent mapping**

In `packages/gateway-interface/src/gateway-lifecycle.ts`, move auth profile references off the base gateway config and onto OpenClaw gateway config:

```ts
interface GatewayZoneBaseGatewayConfig {
	readonly type: GatewayType;
	readonly memory: string;
	readonly cpus: number;
	readonly port: number;
	readonly config: string;
	readonly stateDir: string;
}

interface OpenClawGatewayZoneGatewayConfig extends GatewayZoneBaseGatewayConfig {
	readonly type: 'openclaw';
	readonly authProfilesByAgent?: Readonly<Record<string, OnePasswordGatewayAuthProfilesRef | EnvironmentGatewayAuthProfilesRef>>;
	readonly zoneFilesDir: string;
}
```

In `packages/agent-vm/src/config/system-config.ts`, define a safe shared agent id key schema:

```ts
const agentIdSchema = z
	.string()
	.min(1)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, 'agent id must use letters, numbers, dot, underscore, or hyphen');
```

Then replace `authProfilesRef` on `zoneGatewayBaseSchema` with `authProfilesByAgent` on `openClawZoneGatewaySchema`:

```ts
const zoneGatewayBaseSchema = z.object({
	imageProfile: z.string().min(1),
	memory: z.string().min(1),
	cpus: z.number().int().positive(),
	port: z.number().int().positive(),
	config: z.string().min(1),
	stateDir: z.string().min(1),
	backupDir: z.string().min(1).optional(),
});

const openClawZoneGatewaySchema = zoneGatewayBaseSchema
	.extend({
		type: z.literal('openclaw'),
		authProfilesByAgent: z.record(agentIdSchema, authProfilesSecretSchema).optional(),
		zoneFilesDir: z.string().min(1),
	})
	.strict();

const workerZoneGatewaySchema = zoneGatewayBaseSchema
	.extend({
		type: z.literal('worker'),
	})
	.strict();

const zoneGatewaySchema = z.discriminatedUnion('type', [
	openClawZoneGatewaySchema,
	workerZoneGatewaySchema,
]);
```

Update the 1Password provider requirement to inspect every per-agent auth profile secret:

```ts
const hasOnePasswordSecrets = config.zones.some(
	(zone) =>
		Object.values(zone.secrets).some((secret) => secret.source === '1password') ||
		(zone.gateway.type === 'openclaw' &&
			Object.values(zone.gateway.authProfilesByAgent ?? {}).some(
				(secret) => secret.source === '1password',
			)),
);
```

- [ ] **Step 3: Add failing OpenClaw lifecycle tests for per-agent auth materialization**

In `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`, change `createZone()` to populate `authProfilesByAgent` instead of `authProfilesRef`:

```ts
function createZone(overrides?: {
	readonly authProfilesByAgent?: Extract<GatewayZoneConfig['gateway'], { readonly type: 'openclaw' }>['authProfilesByAgent'];
	readonly gateway?: Partial<OpenClawGatewayConfig>;
	readonly withoutAuthProfilesByAgent?: boolean;
}): GatewayZoneConfig {
	// ...
	gateway: {
		...baseGateway,
		...(overrides?.withoutAuthProfilesByAgent
			? {}
			: {
					authProfilesByAgent: overrides?.authProfilesByAgent ?? {
						main: {
							source: '1password',
							ref: 'op://vault/item/main-auth-profiles',
						},
					},
				}),
		...overrides?.gateway,
	},
	// ...
}
```

Replace the current single-profile test with:

```ts
it('writes auth-profiles.json separately for every configured agent in the zone', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-04-27T16:45:00.000Z'));
	const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-lifecycle-agent-auth-'));
	createdDirectories.push(tempDirectory);
	const configDirectory = path.join(tempDirectory, 'config');
	fs.mkdirSync(configDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(configDirectory, 'openclaw.json'),
		JSON.stringify({ gateway: { auth: { mode: 'token' }, bind: 'loopback' } }, null, 2),
		'utf8',
	);
	const zone = createZone({
		gateway: {
			config: path.join(configDirectory, 'openclaw.json'),
			stateDir: path.join(tempDirectory, 'state'),
			zoneFilesDir: path.join(tempDirectory, 'zone-files'),
		},
		authProfilesByAgent: {
			alevtina: { source: 'environment', envVar: 'ALEVTINA_AUTH_PROFILES' },
			shravan: { source: '1password', ref: 'op://vault/item/shravan-auth-profiles' },
		},
	});
	const secretResolver: SecretResolver = {
		resolve: async (secretRef) => {
			if (secretRef.ref === 'op://vault/item/shravan-auth-profiles') {
				return '{"profile":"shravan"}';
			}
			if (secretRef.ref === 'ALEVTINA_AUTH_PROFILES') {
				return '{"profile":"alevtina"}';
			}
			if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
				return 'resolved-gateway-token';
			}
			throw new Error(`Unexpected ref: ${secretRef.ref}`);
		},
		resolveAll: async () => ({}),
	};

	await openclawLifecycle.prepareHostState?.(zone, secretResolver);

	expect(
		fs.readFileSync(path.join(zone.gateway.stateDir, 'agents', 'shravan', 'agent', 'auth-profiles.json'), 'utf8'),
	).toBe('{"profile":"shravan"}');
	expect(
		fs.readFileSync(path.join(zone.gateway.stateDir, 'agents', 'alevtina', 'agent', 'auth-profiles.json'), 'utf8'),
	).toBe('{"profile":"alevtina"}');
	expect(fs.existsSync(path.join(zone.gateway.stateDir, 'agents', 'main'))).toBe(false);
	expect(fs.statSync(path.join(zone.gateway.stateDir, 'agents', 'shravan', 'agent')).mode & 0o777).toBe(0o700);
	expect(fs.statSync(path.join(zone.gateway.stateDir, 'agents', 'shravan', 'agent', 'auth-profiles.json')).mode & 0o777).toBe(0o600);
});
```

Update the no-auth test to use `withoutAuthProfilesByAgent: true` and assert no `agents` directory is created.

- [ ] **Step 4: Implement per-agent auth profile writing**

In `packages/openclaw-gateway/src/openclaw-lifecycle.ts`, replace the single `writeAuthProfilesIfConfigured()` implementation with:

```ts
function assertSafeAgentId(agentId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(agentId)) {
		throw new Error(`Invalid OpenClaw agent id '${agentId}'.`);
	}
}

async function writeAuthProfilesIfConfigured(
	zone: GatewayZoneConfig,
	secretResolver: SecretResolver,
): Promise<void> {
	if (zone.gateway.type !== 'openclaw') {
		return;
	}
	const authProfilesByAgentCandidate: unknown = zone.gateway.authProfilesByAgent;
	if (authProfilesByAgentCandidate === undefined) {
		return;
	}
	if (!isObjectRecord(authProfilesByAgentCandidate)) {
		throw new Error(`Zone '${zone.id}' has an invalid authProfilesByAgent shape.`);
	}

	for (const [agentId, authProfilesSecretCandidate] of Object.entries(authProfilesByAgentCandidate)) {
		assertSafeAgentId(agentId);
		if (!isSourceAwareSecretReference(authProfilesSecretCandidate)) {
			throw new Error(`Zone '${zone.id}' has an invalid authProfilesByAgent['${agentId}'] shape.`);
		}
		try {
			const authProfilesDirectory = path.join(zone.gateway.stateDir, 'agents', agentId, 'agent');
			await fs.mkdir(authProfilesDirectory, { recursive: true, mode: 0o700 });
			await fs.chmod(authProfilesDirectory, 0o700);
			const authProfiles = await secretResolver.resolve(toSecretRef(authProfilesSecretCandidate));
			await writeFileAtomically(
				path.join(authProfilesDirectory, 'auth-profiles.json'),
				authProfiles,
				{ mode: 0o600 },
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Failed to write OpenClaw auth profiles for zone '${zone.id}' agent '${agentId}' from '${describeSecretReference(authProfilesSecretCandidate)}': ${message}`,
				{ cause: error },
			);
		}
	}
}
```

There must be no fallback write to `agents/main/agent/auth-profiles.json`. If an operator wants a `main` agent, they must explicitly configure `authProfilesByAgent.main`.

- [ ] **Step 5: Add validate and doctor checks for configured agent auth**

Add a shared doctor check builder:

```ts
export function buildZoneAgentAuthProfileSetupChecks(systemConfig: SystemConfig): readonly DoctorCheck[] {
	return systemConfig.zones.flatMap((zone) => {
		if (zone.gateway.type !== 'openclaw') {
			return [];
		}
		return Object.entries(zone.gateway.authProfilesByAgent ?? {}).map(
			([agentId, secret]) =>
				({
					name: `zone-agent-auth-profile-${zone.id}-${agentId}`,
					ok: true,
					hint:
						secret.source === '1password'
							? `${agentId}=1password:${secret.ref}`
							: `${agentId}=environment:${secret.envVar}`,
				}) satisfies DoctorCheck,
		);
	});
}
```

Include it in both `runControllerDoctor()` and `runConfigValidation()` next to the zone/tool-vm-profile checks. Add tests that assert:

```ts
expect(result.checks).toEqual(
	expect.arrayContaining([
		expect.objectContaining({
			name: 'zone-agent-auth-profile-home-shravan',
			ok: true,
			hint: 'shravan=1password:op://agent-vm/home-shravan-auth-profiles/credential',
		}),
		expect.objectContaining({
			name: 'zone-agent-auth-profile-work-shravan',
			ok: true,
			hint: 'shravan=1password:op://agent-vm/work-shravan-auth-profiles/credential',
		}),
	]),
);
```

- [ ] **Step 6: Update auth docs**

In `docs/reference/configuration/system-json.md`, replace `authProfilesRef` examples with:

```json
{
  "id": "home",
  "gateway": {
    "type": "openclaw",
    "authProfilesByAgent": {
      "shravan": {
        "source": "1password",
        "ref": "op://agent-vm/home-shravan-auth-profiles/credential"
      },
      "alevtina": {
        "source": "environment",
        "envVar": "HOME_ALEVTINA_AUTH_PROFILES"
      }
    }
  }
}
```

Document the rule:

```md
Auth is scoped first by zone, then by agent. The same agent id in two zones may
point at different secrets, and there is no shared controller-level fallback.
The gateway writes each configured secret to:

`<zone.stateDir>/agents/<agentId>/agent/auth-profiles.json`
```

In `docs/subsystems/gateway-lifecycle.md` and `docs/subsystems/secrets-and-credentials.md`, replace every `agents/main/agent/auth-profiles.json` description with the per-agent path.

- [ ] **Step 7: Run focused auth checks**

Run:

```bash
pnpm vitest run --config vitest.config.ts \
  packages/openclaw-gateway/src/openclaw-lifecycle.test.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/operations/config-validation.test.ts \
  packages/agent-vm/src/operations/doctor.test.ts
pnpm typecheck
```

Expected: tests PASS and typecheck exits `0`.

- [ ] **Step 8: Commit**

```bash
git add \
  packages/gateway-interface/src/gateway-lifecycle.ts \
  packages/openclaw-gateway/src/openclaw-lifecycle.ts \
  packages/openclaw-gateway/src/openclaw-lifecycle.test.ts \
  packages/agent-vm/src/config/system-config.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/operations/doctor.ts \
  packages/agent-vm/src/operations/doctor.test.ts \
  packages/agent-vm/src/operations/config-validation.ts \
  packages/agent-vm/src/operations/config-validation.test.ts \
  docs/reference/configuration/system-json.md \
  docs/subsystems/gateway-lifecycle.md \
  docs/subsystems/secrets-and-credentials.md
git commit -m "feat: write OpenClaw auth profiles per zone agent" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 12: Add Per-Agent Sandbox Seeding on First Lease Boot

**Files:**
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Test: `packages/agent-vm/src/config/system-config.test.ts`
- Create: `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts`
- Test: `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts`
- Create: `packages/agent-vm/src/controller/leases/lease-scope.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Test: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
- Modify: `packages/agent-vm/src/operations/doctor.ts`
- Test: `packages/agent-vm/src/operations/doctor.test.ts`
- Modify: `packages/agent-vm/src/operations/config-validation.ts`
- Test: `packages/agent-vm/src/operations/config-validation.test.ts`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/subsystems/controller.md`

- [ ] **Step 1: Add failing schema tests for agent sandbox seed config**

Add tests to `packages/agent-vm/src/config/system-config.test.ts`:

```ts
test('loads per-agent sandbox seed entries for OpenClaw zones', async () => {
	const config = createValidSystemConfigInput();
	config.zones = [
		{
			...config.zones[0],
			agentSandboxSeeds: {
				shravan: {
					entries: [
						{ source: '../seeds/shravan/gcloud', target: '.config/gcloud' },
						{ source: '../seeds/shravan/npmrc', target: '.npmrc' },
					],
				},
			},
		},
	];
	const configPath = await writeSystemConfigForTest('agent-vm-system-agent-sandbox-seeds-', config);

	await expect(loadSystemConfig(configPath)).resolves.toMatchObject({
		zones: [
			expect.objectContaining({
				agentSandboxSeeds: {
					shravan: {
						entries: [
							expect.objectContaining({ target: '.config/gcloud' }),
							expect.objectContaining({ target: '.npmrc' }),
						],
					},
				},
			}),
		],
	});
});

test('rejects unsafe sandbox seed targets', async () => {
	const config = createValidSystemConfigInput();
	config.zones = [
		{
			...config.zones[0],
			agentSandboxSeeds: {
				shravan: {
					entries: [{ source: '../seeds/shravan/gcloud', target: '../outside' }],
				},
			},
		},
	];
	const configPath = await writeSystemConfigForTest('agent-vm-system-bad-sandbox-seed-', config);

	await expect(loadSystemConfig(configPath)).rejects.toThrow(/agentSandboxSeeds.*target/u);
});

test('rejects agentSandboxSeeds on worker zones', async () => {
	const config = createValidSystemConfigInput();
	config.zones = [
		{
			...config.zones[0],
			gateway: {
				type: 'worker',
				imageProfile: 'worker',
				cpus: 2,
				config: './worker.json',
				memory: '2G',
				port: 18791,
				stateDir: './state/worker',
			},
			defaultToolVmProfile: undefined,
			agentSandboxSeeds: {
				shravan: { entries: [{ source: '../seeds/shravan/gcloud', target: '.config/gcloud' }] },
			},
		},
	];
	config.imageProfiles.gateways.worker = { type: 'worker', buildConfig: './worker-gateway.json' };
	const configPath = await writeSystemConfigForTest('agent-vm-system-worker-sandbox-seed-', config);

	await expect(loadSystemConfig(configPath)).rejects.toThrow(/agentSandboxSeeds.*worker/u);
});
```

- [ ] **Step 2: Add schema and validation**

In `packages/agent-vm/src/config/system-config.ts`, add:

```ts
const relativeSandboxSeedTargetSchema = z
	.string()
	.min(1)
	.refine((target) => !path.isAbsolute(target), 'target must be relative')
	.refine((target) => !target.split(/[\\/]+/u).includes('..'), "target must not contain '..'");

const agentSandboxSeedSchema = z
	.object({
		entries: z
			.array(
				z
					.object({
						source: z.string().min(1),
						target: relativeSandboxSeedTargetSchema,
					})
					.strict(),
			)
			.default([]),
	})
	.strict();
```

Add the zone-level field next to `agentToolVmProfiles`:

```ts
agentSandboxSeeds: z.record(agentIdSchema, agentSandboxSeedSchema).optional(),
```

`agentSandboxSeeds` intentionally lives on the zone object, not on `gateway`, because it is part of the controller lease contract. The cross-field validation below keeps it OpenClaw-only.

Add cross-field validation:

```ts
if (zone.gateway.type !== 'openclaw' && zone.agentSandboxSeeds) {
	context.addIssue({
		code: z.ZodIssueCode.custom,
		message: `Zone '${zone.id}' cannot declare agentSandboxSeeds because gateway type '${zone.gateway.type}' does not create OpenClaw sandboxes.`,
		path: ['zones', zoneIndex, 'agentSandboxSeeds'],
	});
}
```

Resolve each `source` relative to the config file in the existing path resolution pass, the same way other relative paths are resolved. Do not require the source path to exist during config load; `validate`/`doctor` report existence so operators can stage seeds separately from schema parsing.

- [ ] **Step 3: Add sandbox seeding unit tests**

Create `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ensureAgentSandboxSeeded } from './agent-sandbox-seeding.js';

describe('ensureAgentSandboxSeeded', () => {
	it('copies configured files and directories once for an agent-scoped workspace', async () => {
		const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-sandbox-seed-'));
		const sourceDirectory = path.join(tempDirectory, 'seed', 'gcloud');
		const sourceFile = path.join(tempDirectory, 'seed', 'npmrc');
		const workspaceDirectory = path.join(tempDirectory, 'state', 'sandboxes', 'shravan', 'work');
		await fs.mkdir(path.join(sourceDirectory, 'configurations'), { recursive: true });
		await fs.writeFile(path.join(sourceDirectory, 'configurations', 'config_default'), 'gcloud-config');
		await fs.writeFile(sourceFile, 'npm-token');
		await fs.mkdir(workspaceDirectory, { recursive: true });

		await ensureAgentSandboxSeeded({
			scopeKey: 'agent:shravan:session-1',
			workspaceDir: workspaceDirectory,
			zone: {
				id: 'home',
				gateway: {
					type: 'openclaw',
					stateDir: path.join(tempDirectory, 'state'),
				},
				agentSandboxSeeds: {
					shravan: {
						entries: [
							{ source: sourceDirectory, target: '.config/gcloud' },
							{ source: sourceFile, target: '.npmrc' },
						],
					},
				},
			},
		});

		await expect(
			fs.readFile(path.join(workspaceDirectory, '.config', 'gcloud', 'configurations', 'config_default'), 'utf8'),
		).resolves.toBe('gcloud-config');
		await expect(fs.readFile(path.join(workspaceDirectory, '.npmrc'), 'utf8')).resolves.toBe('npm-token');

		await fs.rm(tempDirectory, { recursive: true, force: true });
	});

	it('does not overwrite an already seeded agent workspace', async () => {
		const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-sandbox-seed-once-'));
		const sourceFile = path.join(tempDirectory, 'seed', 'npmrc');
		const workspaceDirectory = path.join(tempDirectory, 'state', 'sandboxes', 'shravan', 'work');
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });
		await fs.writeFile(sourceFile, 'first');
		await fs.mkdir(workspaceDirectory, { recursive: true });

		const options = {
			scopeKey: 'agent:shravan:session-1',
			workspaceDir: workspaceDirectory,
			zone: {
				id: 'home',
				gateway: { type: 'openclaw', stateDir: path.join(tempDirectory, 'state') },
				agentSandboxSeeds: {
					shravan: { entries: [{ source: sourceFile, target: '.npmrc' }] },
				},
			},
		} as const;

		await ensureAgentSandboxSeeded(options);
		await fs.writeFile(sourceFile, 'second');
		await ensureAgentSandboxSeeded(options);

		await expect(fs.readFile(path.join(workspaceDirectory, '.npmrc'), 'utf8')).resolves.toBe('first');
		await fs.rm(tempDirectory, { recursive: true, force: true });
	});

	it('rejects unsafe seed targets at runtime too', async () => {
		await expect(
			ensureAgentSandboxSeeded({
				scopeKey: 'agent:shravan',
				workspaceDir: '/tmp/work',
				zone: {
					id: 'home',
					gateway: { type: 'openclaw', stateDir: '/tmp/state' },
					agentSandboxSeeds: {
						shravan: { entries: [{ source: '/tmp/source', target: '../outside' }] },
					},
				},
			}),
		).rejects.toThrow(/unsafe sandbox seed target/u);
	});
});
```

- [ ] **Step 4: Implement the seeding helper**

Create `packages/agent-vm/src/controller/leases/lease-scope.ts`:

```ts
export function parseAgentIdFromScopeKey(scopeKey: string): string | null {
	const [scopeKind, agentId] = scopeKey.split(':');
	if (scopeKind !== 'agent' || !agentId) {
		return null;
	}
	return agentId;
}

export function parseScopeKind(scopeKey: string): string {
	return scopeKey.split(':')[0] ?? '';
}
```

Then create `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts`:

```ts
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { parseAgentIdFromScopeKey } from './lease-scope.js';

interface AgentSandboxSeedEntry {
	readonly source: string;
	readonly target: string;
}

interface AgentSandboxSeedZone {
	readonly id: string;
	readonly gateway: {
		readonly type: string;
		readonly stateDir: string;
	};
	readonly agentSandboxSeeds?: Readonly<Record<string, { readonly entries: readonly AgentSandboxSeedEntry[] }>>;
}

const seedLocks = new Map<string, Promise<void>>();

function assertSafeRelativeTarget(target: string): void {
	if (path.isAbsolute(target) || target.split(/[\\/]+/u).includes('..')) {
		throw new Error(`unsafe sandbox seed target '${target}'`);
	}
}

async function copySeedEntry(entry: AgentSandboxSeedEntry, workspaceDir: string): Promise<void> {
	assertSafeRelativeTarget(entry.target);
	const destinationPath = path.join(workspaceDir, entry.target);
	const sourceStat = await fs.stat(entry.source);
	if (sourceStat.isDirectory()) {
		await fs.mkdir(path.dirname(destinationPath), { recursive: true });
		await fs.cp(entry.source, destinationPath, {
			recursive: true,
			errorOnExist: false,
			force: false,
		});
		return;
	}
	await fs.mkdir(path.dirname(destinationPath), { recursive: true });
	await fs.copyFile(entry.source, destinationPath, fs.constants.COPYFILE_EXCL).catch((error) => {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
			return;
		}
		throw error;
	});
}

async function seedAgentWorkspace(options: {
	readonly agentId: string;
	readonly entries: readonly AgentSandboxSeedEntry[];
	readonly workspaceDir: string;
	readonly zoneId: string;
}): Promise<void> {
	const workspaceHash = createHash('sha256')
		.update(options.workspaceDir)
		.digest('hex')
		.slice(0, 16);
	const markerDirectory = path.join(path.dirname(options.workspaceDir), '.agent-vm');
	const markerPath = path.join(markerDirectory, `seeded-${options.agentId}-${workspaceHash}.json`);
	try {
		await fs.stat(markerPath);
		return;
	} catch (error) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
			throw error;
		}
	}

	for (const entry of options.entries) {
		await copySeedEntry(entry, options.workspaceDir);
	}
	await fs.mkdir(markerDirectory, { recursive: true });
	await fs.writeFile(
		markerPath,
		JSON.stringify({ agentId: options.agentId, seededAt: new Date().toISOString(), zoneId: options.zoneId }, null, 2),
		{ flag: 'wx' },
	).catch((error) => {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
			return;
		}
		throw error;
	});
}

export async function ensureAgentSandboxSeeded(options: {
	readonly scopeKey: string;
	readonly workspaceDir: string;
	readonly zone: AgentSandboxSeedZone;
}): Promise<void> {
	if (options.zone.gateway.type !== 'openclaw') {
		return;
	}
	const agentId = parseAgentIdFromScopeKey(options.scopeKey);
	if (!agentId) {
		return;
	}
	const seed = options.zone.agentSandboxSeeds?.[agentId];
	if (!seed || seed.entries.length === 0) {
		return;
	}
	const lockKey = `${options.zone.id}\0${agentId}\0${options.workspaceDir}`;
	const existingLock = seedLocks.get(lockKey);
	if (existingLock) {
		await existingLock;
		return;
	}
	const lock = seedAgentWorkspace({
		agentId,
		entries: seed.entries,
		workspaceDir: options.workspaceDir,
		zoneId: options.zone.id,
	}).finally(() => {
		seedLocks.delete(lockKey);
	});
	seedLocks.set(lockKey, lock);
	await lock;
}
```

The marker lives beside the sandbox `work` directory rather than inside the mounted workspace so seeding state does not pollute the agent's working tree. The marker includes a stable hash of `workspaceDir` so two workspaces for the same agent do not collide. Seeding is copy-once for a workspace. If an operator wants to refresh credentials/config, they must delete that sandbox or its marker intentionally.

- [ ] **Step 5: Wire seeding into lease creation**

In `packages/agent-vm/src/controller/http/controller-http-routes.ts`, add options:

```ts
readonly zonesById: ReadonlyMap<
	string,
	{
		readonly agentSandboxSeeds?: Readonly<Record<string, { readonly entries: readonly { readonly source: string; readonly target: string }[] }>>;
		readonly id: string;
		readonly defaultToolVmProfile?: string;
	}
>;
readonly seedAgentSandbox?: (options: {
	readonly scopeKey: string;
	readonly workspaceDir: string;
	readonly zoneId: string;
}) => Promise<void>;
```

This step intentionally introduces `zonesById` before the per-agent tool-vm-profile task. Remove `zoneDefaultToolVmProfiles` from `createControllerApp` and replace the old unknown-zone/profile fallback logic with:

```ts
const zone = options.zonesById.get(payload.zoneId);
if (!zone) {
	return context.json({ error: `Unknown zone '${payload.zoneId}'` }, 400);
}
const resolvedProfileId = zone.defaultToolVmProfile ?? payload.profileId;
```

Update every existing direct `createControllerApp({ ... })` test call to pass a minimal `zonesById` map. Task 13 will replace `zone.defaultToolVmProfile ?? payload.profileId` with `selectToolVmProfileForLease(...)`.

In the `/lease` route, run seeding after `workspaceDir` is resolved and before `createLease()`:

```ts
await options.seedAgentSandbox?.({
	scopeKey: payload.scopeKey,
	workspaceDir,
	zoneId: payload.zoneId,
});
```

In `createControllerService()`, pass:

```ts
seedAgentSandbox: async ({ scopeKey, workspaceDir, zoneId }) => {
	const zone = zonesById.get(zoneId);
	if (!zone) {
		throw new Error(`Unknown zone '${zoneId}'`);
	}
	await ensureAgentSandboxSeeded({ scopeKey, workspaceDir, zone });
},
```

Add a route test proving order:

```ts
it('seeds an agent sandbox before creating the lease', async () => {
	const calls: string[] = [];
	const createLease = vi.fn(async () => {
		calls.push('createLease');
		return createLeaseStub('lease-seeded', 0);
	});
	const seedAgentSandbox = vi.fn(async () => {
		calls.push('seedAgentSandbox');
	});
	const app = createControllerApp({
		leaseManager: {
			createLease,
			getLease: vi.fn(),
			listLeases: vi.fn(() => []),
			releaseLease: vi.fn(async () => {}),
		},
		resolveLeaseWorkspaceDir: vi.fn(async () => '/host/state/sandboxes/shravan/work'),
		seedAgentSandbox,
		toolVmProfiles: { standard: { cpus: 1, memory: '1G', imageProfile: 'default' } },
		zonesById: new Map([['home', { id: 'home', defaultToolVmProfile: 'standard' }]]),
	});

	const response = await app.request('/lease', {
		body: JSON.stringify({
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'standard',
			scopeKey: 'agent:shravan:session-abc',
			workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/shravan/work',
			zoneId: 'home',
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});

	expect(response.status).toBe(200);
	expect(seedAgentSandbox).toHaveBeenCalledWith({
		scopeKey: 'agent:shravan:session-abc',
		workspaceDir: '/host/state/sandboxes/shravan/work',
		zoneId: 'home',
	});
	expect(calls).toEqual(['seedAgentSandbox', 'createLease']);
});
```

- [ ] **Step 6: Add validate and doctor visibility**

Extend the zone setup checks so operators can see configured sandbox seeds:

```ts
export function buildZoneAgentSandboxSeedSetupChecks(systemConfig: SystemConfig): readonly DoctorCheck[] {
	return systemConfig.zones.flatMap((zone) =>
		Object.entries(zone.agentSandboxSeeds ?? {}).flatMap(([agentId, seed]) =>
			seed.entries.map((entry, entryIndex) => ({
				name: `zone-agent-sandbox-seed-${zone.id}-${agentId}-${String(entryIndex)}`,
				ok: true,
				hint: `${entry.source} -> ${entry.target}; run validate to verify source readability`,
			}) satisfies DoctorCheck),
		),
	);
}
```

Add this builder to both `doctor` and `validate`, and add tests asserting a configured `.config/gcloud` seed appears in both command outputs.

For `agent-vm validate`, also add an async readability check for every seed source:

```ts
async function collectAgentSandboxSeedSourceChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly ConfigValidationCheck[]> {
	const checks = systemConfig.zones.flatMap((zone) =>
		Object.entries(zone.agentSandboxSeeds ?? {}).flatMap(([agentId, seed]) =>
			seed.entries.map((entry, entryIndex) =>
				collectReadableFileCheck(
					`agent-sandbox-seed-source-${zone.id}-${agentId}-${String(entryIndex)}`,
					entry.source,
				),
			),
		),
	);
	return await Promise.all(checks);
}
```

Include those checks in `runConfigValidation()` after the static zone setup checks. Keep schema loading independent from source existence so operators can stage seed paths after editing config, but make `validate` fail clearly before controller start when a source is missing.

- [ ] **Step 7: Update docs**

In `docs/reference/configuration/system-json.md`, add:

```json
{
  "id": "home",
  "agentSandboxSeeds": {
    "shravan": {
      "entries": [
        {
          "source": "~/.agent-vm/seeds/home/shravan/gcloud",
          "target": ".config/gcloud"
        }
      ]
    }
  }
}
```

Document:

```md
Sandbox seeding is scoped by zone and agent. It runs before the first tool VM
lease for an `agent:<agentId>` scope mounts the resolved workspace. Targets are
relative paths inside the sandbox workspace and may not contain `..`.
Seeding is idempotent per workspace; deleting the sandbox/marker is the manual
refresh mechanism for credentials such as `.config/gcloud`.
```

In `docs/subsystems/controller.md`, add the seed step between workspace resolution and `createLease()` in the lease lifecycle diagram.

- [ ] **Step 8: Run focused sandbox seed checks**

Run:

```bash
pnpm vitest run --config vitest.config.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/agent-vm/src/operations/config-validation.test.ts \
  packages/agent-vm/src/operations/doctor.test.ts
pnpm typecheck
```

Expected: tests PASS and typecheck exits `0`.

- [ ] **Step 9: Commit**

```bash
git add \
  packages/agent-vm/src/config/system-config.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/controller/leases/lease-scope.ts \
  packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts \
  packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/agent-vm/src/operations/doctor.ts \
  packages/agent-vm/src/operations/doctor.test.ts \
  packages/agent-vm/src/operations/config-validation.ts \
  packages/agent-vm/src/operations/config-validation.test.ts \
  docs/reference/configuration/system-json.md \
  docs/subsystems/controller.md
git commit -m "feat: seed agent sandboxes before tool leases" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 13: Add Per-Agent Tool VM Profile Selection Inside a Zone

**Files:**
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Test: `packages/agent-vm/src/config/system-config.test.ts`
- Create: `packages/agent-vm/src/controller/leases/tool-vm-profile-selection.ts`
- Test: `packages/agent-vm/src/controller/leases/tool-vm-profile-selection.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Test: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
- Modify: `packages/agent-vm/src/operations/doctor.ts`
- Test: `packages/agent-vm/src/operations/doctor.test.ts`
- Modify: `packages/agent-vm/src/operations/config-validation.ts`
- Test: `packages/agent-vm/src/operations/config-validation.test.ts`
- Test: `packages/agent-vm/src/cli/controller-operation-commands.test.ts`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/reference/validate-and-doctor.md`

- [ ] **Step 1: Add failing config schema tests for `agentToolVmProfiles`**

Add these tests to `packages/agent-vm/src/config/system-config.test.ts` near the existing tool VM profile validation tests:

```ts
test('loads per-agent tool VM profile mappings for OpenClaw zones', async () => {
	const config = createValidSystemConfigInput();
	config.toolVmProfiles = {
		standard: { cpus: 1, memory: '1G', imageProfile: 'default' },
		toolsDev: { cpus: 4, memory: '8G', imageProfile: 'default' },
		toolsLight: { cpus: 1, memory: '512M', imageProfile: 'default' },
	};
	config.zones = [
		{
			...config.zones[0],
			agentToolVmProfiles: {},
	agentToolVmProfiles: {
				alevtina: 'toolsLight',
				shravan: 'toolsDev',
			},
		},
	];
	const configPath = await writeSystemConfigForTest('agent-vm-system-agent-tools-', config);

	await expect(loadSystemConfig(configPath)).resolves.toMatchObject({
		zones: [
			expect.objectContaining({
				agentToolVmProfiles: {
					alevtina: 'toolsLight',
					shravan: 'toolsDev',
				},
				agentToolVmProfiles: {},
}),
		],
	});
});

test('rejects agentToolVmProfiles entries that reference unknown tool VM profiles', async () => {
	const config = createValidSystemConfigInput();
	config.zones = [
		{
			...config.zones[0],
			agentToolVmProfiles: {
				shravan: 'missing-tools',
			},
		},
	];
	const configPath = await writeSystemConfigForTest('agent-vm-system-agent-tools-missing-', config);

	await expect(loadSystemConfig(configPath)).rejects.toThrow(
		/Zone 'shravan' agentToolVmProfiles\['shravan'\] references unknown defaultToolVmProfile 'missing-tools'/u,
	);
});

test('rejects agentToolVmProfiles on worker zones because worker zones do not mint OpenClaw tool leases', async () => {
	const config = createValidSystemConfigInput();
	config.zones = [
		{
			...config.zones[0],
			gateway: {
				type: 'worker',
				imageProfile: 'worker',
				cpus: 2,
				config: './worker.json',
				memory: '2G',
				port: 18791,
				stateDir: './state/worker',
			},
			defaultToolVmProfile: undefined,
			agentToolVmProfiles: {
				shravan: 'default',
			},
		},
	];
	config.imageProfiles.gateways.worker = { type: 'worker', buildConfig: './worker-gateway.json' };
	const configPath = await writeSystemConfigForTest('agent-vm-system-agent-tools-worker-', config);

	await expect(loadSystemConfig(configPath)).rejects.toThrow(
		/Zone 'shravan' cannot declare agentToolVmProfiles because gateway type 'worker' does not create OpenClaw tool leases/u,
	);
});
```

- [ ] **Step 2: Run failing config tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/config/system-config.test.ts
```

Expected: FAIL because `agentToolVmProfiles` is not in the zone schema and no cross-reference validation exists.

- [ ] **Step 3: Add schema field and cross-reference validation**

In `packages/agent-vm/src/config/system-config.ts`, add the optional field next to `defaultToolVmProfile`:

```ts
agentToolVmProfiles: z.record(agentIdSchema, z.string().min(1)).optional(),
defaultToolVmProfile: z.string().min(1).optional(),
```

Then add validation after the existing `zone.defaultToolVmProfile` validation:

```ts
const agentIdsWithZoneAgentState = new Set([
	...Object.keys(zone.agentToolVmProfiles ?? {}),
	...Object.keys(zone.agentSandboxSeeds ?? {}),
]);
if (zone.gateway.type === 'openclaw') {
	for (const agentId of agentIdsWithZoneAgentState) {
		if (!zone.gateway.authProfilesByAgent?.[agentId]) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Zone '${zone.id}' agent '${agentId}' has per-agent zone state but no gateway.authProfilesByAgent entry.`,
				path: ['zones', zoneIndex, 'gateway', 'authProfilesByAgent', agentId],
			});
		}
	}
}

for (const [agentId, toolVmProfileId] of Object.entries(zone.agentToolVmProfiles ?? {})) {
	if (zone.gateway.type !== 'openclaw') {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: `Zone '${zone.id}' cannot declare agentToolVmProfiles because gateway type '${zone.gateway.type}' does not create OpenClaw tool leases.`,
			path: ['zones', zoneIndex, 'agentToolVmProfiles'],
		});
		break;
	}
	if (!config.toolVmProfiles[toolVmProfileId]) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: `Zone '${zone.id}' agentToolVmProfiles['${agentId}'] references unknown toolVmProfile '${toolVmProfileId}'.`,
			path: ['zones', zoneIndex, 'agentToolVmProfiles', agentId],
		});
	}
}
```

Keep `zone.defaultToolVmProfile` required for OpenClaw zones. `agentToolVmProfiles` is an override map; it is not a replacement for the fallback.

This cross-field check is intentional: the serious failure mode is a newly configured agent receiving a custom tool VM or seeded sandbox but no matching auth profile, then failing later inside OpenClaw with an unhelpful missing-credentials symptom. Schema validation should catch that setup drift at `agent-vm validate` time.

- [ ] **Step 4: Add validate and doctor visibility for zone/agent tool VM profile setup**

Add tests so `agent-vm validate` and `agent-vm doctor` make zone setup inspectable, not just silently accepted.

In `packages/agent-vm/src/operations/config-validation.test.ts`, add:

```ts
it('reports zone fallback and agent tool VM profile setup in validation output', async () => {
	const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
	const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
	const rawConfig = JSON.parse(await fs.readFile(systemConfigPath, 'utf8')) as Record<string, unknown>;
	await writeJson(systemConfigPath, {
		...rawConfig,
		toolVmProfiles: {
			standard: { cpus: 1, memory: '1G', imageProfile: 'standard' },
			toolsDev: { cpus: 4, memory: '8G', imageProfile: 'standard' },
		},
		zones: [
			{
				...((rawConfig.zones as [Record<string, unknown>])[0]),
				agentToolVmProfiles: {},
	agentToolVmProfiles: { shravan: 'toolsDev' },
			},
		],
	});
	const systemConfig = await loadSystemConfig(systemConfigPath);

	const result = await runConfigValidation({
		runCommand: async () => ({ exitCode: 0, stderr: '', stdout: '{"ok":true}\\n' }),
		systemConfig,
	});

	expect(result.checks).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: 'zone-tool-vm-profile-shravan',
				ok: true,
				hint: 'fallback=standard',
			}),
			expect.objectContaining({
				name: 'zone-agent-tool-vm-profile-shravan-shravan',
				ok: true,
				hint: 'shravan=toolsDev',
			}),
		]),
	);

	await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
});
```

In `packages/agent-vm/src/operations/doctor.test.ts`, add:

```ts
it('reports zone fallback and agent tool VM profile setup in doctor output', () => {
	const result = runControllerDoctor({
		availableBinaries: new Set([
			'qemu-system-aarch64',
			'qemu-img',
			'mke2fs',
			'debugfs',
			'cpio',
			'lz4',
			'openclaw',
		]),
		dockerDaemonReady: true,
		env: {},
		nodeVersion: 'v24.0.0',
		systemConfig: {
			...systemConfig,
			toolVmProfiles: {
				standard: { cpus: 1, memory: '1G', imageProfile: 'standard' },
				toolsDev: { cpus: 4, memory: '8G', imageProfile: 'standard' },
			},
			zones: [
				{
					...systemConfig.zones[0],
					agentToolVmProfiles: {},
	agentToolVmProfiles: { shravan: 'toolsDev' },
				},
			],
		},
	});

	expect(result.checks).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: 'zone-tool-vm-profile-shravan',
				ok: true,
				hint: 'fallback=standard',
			}),
			expect.objectContaining({
				name: 'zone-agent-tool-vm-profile-shravan-shravan',
				ok: true,
				hint: 'shravan=toolsDev',
			}),
		]),
	);
});
```

In `packages/agent-vm/src/cli/controller-operation-commands.test.ts`, add a doctor command integration assertion that the JSON output includes the same check names:

```ts
expect(parsedOutput.checks).toEqual(
	expect.arrayContaining([
		expect.objectContaining({ name: 'zone-tool-vm-profile-shravan', ok: true }),
		expect.objectContaining({ name: 'zone-agent-tool-vm-profile-shravan-shravan', ok: true }),
	]),
);
```

Implement the shared check builder in `packages/agent-vm/src/operations/doctor.ts`:

```ts
export function buildZoneToolVmProfileSetupChecks(systemConfig: SystemConfig): readonly DoctorCheck[] {
	return systemConfig.zones.flatMap((zone) => [
		...(zone.defaultToolVmProfile
			? [
					{
						name: `zone-tool-vm-profile-${zone.id}`,
						ok: true,
						hint: `fallback=${zone.defaultToolVmProfile}`,
					} satisfies DoctorCheck,
				]
			: []),
		...Object.entries(zone.agentToolVmProfiles ?? {}).map(
			([agentId, toolVmProfileId]) =>
				({
					name: `zone-agent-tool-vm-profile-${zone.id}-${agentId}`,
					ok: true,
					hint: `${agentId}=${toolVmProfileId}`,
				}) satisfies DoctorCheck,
		),
	]);
}
```

Add `...buildZoneToolVmProfileSetupChecks(options.systemConfig)` to the `runControllerDoctor()` `checks` array after `gateway-image-profile-selected-*`.

In `packages/agent-vm/src/operations/config-validation.ts`, import and include the same checks:

```ts
import {
	buildRuntimePathIsolationChecks,
	buildZoneToolVmProfileSetupChecks,
	collectVmHostSystemDoctorCheck,
} from './doctor.js';
```

Add `...buildZoneToolVmProfileSetupChecks(systemConfig)` to the `checks` array after `buildRuntimePathIsolationChecks(systemConfig)`.

- [ ] **Step 5: Add tool VM profile selection unit tests**

Create `packages/agent-vm/src/controller/leases/tool-vm-profile-selection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseAgentIdFromScopeKey } from './lease-scope.js';
import { selectToolVmProfileForLease } from './tool-vm-profile-selection.js';

const zone = {
	id: 'home',
	defaultToolVmProfile: 'standard',
	agentToolVmProfiles: {
		alevtina: 'tools-light',
		shravan: 'tools-dev',
	},
} as const;

describe('parseAgentIdFromScopeKey', () => {
	it('extracts the agent id from agent-scoped leases', () => {
		expect(parseAgentIdFromScopeKey('agent:shravan')).toBe('shravan');
		expect(parseAgentIdFromScopeKey('agent:alevtina:session-123')).toBe('alevtina');
		expect(parseAgentIdFromScopeKey('agent:shravan:session-abc:retry-1')).toBe('shravan');
	});

	it('returns null for non-agent or malformed scope keys', () => {
		expect(parseAgentIdFromScopeKey('project:main')).toBeNull();
		expect(parseAgentIdFromScopeKey('agent')).toBeNull();
		expect(parseAgentIdFromScopeKey('agent:')).toBeNull();
		expect(parseAgentIdFromScopeKey('')).toBeNull();
	});
});

describe('selectToolVmProfileForLease', () => {
	it('selects the per-agent tool VM profile for an agent scope', () => {
		expect(selectToolVmProfileForLease({ scopeKey: 'agent:shravan', zone })).toBe('tools-dev');
		expect(selectToolVmProfileForLease({ scopeKey: 'agent:alevtina:session-123', zone })).toBe(
			'tools-light',
		);
	});

	it('falls back to the zone defaultToolVmProfile when no agent override matches', () => {
		expect(selectToolVmProfileForLease({ scopeKey: 'agent:family', zone })).toBe('standard');
		expect(selectToolVmProfileForLease({ scopeKey: 'workspace:shared', zone })).toBe('standard');
	});

	it('throws when a zone has no fallback defaultToolVmProfile', () => {
		expect(() =>
			selectToolVmProfileForLease({
				scopeKey: 'agent:shravan',
				zone: { id: 'worker-zone', agentToolVmProfiles: {} },
			}),
		).toThrow("Zone 'worker-zone' does not have a tool VM profile configured");
	});
});
```

- [ ] **Step 6: Implement the selection helper**

Create `packages/agent-vm/src/controller/leases/tool-vm-profile-selection.ts`:

```ts
import type { SystemConfig } from '../../config/system-config.js';
import { parseAgentIdFromScopeKey } from './lease-scope.js';

type ZoneConfig = SystemConfig['zones'][number];

export function selectToolVmProfileForLease(options: {
	readonly scopeKey: string;
	readonly zone: Pick<ZoneConfig, 'agentToolVmProfiles' | 'id' | 'defaultToolVmProfile'>;
}): string {
	const agentId = parseAgentIdFromScopeKey(options.scopeKey);
	if (agentId) {
		const agentToolVmProfile = options.zone.agentToolVmProfiles?.[agentId];
		if (agentToolVmProfile) {
			return agentToolVmProfile;
		}
	}
	if (!options.zone.defaultToolVmProfile) {
		throw new Error(`Zone '${options.zone.id}' does not have a tool VM profile configured`);
	}
	return options.zone.defaultToolVmProfile;
}
```

- [ ] **Step 7: Add failing HTTP route tests for per-agent selection**

Add this test to `packages/agent-vm/src/controller/http/controller-http-routes.test.ts` near the existing “uses the zone defaultToolVmProfile” test:

Import `LeaseScopeConflictError` from `../leases/lease-manager.js` for the conflict-path test.

```ts
it('uses agentToolVmProfiles for agent-scoped leases before falling back to the zone defaultToolVmProfile', async () => {
	const createLease = vi.fn(async () => createLeaseStub('lease-agent-tools', 0));
	const app = createControllerApp({
		leaseManager: {
			createLease,
			getLease: vi.fn(),
			listLeases: vi.fn(() => []),
			releaseLease: vi.fn(async () => {}),
		},
		toolVmProfiles: {
			standard: { cpus: 1, memory: '1G', imageProfile: 'default' },
			toolsDev: { cpus: 4, memory: '8G', imageProfile: 'dev-tools' },
		},
		zonesById: new Map([
			[
				'home',
				{
					id: 'home',
					agentToolVmProfiles: {},
	agentToolVmProfiles: { shravan: 'toolsDev' },
				},
			],
		]),
	});

	const createResponse = await app.request('/lease', {
		body: JSON.stringify({
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'standard',
			scopeKey: 'agent:shravan:session-abc',
			workspaceDir: '/home/openclaw/.openclaw/sandboxes/session/work',
			zoneId: 'home',
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});

	expect(createResponse.status).toBe(200);
	expect(createLease).toHaveBeenCalledWith(
		expect.objectContaining({
			profile: { cpus: 4, memory: '8G', imageProfile: 'dev-tools' },
			profileId: 'toolsDev',
			scopeKey: 'agent:shravan:session-abc',
			zoneId: 'home',
		}),
	);
});

it('returns a lease scope conflict when an existing agent-scoped lease uses a different effective tool VM profile', async () => {
	const createLease = vi.fn(async () => {
		throw new LeaseScopeConflictError(
			"Existing lease for scope 'agent:shravan:session-abc' uses profile 'standard', requested 'toolsDev'.",
		);
	});
	const app = createControllerApp({
		leaseManager: {
			createLease,
			getLease: vi.fn(),
			listLeases: vi.fn(() => []),
			releaseLease: vi.fn(async () => {}),
		},
		toolVmProfiles: {
			standard: { cpus: 1, memory: '1G', imageProfile: 'default' },
			toolsDev: { cpus: 4, memory: '8G', imageProfile: 'dev-tools' },
		},
		zonesById: new Map([
			[
				'home',
				{
					id: 'home',
					agentToolVmProfiles: {},
	agentToolVmProfiles: { shravan: 'toolsDev' },
				},
			],
		]),
	});

	const createResponse = await app.request('/lease', {
		body: JSON.stringify({
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'standard',
			scopeKey: 'agent:shravan:session-abc',
			workspaceDir: '/home/openclaw/.openclaw/sandboxes/session/work',
			zoneId: 'home',
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});

	expect(createResponse.status).toBe(409);
});
```

Update the existing “uses the zone defaultToolVmProfile instead of trusting the requested profileId” test to pass `zonesById` and expect fallback selection:

```ts
zonesById: new Map([
	[
		'shravan',
		{
			id: 'shravan',
			agentToolVmProfiles: {},
},
	],
]),
```

For every other direct `createControllerApp({ ... })` call in `controller-http-routes.test.ts`, add the smallest `zonesById` map needed by that test. Lease-route tests that use `zoneId: 'shravan'` should include:

```ts
zonesById: new Map([
	[
		'shravan',
		{
			id: 'shravan',
			agentToolVmProfiles: {},
},
	],
]),
```

Tests that intentionally use an unknown zone should keep `zonesById` without that zone and assert the request returns `400` without calling `createLease`. This is the intentional exception to the path-based `404` unknown-zone contract because `/lease` carries `zoneId` in a JSON payload rather than as a route parameter.

- [ ] **Step 8: Replace zone-only lease profile resolution in HTTP routes**

In `packages/agent-vm/src/controller/http/controller-http-routes.ts`, import the helper:

```ts
import { selectToolVmProfileForLease } from '../leases/tool-vm-profile-selection.js';
```

Extend the `zonesById` option introduced in Task 12 to include `agentToolVmProfiles`:

```ts
	readonly zonesById: ReadonlyMap<
	string,
	{
		readonly agentToolVmProfiles?: Readonly<Record<string, string>>;
		readonly id: string;
		readonly defaultToolVmProfile?: string;
	}
>;
```

`zonesById` is now the single source of zone existence, sandbox seed config, and fallback/agent tool VM profile data for lease creation. Use `rg -n 'zoneDefaultToolVmProfiles' packages/agent-vm/src/controller/http/controller-http-routes.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts` to confirm Task 12 removed the old option. Replace the Task 12 fallback `resolvedProfileId` line with:

```ts
const zone = options.zonesById.get(payload.zoneId);
if (!zone) {
	return context.json({ error: `Unknown zone '${payload.zoneId}'` }, 400);
}
const resolvedProfileId = selectToolVmProfileForLease({
	scopeKey: payload.scopeKey,
	zone,
});
```

Then update `createControllerService` to pass the real zones:

```ts
const zonesById = new Map(options.systemConfig.zones.map((zone) => [zone.id, zone]));
const app = createControllerApp({
	leaseManager: options.leaseManager,
	toolVmProfiles: options.systemConfig.toolVmProfiles,
	zonesById,
	...(options.operations ? { operations: options.operations } : {}),
	resolveLeaseWorkspaceDir: async ({ workspaceDir, zoneId }) => {
		const zone = zonesById.get(zoneId);
		if (!zone) {
			throw new Error(`Unknown zone '${zoneId}'`);
		}
		return await resolveLeaseWorkspaceDirForZone({ workspaceDir, zone });
	},
});
```

- [ ] **Step 9: Update configuration, manual setup, validate, and doctor docs**

In `docs/reference/configuration/system-json.md`, add `agentToolVmProfiles` next to `defaultToolVmProfile`:

````md
`zones[].defaultToolVmProfile` is the fallback tool VM profile for OpenClaw leases.
`zones[].agentToolVmProfiles` optionally overrides that fallback for agent-scoped
leases where `scopeKey` starts with `agent:<agentId>`.
Only OpenClaw zones may declare `agentToolVmProfiles`; worker zones do not create
OpenClaw tool leases.

```json
{
  "id": "home",
  "defaultToolVmProfile": "standard",
 "agentToolVmProfiles": {},
  "agentToolVmProfiles": {
    "shravan": "tools-dev",
    "alevtina": "tools-light"
  }
}
```

For `scopeKey: "agent:shravan:session-123"`, the controller selects
`tools-dev`. For `scopeKey: "agent:unknown"` or non-agent scope keys, it falls
back to `defaultToolVmProfile`.
````

Also update the Cross-Field Validation list in the same file:

```md
- `agentToolVmProfiles` on non-OpenClaw zones.
- `agentToolVmProfiles` entries referencing missing tool VM profiles.
```

Update `docs/reference/validate-and-doctor.md` so manual setup is clear:

````md
`validate` also reports zone tool VM profile setup:

- `zone-tool-vm-profile-<zoneId>` shows the fallback tool VM profile for that zone.
- `zone-agent-tool-vm-profile-<zoneId>-<agentId>` shows each per-agent override.

`doctor` reports the same checks against the host-loaded config, so a runtime
operator can confirm that multiple agents in one zone will resolve to the
expected tool VM profiles before starting the controller.

Manual check after editing `system.json`:

```bash
agent-vm validate --config config/system.json
agent-vm doctor --config config/system.json
```

Both commands should show the fallback `zone-tool-vm-profile-*` check and every
configured `zone-agent-tool-vm-profile-*` override.
````

- [ ] **Step 10: Run focused tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/controller/leases/tool-vm-profile-selection.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/agent-vm/src/operations/config-validation.test.ts \
  packages/agent-vm/src/operations/doctor.test.ts \
  packages/agent-vm/src/cli/controller-operation-commands.test.ts
pnpm typecheck
```

Expected: tests PASS and typecheck exits `0`.

- [ ] **Step 11: Commit**

```bash
git add \
  packages/agent-vm/src/config/system-config.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/controller/leases/tool-vm-profile-selection.ts \
  packages/agent-vm/src/controller/leases/tool-vm-profile-selection.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/agent-vm/src/operations/doctor.ts \
  packages/agent-vm/src/operations/doctor.test.ts \
  packages/agent-vm/src/operations/config-validation.ts \
  packages/agent-vm/src/operations/config-validation.test.ts \
  packages/agent-vm/src/cli/controller-operation-commands.test.ts \
  docs/reference/configuration/system-json.md \
  docs/reference/validate-and-doctor.md
git commit -m "feat: select tool vm profiles per agent scope" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 14: Add Per-Scope Lease Idle TTLs

**Files:**
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Test: `packages/agent-vm/src/config/system-config.test.ts`
- Create: `packages/agent-vm/src/controller/leases/lease-idle-policy.ts`
- Test: `packages/agent-vm/src/controller/leases/lease-idle-policy.test.ts`
- Modify: `packages/agent-vm/src/controller/leases/idle-reaper.ts`
- Test: `packages/agent-vm/src/controller/leases/idle-reaper.test.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Test: `packages/agent-vm/src/controller/controller-runtime.test.ts`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/subsystems/controller.md`

- [ ] **Step 1: Add failing config tests**

Add:

```ts
test('loads lease idle TTL policy by exact scope key and scope kind', async () => {
	const config = createValidSystemConfigInput();
	config.leaseIdleTtl = {
		defaultMs: 30 * 60 * 1000,
		byScopeKind: {
			agent: 2 * 60 * 60 * 1000,
			workspace: 15 * 60 * 1000,
		},
		byScopePrefix: {
			'agent:shravan': 6 * 60 * 60 * 1000,
		},
	};
	const configPath = await writeSystemConfigForTest('agent-vm-system-lease-ttl-', config);

	await expect(loadSystemConfig(configPath)).resolves.toMatchObject({
		leaseIdleTtl: {
			defaultMs: 1_800_000,
			byScopeKind: { agent: 7_200_000, workspace: 900_000 },
			byScopePrefix: { 'agent:shravan': 21_600_000 },
		},
	});
});

test('rejects non-positive lease idle TTL values', async () => {
	const config = createValidSystemConfigInput();
	config.leaseIdleTtl = { defaultMs: 0 };
	const configPath = await writeSystemConfigForTest('agent-vm-system-bad-lease-ttl-', config);

	await expect(loadSystemConfig(configPath)).rejects.toThrow(/leaseIdleTtl/u);
});
```

- [ ] **Step 2: Add schema**

In `system-config.ts`, add:

```ts
const leaseIdleTtlSchema = z
	.object({
		defaultMs: z.number().int().positive().default(30 * 60 * 1000),
		byScopeKind: z.record(z.string().min(1), z.number().int().positive()).default({}),
		byScopePrefix: z.record(z.string().min(1), z.number().int().positive()).default({}),
	})
	.strict();
```

Add to the root config:

```ts
leaseIdleTtl: leaseIdleTtlSchema.default({}),
```

- [ ] **Step 3: Add policy tests**

Create `packages/agent-vm/src/controller/leases/lease-idle-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { ttlForLeaseScope } from './lease-idle-policy.js';

describe('ttlForLeaseScope', () => {
	it('prefers exact scope key over scope kind and default', () => {
		expect(
			ttlForLeaseScope({
				scopeKey: 'agent:shravan:session-1',
				policy: {
					defaultMs: 1_800_000,
					byScopeKind: { agent: 7_200_000 },
					byScopePrefix: { 'agent:shravan': 21_600_000 },
				},
			}),
		).toBe(21_600_000);
	});

	it('uses scope kind when there is no exact agent override', () => {
		expect(
			ttlForLeaseScope({
				scopeKey: 'agent:alevtina:session-1',
				policy: {
					defaultMs: 1_800_000,
					byScopeKind: { agent: 7_200_000 },
					byScopePrefix: {},
				},
			}),
		).toBe(7_200_000);
	});

	it('falls back to default for unknown scope kinds', () => {
		expect(
			ttlForLeaseScope({
				scopeKey: 'project:shared',
				policy: {
					defaultMs: 1_800_000,
					byScopeKind: { agent: 7_200_000 },
					byScopePrefix: {},
				},
			}),
		).toBe(1_800_000);
	});
});
```

- [ ] **Step 4: Implement policy helper**

Create `packages/agent-vm/src/controller/leases/lease-idle-policy.ts`:

```ts
export interface LeaseIdleTtlPolicy {
	readonly defaultMs: number;
	readonly byScopeKind: Readonly<Record<string, number>>;
	readonly byScopePrefix: Readonly<Record<string, number>>;
}

function scopePrefixes(scopeKey: string): readonly string[] {
	const segments = scopeKey.split(':').filter((segment) => segment.length > 0);
	return segments.map((_segment, index) => segments.slice(0, index + 1).join(':')).reverse();
}

export function ttlForLeaseScope(options: {
	readonly policy: LeaseIdleTtlPolicy;
	readonly scopeKey: string;
}): number {
	for (const prefix of scopePrefixes(options.scopeKey)) {
		const ttl = options.policy.byScopePrefix[prefix];
		if (ttl !== undefined) {
			return ttl;
		}
	}
	const scopeKind = options.scopeKey.split(':')[0] ?? '';
	return options.policy.byScopeKind[scopeKind] ?? options.policy.defaultMs;
}
```

- [ ] **Step 5: Update idle reaper**

Change `createIdleReaper()` so each lease computes its own cutoff:

```ts
export function createIdleReaper(options: {
	readonly getLeases: () => {
		readonly id: string;
		readonly lastUsedAt: number;
		readonly scopeKey: string;
	}[];
	readonly now: () => number;
	readonly releaseLease: (
		leaseId: string,
		options?: { readonly ifLastUsedAtBeforeOrAt?: number },
	) => Promise<void>;
	readonly ttlForLease: (lease: { readonly scopeKey: string }) => number;
}): { reapExpiredLeases(): Promise<void> } {
	return {
		async reapExpiredLeases(): Promise<void> {
			const now = options.now();
			const expiredLeases = options.getLeases().flatMap((lease) => {
				const expirationCutoff = now - options.ttlForLease(lease);
				return lease.lastUsedAt < expirationCutoff
					? [{ expirationCutoff, leaseId: lease.id }]
					: [];
			});
			for (const expiredLease of expiredLeases) {
				await options.releaseLease(expiredLease.leaseId, {
					ifLastUsedAtBeforeOrAt: expiredLease.expirationCutoff,
				});
			}
		},
	};
}
```

Update `idle-reaper.test.ts` to prove two leases with different scope TTLs expire independently.

- [ ] **Step 6: Wire runtime policy**

In `controller-runtime.ts`, replace hardcoded `ttlMs: 30 * 60 * 1000` with:

```ts
ttlForLease: (lease) =>
	ttlForLeaseScope({
		policy: options.systemConfig.leaseIdleTtl,
		scopeKey: lease.scopeKey,
	}),
```

Add a runtime test that creates the idle reaper with a policy where `agent` TTL differs from default and verifies the callback receives per-scope policy behavior.

- [ ] **Step 7: Update docs**

In `docs/reference/configuration/system-json.md`, add:

```json
"leaseIdleTtl": {
  "defaultMs": 1800000,
  "byScopeKind": {
    "agent": 7200000
  },
  "byScopePrefix": {
    "agent:shravan": 21600000
  }
}
```

Document precedence: longest matching `byScopePrefix` prefix, then `byScopeKind`, then `defaultMs`.

- [ ] **Step 8: Run focused checks**

Run:

```bash
pnpm vitest run --config vitest.config.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/controller/leases/lease-idle-policy.test.ts \
  packages/agent-vm/src/controller/leases/idle-reaper.test.ts \
  packages/agent-vm/src/controller/controller-runtime.test.ts
pnpm typecheck
```

Expected: tests PASS and typecheck exits `0`.

- [ ] **Step 9: Commit**

```bash
git add \
  packages/agent-vm/src/config/system-config.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/controller/leases/lease-idle-policy.ts \
  packages/agent-vm/src/controller/leases/lease-idle-policy.test.ts \
  packages/agent-vm/src/controller/leases/idle-reaper.ts \
  packages/agent-vm/src/controller/leases/idle-reaper.test.ts \
  packages/agent-vm/src/controller/controller-runtime.ts \
  packages/agent-vm/src/controller/controller-runtime.test.ts \
  docs/reference/configuration/system-json.md \
  docs/subsystems/controller.md
git commit -m "feat: configure lease idle ttl by scope" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 15: Clean Retry Wording and Verify TCP Pool Default

**Files:**
- Modify: `packages/agent-vm/src/controller/git-push-operations.ts`
- Test: `packages/agent-vm/src/controller/git-push-operations.test.ts`
- Modify: `packages/agent-vm/src/controller/git-pull-default-operations.ts`
- Test: `packages/agent-vm/src/controller/git-pull-default-operations.test.ts`
- Test: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/getting-started/openclaw-guide.md`

- [ ] **Step 1: Add/adjust retry wording tests**

In push and pull tests, assert transient failure messages no longer contain the stale instruction:

```ts
expect(result.results[0]?.error).not.toContain('otherwise start a new task');
expect(result.results[0]?.error).toContain('Try git-push again in 5 minutes after the controller reports the task is still available');
```

For pull-default:

```ts
expect(result.error).not.toContain('otherwise start a new task');
expect(result.error).toContain('Try git-pull-default again in 5 minutes after the controller reports the task is still available');
```

- [ ] **Step 2: Update constants**

In `git-push-operations.ts`:

```ts
const GIT_PUSH_RETRY_AFTER_MESSAGE =
	'GitHub or the network is still rejecting the push after retries. Try git-push again in 5 minutes after the controller reports the task is still available.';
```

In `git-pull-default-operations.ts`:

```ts
const GIT_PULL_RETRY_AFTER_MESSAGE =
	'GitHub or the network is still rejecting the pull after retries. Try git-pull-default again in 5 minutes after the controller reports the task is still available.';
```

- [ ] **Step 3: Verify `tcpPool.size` generated default remains 12**

Current `origin/master` already sets `packages/agent-vm/src/cli/init-command.ts` generated `tcpPool.size` to `12`, with `init-command.test.ts` asserting:

```ts
expect(config.tcpPool).toEqual({ basePort: 19000, size: 12 });
```

Keep that behavior. Add/update docs to say generated configs default to 12 process-wide TCP slots. Do not rewrite every unit fixture from `5` to `12`; small fixture pools are intentional unless they test generated defaults.

- [ ] **Step 4: Run focused checks**

Run:

```bash
pnpm vitest run --config vitest.config.ts \
  packages/agent-vm/src/controller/git-push-operations.test.ts \
  packages/agent-vm/src/controller/git-pull-default-operations.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts
pnpm typecheck
```

Expected: tests PASS and typecheck exits `0`.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/agent-vm/src/controller/git-push-operations.ts \
  packages/agent-vm/src/controller/git-push-operations.test.ts \
  packages/agent-vm/src/controller/git-pull-default-operations.ts \
  packages/agent-vm/src/controller/git-pull-default-operations.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts \
  docs/reference/configuration/system-json.md \
  docs/getting-started/openclaw-guide.md
git commit -m "fix: refresh controller git retry guidance" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 16: Update Controller and Architecture Docs

**Files:**
- Modify: `docs/subsystems/controller.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/architecture/storage-model.md`
- Modify: `docs/architecture/storage-matrix.md`
- Modify: `docs/subsystems/gateway-lifecycle.md`
- Modify: `docs/subsystems/secrets-and-credentials.md`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/reference/validate-and-doctor.md`
- Modify: `docs/getting-started/openclaw-guide.md`

- [ ] **Step 1: Update runtime lifecycle docs**

Replace the “Find active zone” and “Start gateway zone” startup sections with:

```md
    |-- 3. Select zones
    |      options.zoneIds if provided, otherwise every zone in systemConfig.zones
    |      controller start without --zone starts all zones
    |      controller start --zone <id> starts one zone for maintenance/debugging
    |
    |-- 4. Create shared services
    |      TCP pool, lease manager, task registry, request heartbeat registry
    |      These are process-wide and zone-aware
    |
    |-- 5. Create zone runtime registry
    |      One typed runtime per selected zone:
    |      OpenClawZoneRuntime for persistent gateway zones
    |      WorkerZoneRuntime for task-driven worker zones
    |
    |-- 6. Start selected persistent gateway zones
    |      OpenClaw zones boot at controller startup
    |      Worker zones do not boot a persistent gateway
    |      Startup is partial: failed zones record lastError; healthy zones stay online
```

- [ ] **Step 2: Update operations docs**

Replace the single active-zone statement with:

```md
`createControllerRuntimeOperations()` dispatches every operation by route
`:zoneId` through the zone runtime registry. OpenClaw operations require an
OpenClaw zone runtime. Worker task operations require a Worker zone runtime.
Unsupported operations return a typed unsupported-zone-operation response
instead of falling through to another zone or returning an ambiguous 500.
```

- [ ] **Step 3: Add operator scaling notes**

Add:

```md
`tcpPool.size` is process-wide, not per-zone. Size it for the sum of expected
concurrent leases across all running OpenClaw zones and agents. For example, two
zones with three concurrent agent leases each need at least six tool-VM TCP
slots before headroom.

`controller start` without `--zone` starts every cached zone it can and reports
uncached zones as failed startup snapshots. `controller start --zone <id>`
remains fail-fast when that specific zone image is not cached.
```

- [ ] **Step 4: Update cross-architecture docs**

Make these concrete doc updates:

- `docs/architecture/overview.md`: one controller process owns a `ZoneRuntimeRegistry`; each route dispatches by `zoneId`; shared services are explicitly zone-aware.
- `docs/architecture/openclaw-gateway.md`: lease profile selection uses `scopeKey`; auth profiles are written per `zoneId` and `agentId`; sandbox seeds run before first agent-scoped lease boot.
- `docs/architecture/storage-model.md`: durable OpenClaw state includes `stateDir/agents/<agentId>/agent/auth-profiles.json`; seed markers live beside sandbox workspaces; `zoneFilesDir` remains long-lived zone files.
- `docs/architecture/storage-matrix.md`: classify auth profile files as durable secret-derived state and sandbox seed outputs as workspace-local copied config.
- `docs/subsystems/gateway-lifecycle.md`: replace every `agents/main/agent/auth-profiles.json` reference with `agents/<agentId>/agent/auth-profiles.json`.
- `docs/subsystems/secrets-and-credentials.md`: document `authProfilesByAgent` and state there is no shared fallback between zones or agents.
- `docs/reference/configuration/system-json.md`: include `authProfilesByAgent`, `agentToolVmProfiles`, `agentSandboxSeeds`, `leaseIdleTtl`, and generated `tcpPool.size: 12`.
- `docs/reference/validate-and-doctor.md`: list new checks for per-agent auth profiles, sandbox seeds, tool VM profile mappings, and lease TTL policy.
- `docs/getting-started/openclaw-guide.md`: update the sample config to the new schema.

- [ ] **Step 5: Run docs-sensitive checks**

Run:

```bash
pnpm fmt:check
```

Expected: PASS or docs formatting-only diff identified by Oxfmt.

- [ ] **Step 6: Commit**

```bash
git add \
  docs/subsystems/controller.md \
  docs/architecture/overview.md \
  docs/architecture/openclaw-gateway.md \
  docs/architecture/storage-model.md \
  docs/architecture/storage-matrix.md \
  docs/subsystems/gateway-lifecycle.md \
  docs/subsystems/secrets-and-credentials.md \
  docs/reference/configuration/system-json.md \
  docs/reference/validate-and-doctor.md \
  docs/getting-started/openclaw-guide.md
git commit -m "docs: describe multi-zone agent-scoped controller architecture" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 17: Full Verification Gate

**Files:**
- No source edits unless verification exposes failures.

- [ ] **Step 1: Run focused multi-zone test set**

Run:

```bash
pnpm vitest run --config vitest.config.ts \
  packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts \
  packages/agent-vm/src/controller/controller-runtime.test.ts \
  packages/agent-vm/src/controller/controller-runtime-operations.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/openclaw-gateway/src/openclaw-lifecycle.test.ts \
  packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts \
  packages/agent-vm/src/controller/leases/lease-idle-policy.test.ts \
  packages/agent-vm/src/controller/leases/idle-reaper.test.ts \
  packages/agent-vm/src/controller/leases/tool-vm-profile-selection.test.ts \
  packages/agent-vm/src/controller/git-push-operations.test.ts \
  packages/agent-vm/src/controller/git-pull-default-operations.test.ts \
  packages/agent-vm/src/operations/config-validation.test.ts \
  packages/agent-vm/src/operations/doctor.test.ts \
  packages/agent-vm/src/operations/controller-status.test.ts \
  packages/agent-vm/src/cli/controller-operation-commands.test.ts \
  packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts \
  packages/agent-vm/src/cli/commands/controller-definition.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts \
  packages/agent-vm/src/cli/vm-host-system-templates.test.ts \
  packages/agent-vm/src/integration-tests/live-api-smoke.integration.test.ts
```

Expected: all listed files PASS.

- [ ] **Step 2: Run repo quality checks**

Run:

```bash
pnpm fmt:check
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:smoke
```

Expected: every command exits `0`.

- [ ] **Step 3: Run full quality gate**

Run:

```bash
pnpm check
```

Expected: exit `0`.

- [ ] **Step 4: Report evidence**

Report exact pass counts and exit codes from:

- focused Vitest run
- `pnpm fmt:check`
- `pnpm lint`
- `pnpm lint:types`
- `pnpm typecheck`
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm test:smoke`
- `pnpm check`

- [ ] **Step 5: Check for verification changes**

Run:

```bash
git status --short
```

Expected: clean worktree after the task commits above. If verification exposed a real code issue, fix it in the task that introduced the issue, rerun that task's focused tests, and use that task's commit pattern instead of creating a generic verification commit.

---

## Self-Review

- Spec coverage:
  - Partial-start behavior is covered by Tasks 5, 7, and 10.
  - BC-combined architecture is covered by Tasks 2, 3, 4, and 5.
  - Zone-keyed API dispatch is covered by Tasks 6, 7, and 8.
  - CLI all-zone default is covered by Task 9.
  - Logs for all zones are covered by Tasks 3, 6, 7, 8, and 10.
  - Per-zone and per-agent OpenClaw auth profile separation is covered by Task 11.
  - Per-agent sandbox seeding on first lease boot is covered by Task 12.
  - Per-agent tool VM profiles inside one zone are covered by Task 13.
  - Per-scope idle TTLs are covered by Task 14.
  - Stale git retry-after wording and generated `tcpPool.size: 12` verification are covered by Task 15.
  - Manual setup, `agent-vm validate`, and `agent-vm doctor` visibility for zone setup are covered by Tasks 11, 12, 13, and 14.
  - Local smoke testing is covered by Task 10.
  - Architecture and operator docs are covered by Task 16.
  - Full verification is covered by Task 17.
- Placeholder scan:
  - No `TBD`, `TODO`, or “implement later” placeholders are intentionally present.
  - Worker runtime explicitly threads `secretResolver` into `executeWorkerTaskDefault`.
- Type consistency:
  - Status uses `ControllerRuntimeStatus['zones']` and `ControllerZoneLifecycleState`.
  - Runtime dispatch uses `getOpenClawRuntime(zoneId)` and `getWorkerRuntime(zoneId)`.
  - CLI uses `zoneIds?: readonly string[]`.
  - Auth profile paths use `agents/<agentId>/agent/auth-profiles.json`; no implicit `main` fallback remains.
  - Sandbox seed targets are relative workspace paths and reject `..`.
  - Idle reaping uses `ttlForLeaseScope`, not a global `ttlMs`.
  - Lease profile selection uses `agentToolVmProfiles[agentId]` before falling back to `defaultToolVmProfile`.
- Scope check:
  - This is one coherent subsystem change: controller runtime zone ownership and route dispatch.
  - Publishing, release tagging, and RealFS provider improvements are deliberately excluded.
