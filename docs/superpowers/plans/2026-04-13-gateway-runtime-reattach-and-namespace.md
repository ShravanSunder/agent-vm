# Gateway Runtime Reattach And Namespace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make controller restarts crash-safe for gateway VMs by persisting runtime identity, reattaching to an existing healthy gateway when possible, introducing a stable per-project namespace so gateway identities do not collide across projects that reuse the same zone id, and hard-cutting gateway naming from `coding` to `worker`.

**Architecture:** Add a stable `host.projectNamespace` to `system.json`, persist a `gateway-runtime.json` record under each zone state directory, add an upstream Gondolin SDK attach primitive, then expose that through `attachManagedVm()` in our adapter and change controller startup from "always create" to "attach-or-create". The controller will continue to shut down the gateway on an intentional `controller stop`, but on crash-only restarts it will attempt to reattach to the previously running gateway VM and reuse its ingress if healthy.

**Tech Stack:** TypeScript, Zod, cmd-ts, Gondolin VM adapter, Vitest, pnpm

---

## Why We Are Doing This

Today the controller stores the gateway runtime only in memory. If the controller process dies unexpectedly but the gateway VM stays alive, the next controller startup does not reconnect to that existing gateway. It simply starts another one.

That causes three concrete problems:

1. **Crash recovery is broken**
   - We already persist gateway files like config, auth profiles, and workspace/state directories.
   - But we do **not** persist the runtime identity of the gateway VM itself.
   - So a controller crash loses ownership of a still-running gateway.

2. **Duplicate gateway VMs are possible**
   - Restarting the controller after a crash creates a new gateway even if the old one is still alive.
   - This wastes resources and makes operator behavior surprising.

3. **Gateway identity is under-namespaced**
   - Current session labels are built from `zone.id` alone, for example `shravan-gateway`.
   - Two different projects using the same zone id can collide conceptually and operationally.

## Defensible Problem Statement

This is not just a UX annoyance. It is a missing persistence boundary in the runtime model.

Current persistent state answers:

- "what config/auth/workspace should the gateway use?"

Current persistent state does **not** answer:

- "which gateway VM is currently running?"
- "how do I reopen it after the controller dies?"

That gap exists in three places:

- [packages/agent-vm/src/controller/controller-runtime.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/controller-runtime.ts)
  - always starts a gateway on controller boot
- [packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts)
  - always calls `createManagedVm(...)`
- [packages/gondolin-core/src/vm-adapter.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/gondolin-core/src/vm-adapter.ts)
  - exposes create/exec/ssh/ingress/close only; no attach/reopen API exists

So the fix must be cross-layer:

- config/state model
- upstream Gondolin SDK capability
- Gondolin adapter
- controller startup flow

## Non-Goals

- Recovering active tool leases across controller crashes
- Recovering in-memory lease-manager bookkeeping
- Multi-zone concurrent controller recovery in the first pass
- Replacing `zone.id` as the user-facing zone selector

The first pass should recover **gateway runtime ownership only**. Existing tool leases may die and be recreated later.

## External Dependency / Design Gate

This plan depends on an upstream capability that does **not** exist in the current Gondolin SDK surface.

Current direct evidence:
- [packages/gondolin-core/src/vm-adapter.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/gondolin-core/src/vm-adapter.ts)
  only wraps `VM.create(...)`
- there is no `VM.attach(...)`, `VM.fromId(...)`, `VM.fromSession(...)`, or equivalent reopen primitive in our current adapter surface

That means:

```text
agent-vm alone cannot implement reattach today
```

So the implementation must be staged:

1. upstream/add reattach capability in `@earendil-works/gondolin`
2. expose that capability in `packages/gondolin-core`
3. persist runtime identity and use attach-or-create in `agent-vm`

If upstream attach support is rejected or infeasible, this plan must stop and be replaced with a different recovery design.

## File Structure And Responsibilities

### Existing Files To Modify

- Modify: [packages/agent-vm/src/config/system-config.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/config/system-config.ts)
  - add `host.projectNamespace` to schema/type loading
- Modify: [packages/agent-vm/src/cli/init-command.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/cli/init-command.ts)
  - generate default project namespace during scaffold
- Modify: [packages/gondolin-core/src/vm-adapter.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/gondolin-core/src/vm-adapter.ts)
  - add attach/reopen support to the managed VM adapter
- Modify: [packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts)
  - split attach-or-create startup flow
- Modify: [packages/openclaw-gateway/src/openclaw-lifecycle.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/openclaw-gateway/src/openclaw-lifecycle.ts)
  - update session labels to use project namespace
- Modify: [packages/agent-vm/src/controller/controller-runtime.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/controller-runtime.ts)
  - startup should attempt reattach before create
  - coordinated stop should delete runtime record
- Modify: [packages/agent-vm/src/controller/controller-runtime-types.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/controller-runtime-types.ts)
  - extend dependencies for attach path if needed
- Modify: [packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts)
  - namespace tool VM session labels too

### New Files To Create

- Create: [packages/agent-vm/src/runtime/project-namespace.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/runtime/project-namespace.ts)
  - default namespace generation and validation helpers
- Create: [packages/agent-vm/src/gateway/gateway-runtime-record.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-runtime-record.ts)
  - Zod schema + load/write/delete helpers for `gateway-runtime.json`

### Tests To Modify/Create

- Modify: [packages/agent-vm/src/config/system-config.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/config/system-config.test.ts)
- Modify: [packages/agent-vm/src/cli/init-command.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/cli/init-command.test.ts)
- Modify: [packages/gondolin-core/src/vm-adapter.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/gondolin-core/src/vm-adapter.test.ts)
- Modify: [packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts)
- Modify: [packages/agent-vm/src/controller/controller-runtime.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/controller-runtime.test.ts)
- Modify: [packages/agent-vm/src/integration-tests/live-controller-restart-persistence.integration.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/integration-tests/live-controller-restart-persistence.integration.test.ts)
- Create: [packages/agent-vm/src/gateway/gateway-runtime-record.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-runtime-record.test.ts)

## Architecture Decisions

### 1. Stable Project Namespace

Add a required `host.projectNamespace` to `system.json`.

Why:
- stable across controller restarts
- human-readable
- avoids collisions across projects sharing the same `zone.id`
- better than recomputing raw `pwd` every run

Default generation at init:

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function buildDefaultProjectNamespace(targetDir: string): string {
	const canonicalProjectPath = fs.realpathSync(targetDir);
	const projectSlug = path
		.basename(canonicalProjectPath)
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 32);
	const shortPathHash = crypto
		.createHash('sha256')
		.update(canonicalProjectPath)
		.digest('hex')
		.slice(0, 8);
	return `${projectSlug}-${shortPathHash}`;
}
```

Use it for:
- gateway session label
- tool VM session label
- runtime-record identity grouping

### 2. Persisted Gateway Runtime Record

Persist to:

```text
state/<zone>/gateway-runtime.json
```

Schema:

```ts
export const gatewayRuntimeRecordSchema = z.object({
	projectNamespace: z.string().min(1),
	zoneId: z.string().min(1),
	gatewayType: z.enum(['openclaw', 'worker']),
	vmId: z.string().min(1),
	sessionLabel: z.string().min(1),
	guestListenPort: z.number().int().positive(),
	ingressPort: z.number().int().positive(),
	createdAt: z.string().datetime(),
});
```

Write only after:
- gateway boot succeeds
- health check succeeds
- ingress is enabled

Delete when:
- `controller stop` shuts the gateway down intentionally
- attach fails because the VM is gone/stale

### 3. Gondolin Attach Primitive

This task is **not** pure adapter work. It requires a new upstream SDK capability first.

Required upstream shape in `@earendil-works/gondolin`:

```ts
export declare class VM {
	static create(options?: VMOptions): Promise<VM>;
	static attach(options: { vmId: string }): Promise<VM>;
}
```

Acceptable alternatives:

```ts
static fromId(vmId: string): Promise<VM>;
static fromSession(sessionLabel: string): Promise<VM>;
```

But one real reopen primitive must exist below our adapter.

After that lands, extend our adapter with:

```ts
export interface AttachVmOptions {
	readonly vmId: string;
}

export interface ManagedVmDependencies {
	// existing
	createVm(vmOptions: unknown): Promise<ManagedVmInstance>;
	// new
	attachVm?(vmOptions: AttachVmOptions): Promise<ManagedVmInstance>;
}

export async function attachManagedVm(
	options: AttachVmOptions,
	dependencies: ManagedVmDependencies = createDefaultDependencies(),
): Promise<ManagedVm> {
	if (!dependencies.attachVm) {
		throw new Error('attachVm is not implemented for this Gondolin adapter.');
	}

	const vmInstance = await dependencies.attachVm(options);
	return wrapManagedVmInstance(vmInstance);
}
```

`wrapManagedVmInstance()` should be extracted from the current `createManagedVm()` return block so create and attach share the same wrapper shape.

### 4. Hard Cutover Gateway Type Naming To `worker`

Before runtime-reattach work lands, rename the gateway type vocabulary consistently from `coding` to `worker`.

Why:
- aligns type names with the actual runtime package and lifecycle (`workerLifecycle`)
- removes conceptual drift between config, runtime, and package naming
- avoids persisting a new runtime record keyed to terminology we already know is wrong

Naming decision:
- keep the config/runtime discriminator as `worker`
- keep the package/runtime implementation names as `agent-vm-worker` / `workerLifecycle`
- do **not** use `agent-vm-worker` as the config enum value

Why this boundary is better:
- `zone.gateway.type` is a runtime role discriminator, not a package identifier
- `agent-vm-worker` leaks implementation detail into user config
- `openclaw` vs `agent-vm-worker` is asymmetrical and harder to reason about than `openclaw` vs `worker`
- package names can change without forcing config churn

Files that should be included in this cutover:
- [packages/agent-vm/src/config/system-config.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/config/system-config.ts)
- [packages/agent-vm/src/cli/init-command.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/cli/init-command.ts)
- [packages/agent-vm/src/gateway/gateway-lifecycle-loader.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-lifecycle-loader.ts)
- [packages/worker-gateway/src/worker-lifecycle.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/worker-gateway/src/worker-lifecycle.ts)
- any tests/fixtures/configs that currently say `coding`

This is a hard cutover:
- no compatibility alias for `coding`
- no dual enums
- all config, tests, and generated scaffolds move together

### 5. Attach-Or-Create Startup Flow

New startup decision:

```text
read runtime record
  -> if missing: create gateway
  -> if present: try attach
       -> health check
       -> ensure ingress
       -> reuse on success
       -> delete stale record + create fresh on failure
```

Important:
- health check must run on attached gateways too
- ingress must be re-established if the runtime handle does not already carry it

### 6. Stop Semantics

Intentional stop:
- close gateway VM
- delete runtime record

Crash:
- runtime record remains
- next startup attempts reattach

## Implementation Tasks

### Task 1: Hard Cutover Gateway Type Naming To `worker`

**Files:**
- Modify: [packages/agent-vm/src/config/system-config.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/config/system-config.ts)
- Modify: [packages/agent-vm/src/cli/init-command.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/cli/init-command.ts)
- Modify: [packages/agent-vm/src/gateway/gateway-lifecycle-loader.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-lifecycle-loader.ts)
- Modify: [packages/worker-gateway/src/worker-lifecycle.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/worker-gateway/src/worker-lifecycle.ts)
- Test: [packages/agent-vm/src/config/system-config.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/config/system-config.test.ts)
- Test: [packages/agent-vm/src/cli/init-command.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/cli/init-command.test.ts)
- Test: [packages/agent-vm/src/gateway/gateway-lifecycle-loader.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-lifecycle-loader.test.ts)

- [ ] **Step 1: Write the failing rename tests**

```ts
it('parses worker as the non-OpenClaw gateway type', async () => {
	const configPath = writeTempSystemConfig({
		zones: [
			{
				id: 'shravan',
				gateway: {
					type: 'worker',
					memory: '2G',
					cpus: 2,
					port: 18791,
					gatewayConfig: './config/shravan/worker.json',
					stateDir: './state/shravan',
					workspaceDir: './workspaces/shravan',
				},
				// ...
			},
		],
	});

	const loadedConfig = await loadSystemConfig(configPath);
	expect(loadedConfig.zones[0]?.gateway.type).toBe('worker');
});

it('loads the worker lifecycle for worker zones', () => {
	expect(loadGatewayLifecycle('worker')).toBe(workerLifecycle);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts \
  packages/agent-vm/src/gateway/gateway-lifecycle-loader.test.ts
```

Expected:
- FAIL because current type vocabulary still uses `coding`

- [ ] **Step 3: Hard-cut the type vocabulary**

```ts
// packages/agent-vm/src/config/system-config.ts
type: z.enum(['openclaw', 'worker']).default('openclaw'),
```

```ts
// packages/agent-vm/src/cli/init-command.ts
export type GatewayType = 'worker' | 'openclaw';

function resolveGatewayConfigFileName(gatewayType: GatewayType): 'worker.json' | 'openclaw.json' {
	return gatewayType === 'worker' ? 'worker.json' : 'openclaw.json';
}
```

```ts
// packages/agent-vm/src/gateway/gateway-lifecycle-loader.ts
const lifecycleByType = {
	worker: workerLifecycle,
	openclaw: openclawLifecycle,
} satisfies Record<string, GatewayLifecycle>;
```

Update all tests, fixtures, and generated config names in the same changeset.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts \
  packages/agent-vm/src/gateway/gateway-lifecycle-loader.test.ts
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
git add \
  packages/agent-vm/src/config/system-config.ts \
  packages/agent-vm/src/cli/init-command.ts \
  packages/agent-vm/src/gateway/gateway-lifecycle-loader.ts \
  packages/worker-gateway/src/worker-lifecycle.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts \
  packages/agent-vm/src/gateway/gateway-lifecycle-loader.test.ts
git commit -m "refactor: rename coding gateway type to worker"
```

### Task 2: Add Project Namespace To Config And Init Scaffold

**Files:**
- Create: [packages/agent-vm/src/runtime/project-namespace.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/runtime/project-namespace.ts)
- Modify: [packages/agent-vm/src/config/system-config.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/config/system-config.ts)
- Modify: [packages/agent-vm/src/cli/init-command.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/cli/init-command.ts)
- Test: [packages/agent-vm/src/config/system-config.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/config/system-config.test.ts)
- Test: [packages/agent-vm/src/cli/init-command.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/cli/init-command.test.ts)

- [ ] **Step 1: Write the failing config/init tests**

```ts
it('parses host.projectNamespace from system config', async () => {
	const configPath = writeTempSystemConfig({
		host: {
			controllerPort: 18800,
			projectNamespace: 'agent-vm-1234abcd',
			secretsProvider: {
				type: '1password',
				tokenSource: { type: 'env' },
			},
		},
		// ...
	});

	const loadedConfig = await loadSystemConfig(configPath);
	expect(loadedConfig.host.projectNamespace).toBe('agent-vm-1234abcd');
});

it('init writes a default host.projectNamespace', async () => {
	await scaffoldAgentVmProject({
		gatewayType: 'openclaw',
		targetDir,
		zoneId: 'shravan',
	});

	const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8'));
	expect(config.host.projectNamespace).toMatch(/^[a-z0-9-]+-[a-f0-9]{8}$/u);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts
```

Expected:
- FAIL because `projectNamespace` is not part of the schema or scaffold yet

- [ ] **Step 3: Add namespace helper and schema support**

```ts
// packages/agent-vm/src/runtime/project-namespace.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function buildDefaultProjectNamespace(targetDir: string): string {
	const canonicalProjectPath = fs.realpathSync(targetDir);
	const projectSlug = path
		.basename(canonicalProjectPath)
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 32);
	const shortPathHash = crypto
		.createHash('sha256')
		.update(canonicalProjectPath)
		.digest('hex')
		.slice(0, 8);
	return `${projectSlug}-${shortPathHash}`;
}
```

```ts
// packages/agent-vm/src/config/system-config.ts
const systemConfigSchema = z.object({
	host: z.object({
		controllerPort: z.number().int().positive(),
		projectNamespace: z.string().min(1),
		secretsProvider: z.object({
			type: z.literal('1password'),
			tokenSource: tokenSourceSchema,
		}),
	}),
	// ...
});
```

```ts
// packages/agent-vm/src/cli/init-command.ts
import { buildDefaultProjectNamespace } from '../runtime/project-namespace.js';

const defaultSystemConfig = (targetDir: string, zoneId: string, gatewayType: GatewayType): object => ({
	host: {
		controllerPort: 18800,
		projectNamespace: buildDefaultProjectNamespace(targetDir),
		secretsProvider: {
			type: '1password',
			tokenSource: getKeychainTokenSource(),
		},
	},
	// ...
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
git add \
  packages/agent-vm/src/runtime/project-namespace.ts \
  packages/agent-vm/src/config/system-config.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/cli/init-command.ts \
  packages/agent-vm/src/cli/init-command.test.ts
git commit -m "feat: add stable project namespace to system config"
```

### Task 3: Persist Gateway Runtime Metadata

**Files:**
- Create: [packages/agent-vm/src/gateway/gateway-runtime-record.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-runtime-record.ts)
- Test: [packages/agent-vm/src/gateway/gateway-runtime-record.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-runtime-record.test.ts)

- [ ] **Step 1: Write the failing runtime-record tests**

```ts
it('writes and reloads a gateway runtime record', async () => {
	const runtimeRecord = {
		projectNamespace: 'agent-vm-1234abcd',
		zoneId: 'shravan',
		gatewayType: 'openclaw',
		vmId: 'vm-123',
		sessionLabel: 'agent-vm-1234abcd:shravan:gateway',
		guestListenPort: 18789,
		ingressPort: 18791,
		createdAt: new Date('2026-04-13T12:00:00.000Z').toISOString(),
	};

	await writeGatewayRuntimeRecord(stateDir, runtimeRecord);
	await expect(loadGatewayRuntimeRecord(stateDir)).resolves.toEqual(runtimeRecord);
});

it('deletes a stale runtime record', async () => {
	await writeGatewayRuntimeRecord(stateDir, runtimeRecord);
	await deleteGatewayRuntimeRecord(stateDir);
	await expect(loadGatewayRuntimeRecord(stateDir)).resolves.toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway/gateway-runtime-record.test.ts
```

Expected:
- FAIL because the file does not exist yet

- [ ] **Step 3: Implement runtime-record schema and helpers**

```ts
// packages/agent-vm/src/gateway/gateway-runtime-record.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const gatewayRuntimeRecordSchema = z.object({
	projectNamespace: z.string().min(1),
	zoneId: z.string().min(1),
gatewayType: z.enum(['openclaw', 'worker']),
	vmId: z.string().min(1),
	sessionLabel: z.string().min(1),
	guestListenPort: z.number().int().positive(),
	ingressPort: z.number().int().positive(),
	createdAt: z.string().datetime(),
});

export type GatewayRuntimeRecord = z.infer<typeof gatewayRuntimeRecordSchema>;

export function resolveGatewayRuntimeRecordPath(stateDir: string): string {
	return path.join(stateDir, 'gateway-runtime.json');
}

export async function loadGatewayRuntimeRecord(stateDir: string): Promise<GatewayRuntimeRecord | null> {
	try {
		const raw = await fs.readFile(resolveGatewayRuntimeRecordPath(stateDir), 'utf8');
		return gatewayRuntimeRecordSchema.parse(JSON.parse(raw));
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

export async function writeGatewayRuntimeRecord(
	stateDir: string,
	record: GatewayRuntimeRecord,
): Promise<void> {
	await fs.mkdir(stateDir, { recursive: true });
	await fs.writeFile(
		resolveGatewayRuntimeRecordPath(stateDir),
		`${JSON.stringify(record, null, 2)}\n`,
		'utf8',
	);
}

export async function deleteGatewayRuntimeRecord(stateDir: string): Promise<void> {
	await fs.rm(resolveGatewayRuntimeRecordPath(stateDir), { force: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway/gateway-runtime-record.test.ts
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
git add \
  packages/agent-vm/src/gateway/gateway-runtime-record.ts \
  packages/agent-vm/src/gateway/gateway-runtime-record.test.ts
git commit -m "feat: persist gateway runtime records"
```

### Task 4: Add Upstream Gondolin Reattach Support And Expose It Locally

**Files:**
- Modify: upstream `@earendil-works/gondolin` SDK (outside this repo)
- Modify: [packages/gondolin-core/src/vm-adapter.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/gondolin-core/src/vm-adapter.ts)
- Test: [packages/gondolin-core/src/vm-adapter.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/gondolin-core/src/vm-adapter.test.ts)

- [ ] **Step 1: Confirm the upstream Gondolin SDK shape and add the failing upstream test**

Example upstream test sketch:

```ts
it('reattaches to an existing VM by vmId', async () => {
	const createdVm = await VM.create({ /* ... */ });
	const attachedVm = await VM.attach({ vmId: createdVm.id });

	expect(attachedVm.id).toBe(createdVm.id);
});
```

- [ ] **Step 2: Implement the upstream attach primitive in `@earendil-works/gondolin`**

The exact implementation depends on the SDK internals, but the acceptance criteria are:
- attach by `vmId` succeeds for a still-running VM
- attaching a missing VM throws a typed not-found error
- attached instances support the same operations we need:
  - `exec`
  - `enableSsh`
  - `enableIngress`
  - `setIngressRoutes`
  - `close`

- [ ] **Step 3: Update `packages/gondolin-core` to consume the new upstream primitive**

```ts
it('attaches to an existing VM by id', async () => {
	const vmInstance = createVmInstanceMock({ id: 'vm-123' });
	const attachVm = vi.fn(async ({ vmId }) => {
		expect(vmId).toBe('vm-123');
		return vmInstance;
	});

	const managedVm = await attachManagedVm(
		{ vmId: 'vm-123' },
		{
			...createDependencyMocks(),
			attachVm,
		},
	);

	expect(managedVm.id).toBe('vm-123');
});

it('throws when attachVm is not implemented', async () => {
	await expect(
		attachManagedVm({ vmId: 'vm-123' }, createDependencyMocks()),
	).rejects.toThrow('attachVm is not implemented');
});
```

- [ ] **Step 4: Run tests to verify they fail before adapter changes**

Run:

```bash
pnpm vitest run packages/gondolin-core/src/vm-adapter.test.ts
```

Expected:
- FAIL because `attachManagedVm()` does not exist yet

- [ ] **Step 5: Extract a shared wrapper and add attach API**

```ts
function wrapManagedVmInstance(vmInstance: ManagedVmInstance): ManagedVm {
	return {
		id: vmInstance.id,
		async exec(command: string): Promise<ExecResult> {
			const result = await vmInstance.exec(command);
			return {
				exitCode: result.exitCode,
				stdout: result.stdout ?? '',
				stderr: result.stderr ?? '',
			};
		},
		async enableSsh(options?: unknown): Promise<SshAccess> {
			return await vmInstance.enableSsh(options);
		},
		async enableIngress(options?: unknown): Promise<IngressAccess> {
			return await vmInstance.enableIngress(options);
		},
		getVmInstance(): ManagedVmInstance {
			return vmInstance;
		},
		setIngressRoutes(routes: readonly IngressRoute[]): void {
			vmInstance.setIngressRoutes(routes);
		},
		async close(): Promise<void> {
			await vmInstance.close();
		},
	};
}

export async function attachManagedVm(
	options: { readonly vmId: string },
	dependencies: ManagedVmDependencies = createDefaultDependencies(),
): Promise<ManagedVm> {
	return wrapManagedVmInstance(await dependencies.attachVm(options));
}
```

`createDefaultDependencies()` should wire `attachVm` to the new upstream SDK primitive. The adapter should no longer treat attach as optional once the upstream dependency is present.

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
pnpm vitest run packages/gondolin-core/src/vm-adapter.test.ts
```

Expected:
- PASS

- [ ] **Step 7: Commit**

```bash
git add \
  packages/gondolin-core/src/vm-adapter.ts \
  packages/gondolin-core/src/vm-adapter.test.ts
git commit -m "feat: add gateway VM attach support"
```

### Task 5: Namespace Gateway And Tool Session Labels

**Files:**
- Modify: [packages/openclaw-gateway/src/openclaw-lifecycle.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/openclaw-gateway/src/openclaw-lifecycle.ts)
- Modify: [packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts)
- Test: [packages/openclaw-gateway/src/openclaw-lifecycle.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/openclaw-gateway/src/openclaw-lifecycle.test.ts)
- Test: [packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts)

- [ ] **Step 1: Write the failing label tests**

```ts
it('builds a namespaced gateway session label', () => {
	const vmSpec = openclawLifecycle.buildVmSpec(zoneWithNamespace('agent-vm-1234abcd'), secrets, 18800, {
		basePort: 19000,
		size: 1,
	});

	expect(vmSpec.sessionLabel).toBe('agent-vm-1234abcd:shravan:gateway');
});

it('builds a namespaced tool session label', async () => {
	await createToolVm({
		cacheDir: '/tmp/cache',
		profile,
		systemConfig: systemConfigWithNamespace('agent-vm-1234abcd'),
		tcpSlot: 0,
		workspaceDir: '/workspace',
		zoneId: 'shravan',
	}, dependencies);

	expect(createManagedVmMock).toHaveBeenCalledWith(
		expect.objectContaining({
			sessionLabel: 'agent-vm-1234abcd:shravan:tool:0',
		}),
	);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run \
  packages/openclaw-gateway/src/openclaw-lifecycle.test.ts \
  packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
```

Expected:
- FAIL because current labels only use `zone.id`

- [ ] **Step 3: Implement namespaced labels**

```ts
// packages/openclaw-gateway/src/openclaw-lifecycle.ts
sessionLabel: `${zone.projectNamespace}:${zone.id}:gateway`,
```

```ts
// packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts
sessionLabel: `${options.systemConfig.host.projectNamespace}:${options.zoneId}:tool:${options.tcpSlot}`,
```

If `GatewayZoneConfig` does not already carry namespace, add a helper at the agent-vm layer that passes it into the lifecycle or derives the session label before `createManagedVm(...)`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm vitest run \
  packages/openclaw-gateway/src/openclaw-lifecycle.test.ts \
  packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
git add \
  packages/openclaw-gateway/src/openclaw-lifecycle.ts \
  packages/openclaw-gateway/src/openclaw-lifecycle.test.ts \
  packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts \
  packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
git commit -m "feat: namespace gateway and tool VM identities"
```

### Task 6: Teach Gateway Startup To Attach Or Create

**Files:**
- Modify: [packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts)
- Modify: [packages/agent-vm/src/gateway/gateway-zone-support.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-zone-support.ts)
- Modify: [packages/agent-vm/src/controller/controller-runtime-types.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/controller-runtime-types.ts)
- Test: [packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts)

- [ ] **Step 1: Write the failing orchestrator tests**

```ts
it('reattaches to a healthy existing gateway VM when runtime record is present', async () => {
	const attachManagedVm = vi.fn(async () => existingManagedVm);
	const createManagedVm = vi.fn();

	await startGatewayZone(
		{ runTask, secretResolver, systemConfig, zoneId: 'shravan' },
		{
			attachManagedVm,
			createManagedVm,
			loadGatewayRuntimeRecord: async () => ({
				projectNamespace: 'agent-vm-1234abcd',
				zoneId: 'shravan',
				gatewayType: 'openclaw',
				vmId: 'vm-123',
				sessionLabel: 'agent-vm-1234abcd:shravan:gateway',
				guestListenPort: 18789,
				ingressPort: 18791,
				createdAt: '2026-04-13T12:00:00.000Z',
			}),
		},
	);

	expect(attachManagedVm).toHaveBeenCalledWith({ vmId: 'vm-123' });
	expect(createManagedVm).not.toHaveBeenCalled();
});

it('deletes a stale runtime record and creates a fresh VM when attach fails', async () => {
	const attachManagedVm = vi.fn(async () => {
		throw new Error('vm not found');
	});
	const deleteGatewayRuntimeRecord = vi.fn(async () => {});
	const createManagedVm = vi.fn(async () => freshManagedVm);

	await startGatewayZone(/* ... */);

	expect(deleteGatewayRuntimeRecord).toHaveBeenCalled();
	expect(createManagedVm).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts
```

Expected:
- FAIL because there is no attach path yet

- [ ] **Step 3: Add load/attach/health/reuse flow**

```ts
async function attachExistingGatewayIfHealthy(/* ... */): Promise<GatewayZoneStartResult | null> {
	const runtimeRecord = await loadGatewayRuntimeRecord(zone.gateway.stateDir);
	if (!runtimeRecord) {
		return null;
	}

	try {
		const managedVm = await attachManagedVm({ vmId: runtimeRecord.vmId });
		await waitForHealth(managedVm, processSpec.healthCheck);
		managedVm.setIngressRoutes([{ port: processSpec.guestListenPort, prefix: '/', stripPrefix: true }]);
		const ingress = await managedVm.enableIngress({ listenPort: zone.gateway.port });
		return {
			image,
			ingress,
			processSpec,
			vm: managedVm,
			zone,
		};
	} catch {
		await deleteGatewayRuntimeRecord(zone.gateway.stateDir);
		return null;
	}
}
```

```ts
const attachedGateway = await attachExistingGatewayIfHealthy(/* ... */);
if (attachedGateway) {
	return attachedGateway;
}

// existing create flow remains below
```

Update dependency injection types so tests can mock:
- upstream Gondolin attach primitive
- `attachManagedVm`
- `loadGatewayRuntimeRecord`
- `writeGatewayRuntimeRecord`
- `deleteGatewayRuntimeRecord`

- [ ] **Step 4: Write runtime record after successful create**

```ts
await writeGatewayRuntimeRecord(zone.gateway.stateDir, {
	projectNamespace: options.systemConfig.host.projectNamespace,
	zoneId: zone.id,
	gatewayType: zone.gateway.type,
	vmId: managedVm.id,
	sessionLabel: vmSpec.sessionLabel ?? `${options.systemConfig.host.projectNamespace}:${zone.id}:gateway`,
	guestListenPort: processSpec.guestListenPort,
	ingressPort: zone.gateway.port,
	createdAt: new Date().toISOString(),
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts
```

Expected:
- PASS

- [ ] **Step 6: Commit**

```bash
git add \
  packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts \
  packages/agent-vm/src/gateway/gateway-zone-support.ts \
  packages/agent-vm/src/controller/controller-runtime-types.ts \
  packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts
git commit -m "feat: reattach healthy gateway VMs on controller restart"
```

### Task 7: Delete Runtime Record On Coordinated Shutdown

**Files:**
- Modify: [packages/agent-vm/src/controller/controller-runtime.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/controller-runtime.ts)
- Modify: [packages/agent-vm/src/controller/controller-runtime-operations.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/controller-runtime-operations.ts)
- Test: [packages/agent-vm/src/controller/controller-runtime.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/controller-runtime.test.ts)

- [ ] **Step 1: Write the failing shutdown tests**

```ts
it('deletes gateway runtime record on controller stop', async () => {
	const deleteGatewayRuntimeRecord = vi.fn(async () => {});
	const runtime = await startControllerRuntime(
		{ systemConfig, zoneId: 'shravan' },
		{
			deleteGatewayRuntimeRecord,
			startGatewayZone: async () => gatewayRuntime,
		},
	);

	await runtime.close();

	expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith('/abs/state/shravan');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/controller-runtime.test.ts
```

Expected:
- FAIL because stop does not touch a runtime record yet

- [ ] **Step 3: Implement coordinated cleanup**

```ts
const stopGatewayZone = async (): Promise<void> => {
	if (!gateway) {
		return;
	}
	try {
		await gateway.vm.close();
	} finally {
		await deleteGatewayRuntimeRecord(findConfiguredZone(options.systemConfig, options.zoneId).gateway.stateDir);
	}
};
```

Keep crash semantics intact by only deleting the record on intentional stop paths.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/controller-runtime.test.ts
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
git add \
  packages/agent-vm/src/controller/controller-runtime.ts \
  packages/agent-vm/src/controller/controller-runtime-operations.ts \
  packages/agent-vm/src/controller/controller-runtime.test.ts
git commit -m "feat: clean gateway runtime records on coordinated stop"
```

### Task 8: Prove Crash-Safe Reattach End To End

**Files:**
- Modify: [packages/agent-vm/src/integration-tests/live-controller-restart-persistence.integration.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/integration-tests/live-controller-restart-persistence.integration.test.ts)
- Modify: [packages/agent-vm/src/integration-tests/live-agent-model-roundtrip.integration.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/integration-tests/live-agent-model-roundtrip.integration.test.ts)

- [ ] **Step 1: Write a failing restart-reattach integration test**

```ts
it('reattaches to the same gateway VM after controller-only restart', async () => {
	const firstRuntime = await startRuntime();
	const firstGatewayVmId = firstRuntime.gateway.vm.id;

	await stopControllerHttpOnly(firstRuntime);

	const secondRuntime = await startRuntime();

	expect(secondRuntime.gateway.vm.id).toBe(firstGatewayVmId);
});
```

If the current fake VM seam cannot express attach/reuse, extend it so the second runtime receives the same underlying gateway VM instance by persisted vm id.

- [ ] **Step 2: Add a live smoke command that proves the reused gateway still works**

```ts
const commandResponse = await fetch(
	`http://127.0.0.1:${secondRuntime.controllerPort}/zones/shravan/execute-command`,
	{
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ command: 'openclaw security audit' }),
	},
);

expect(commandResponse.status).toBe(200);
```

- [ ] **Step 3: Run integration tests to verify they fail first**

Run:

```bash
pnpm vitest run --config vitest.integration.config.ts \
  packages/agent-vm/src/integration-tests/live-controller-restart-persistence.integration.test.ts \
  packages/agent-vm/src/integration-tests/live-agent-model-roundtrip.integration.test.ts
```

Expected:
- FAIL because the old gateway is not reattached yet

- [ ] **Step 4: Adjust tests to use the real attach-or-create path**

Make sure these tests:
- persist a runtime record
- restart only the controller layer
- assert same `vm.id` after restart
- still verify a real gateway command works after reattach

- [ ] **Step 5: Run integration tests to verify they pass**

Run:

```bash
pnpm vitest run --config vitest.integration.config.ts \
  packages/agent-vm/src/integration-tests/live-controller-restart-persistence.integration.test.ts \
  packages/agent-vm/src/integration-tests/live-agent-model-roundtrip.integration.test.ts
```

Expected:
- PASS

- [ ] **Step 6: Run full verification**

Run:

```bash
pnpm build
pnpm check
pnpm test
pnpm test:integration
```

Expected:
- all commands exit `0`

- [ ] **Step 7: Commit**

```bash
git add \
  packages/agent-vm/src/integration-tests/live-controller-restart-persistence.integration.test.ts \
  packages/agent-vm/src/integration-tests/live-agent-model-roundtrip.integration.test.ts
git commit -m "test: cover gateway reattach after controller restart"
```

## Self-Review

### Spec Coverage

Covered:
- why the bug exists
- why existing `state` is insufficient
- stable project namespace
- persisted gateway runtime identity
- Gondolin attach primitive
- controller attach-or-create startup
- coordinated stop semantics
- unit + integration verification

Not included by design:
- tool lease recovery after crash
- multi-zone controller recovery

### Placeholder Scan

Checked:
- no `TBD`
- no `TODO`
- no “write tests for above” without actual test code
- no “similar to Task N”

### Type Consistency

Consistent names used across tasks:
- `projectNamespace`
- `GatewayRuntimeRecord`
- `loadGatewayRuntimeRecord`
- `writeGatewayRuntimeRecord`
- `deleteGatewayRuntimeRecord`
- `attachManagedVm`

## Notes For The Implementer

- Do not weaken the current `controller stop` behavior. Clean shutdown should still terminate the gateway VM.
- The attach path must be health-checked before reuse.
- If attach fails, delete the stale runtime record immediately and fall back to create.
- Keep the first pass limited to gateway recovery only. Do not bundle lease recovery into the same change.
