# Gateway Runtime Recovery And Namespace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make controller restarts crash-safe for gateway VMs by persisting runtime identity, detecting and killing orphaned gateway VMs after controller crashes, introducing a stable per-project namespace so gateway identities do not collide across projects that reuse the same zone id, and hard-cutting gateway naming from `coding` to `worker`.

**Architecture:** Add a stable `host.projectNamespace` to `system.json`, persist a `gateway-runtime.json` record under each zone state directory, and change startup from "always create" to a bounded **detect-kill-create** recovery phase. The controller will continue to shut down the gateway on an intentional `controller stop`, but on crash-only restarts it will identify an orphaned gateway VM, kill it, delete stale runtime state, and then boot a fresh gateway against the already-persisted host state/workspace mounts.

**Tech Stack:** TypeScript, Zod, cmd-ts, Gondolin VM adapter, Vitest, pnpm

---

## Level 1 Override

This plan is now explicitly **Level 1 only**.

That means:

```text
recovery policy = detect-kill-create
```

Not:

```text
recovery policy = attach-or-create
```

### Why this override exists

We now have direct experiment evidence from this repo that after a hard controller kill:
- the `qemu-system-aarch64` child survives
- the controller and ingress ports disappear
- the Gondolin session socket remains on disk but returns `ECONNREFUSED`
- `findSession()` reports the session with `alive: false`
- `connectToSession()` cannot execute even a simple `exec`
- restarting the controller creates a second gateway VM while the orphaned QEMU is still alive

So the Level 1 gateway is an orphaned process, not a reusable live runtime.

### Level 1 startup rule

```text
controller start
  -> load runtime record
  -> if orphan exists:
       kill orphan
       delete stale runtime record
  -> create fresh gateway
  -> write new runtime record
```

### Responsiveness / startup behavior

This cleanup must **not** happen as a post-readiness background task.

Why kill during startup:
- it prevents duplicate VMs before a new gateway is created
- it avoids serving requests while ownership is ambiguous
- it keeps recovery decisions in one authoritative place

So the cleanup should be:
- part of startup
- bounded
- observable in startup task output/logging
- fail-fast if it cannot establish a safe baseline

### Task interpretation overrides

Interpret the tasks below with these overrides:

- **Task 4**
  - ignore any `attachManagedVm()` / upstream reattach work for Level 1
  - replace with `cleanupOrphanedGatewayIfPresent()` and supporting tests

- **Task 6**
  - replace attach-or-create with detect-kill-create
  - startup must run orphan cleanup before fresh gateway creation

- **Task 8**
  - test orphan cleanup and fresh VM creation after controller-only crash
  - do **not** test same-`vmId` reuse in Level 1

### Future Level 2 note

Level 2 remains a follow-up after upstream Gondolin improvements:
- reconnecting chardevs
- deterministic socket paths

The reusable Level 1 foundation is still:
- `host.projectNamespace`
- `gateway-runtime.json`
- namespaced session labels
- startup recovery decision point


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
- "which orphaned QEMU should be cleaned up after the controller dies?"

That gap exists in three places:

- [packages/agent-vm/src/controller/controller-runtime.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/controller-runtime.ts)
  - always starts a gateway on controller boot
- [packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts)
  - always calls `createManagedVm(...)`
- [packages/gondolin-core/src/vm-adapter.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/gondolin-core/src/vm-adapter.ts)
  - exposes create/exec/ssh/ingress/close only; no attach/reopen API exists

So the fix must be cross-layer:

- config/state model
- Gondolin session/process discovery
- controller startup flow

## Non-Goals

- Recovering active tool leases across controller crashes
- Recovering in-memory lease-manager bookkeeping
- Multi-zone concurrent controller recovery in the first pass
- Replacing `zone.id` as the user-facing zone selector

The first pass should recover **gateway runtime ownership only**. Existing tool leases may die and be recreated later.

## Why Level 1 Kills Instead Of Reattaching

The current orphaned gateway is not meaningfully reusable after a hard controller crash.

Experiment evidence from this repo:
- controller PID died
- child `qemu-system-aarch64` process stayed alive and was reparented to PID `1`
- controller health and ingress ports disappeared
- Gondolin session socket remained on disk but returned `ECONNREFUSED`
- `findSession()` returned the session with `alive: false`
- `connectToSession()` could not execute even a basic `exec`
- restarting the controller created a second gateway VM while the old QEMU was still alive

So Level 1 policy is:

```text
if orphan exists:
  kill orphan
  delete stale runtime record
create fresh gateway
```

This solves the real operational problems now:
- no duplicate VMs
- no orphaned QEMUs wasting resources
- persisted host state/workspace is still reused by the fresh gateway

True reattach is a future Level 2 after upstream Gondolin work such as reconnecting chardevs and deterministic socket paths.

## Startup Responsiveness

Orphan cleanup belongs in startup, but it should be a short, bounded startup phase.

Why kill during startup:
- it prevents duplicate VMs before a new gateway is created
- it keeps ownership decisions in one place
- it avoids serving requests while recovery state is ambiguous

Why not a background task after readiness:
- background cleanup can race with fresh gateway creation
- you can still end up with duplicate VMs
- request handling would start before recovery is settled

So the Level 1 rule is:

```text
startup cleanup phase:
  fast
  bounded
  observable in task output/logs
  fail clearly if cleanup cannot establish a safe baseline
```

## File Structure And Responsibilities

### Existing Files To Modify

- Modify: [packages/agent-vm/src/config/system-config.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/config/system-config.ts)
  - add `host.projectNamespace` to schema/type loading
- Modify: [packages/agent-vm/src/cli/init-command.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/cli/init-command.ts)
  - generate default project namespace during scaffold
- Modify: [packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts)
  - split detect-kill-create startup flow
- Modify: [packages/openclaw-gateway/src/openclaw-lifecycle.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/openclaw-gateway/src/openclaw-lifecycle.ts)
  - update session labels to use project namespace
- Modify: [packages/agent-vm/src/controller/controller-runtime.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/controller-runtime.ts)
  - startup should run bounded orphan cleanup before create
  - coordinated stop should delete runtime record
- Modify: [packages/agent-vm/src/controller/controller-runtime-types.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/controller-runtime-types.ts)
  - extend dependencies for orphan cleanup path if needed
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
	sessionId: z.string().min(1),
	qemuPid: z.number().int().positive().optional(),
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
- orphan cleanup succeeds
- the runtime record is invalid/stale and cannot be trusted

### 3. Orphan Cleanup Strategy

Level 1 recovery needs orphan discovery and termination, not VM reattachment.

Primary cleanup inputs:
- `gateway-runtime.json`
  - `sessionId`
  - `qemuPid`
  - `sessionLabel`
- Gondolin session-registry APIs
  - `findSession`
  - `listSessions`
  - `gcSessions`

Level 1 cleanup flow:

```text
load runtime record
  -> if no record: nothing to clean
  -> if record exists:
       try session lookup by sessionId
       if qemuPid alive: kill qemuPid
       if no qemuPid but session metadata is enough to find the orphan: kill it
       best-effort remove stale session metadata
       delete runtime record
```

Important:
- cleanup must be idempotent
- missing process / missing session metadata should not be fatal
- success means "no orphan remains", not "old VM was reachable"

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

### 5. Detect-Kill-Create Startup Flow

New startup decision:

```text
read runtime record
  -> if present: clean orphan
  -> create gateway
```

Important:
- cleanup runs before fresh create
- fresh create remains the only path to a usable gateway in Level 1
- normal gateway health check still runs on the newly created gateway

### 6. Stop Semantics

Intentional stop:
- close gateway VM
- delete runtime record

Crash:
- runtime record remains
- next startup runs orphan cleanup and creates a fresh gateway

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
	sessionId: z.string().min(1),
	qemuPid: z.number().int().positive(),
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

### Task 4: Add Level 1 Orphan Cleanup Support

**Files:**
- Create: [packages/agent-vm/src/gateway/gateway-recovery.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-recovery.ts)
- Test: [packages/agent-vm/src/gateway/gateway-recovery.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-recovery.test.ts)

- [ ] **Step 1: Write the failing orphan-cleanup tests**

```ts
it('kills an orphaned qemu process when runtime record points to a live pid', async () => {
	const killProcess = vi.fn();
	await cleanupOrphanedGatewayIfPresent(
		{
			stateDir: '/state/shravan',
		},
		{
			deleteRuntimeRecord: async () => {},
			findSession: async () => ({
				alive: false,
				id: 'session-123',
				pid: 999,
				socketPath: '/tmp/session.sock',
			}),
			isProcessAlive: () => true,
			killProcess,
			loadRuntimeRecord: async () => ({
				projectNamespace: 'agent-vm-1234abcd',
				zoneId: 'shravan',
				gatewayType: 'openclaw',
				vmId: 'vm-123',
				sessionId: 'session-123',
				qemuPid: 45678,
				sessionLabel: 'agent-vm-1234abcd:shravan:gateway',
				guestListenPort: 18789,
				ingressPort: 18791,
				createdAt: new Date().toISOString(),
			}),
		},
	);

	expect(killProcess).toHaveBeenCalledWith(45678);
});

it('verifies the pid still belongs to qemu before killing it', async () => {
	const killProcess = vi.fn();
	await cleanupOrphanedGatewayIfPresent(
		{
			stateDir: '/state/shravan',
		},
		{
			deleteRuntimeRecord: async () => {},
			findSession: async () => null,
			getProcessCommand: async () => 'python some-other-process.py',
			isProcessAlive: () => true,
			killProcess,
			loadRuntimeRecord: async () => ({
				projectNamespace: 'agent-vm-1234abcd',
				zoneId: 'shravan',
				gatewayType: 'openclaw',
				vmId: 'vm-123',
				sessionId: 'session-123',
				qemuPid: 45678,
				sessionLabel: 'agent-vm-1234abcd:shravan:gateway',
				guestListenPort: 18789,
				ingressPort: 18791,
				createdAt: new Date().toISOString(),
			}),
		},
	);

	expect(killProcess).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway/gateway-recovery.test.ts
```

Expected:
- FAIL because the cleanup helpers do not exist yet

- [ ] **Step 3: Implement `cleanupOrphanedGatewayIfPresent()`**

```ts
export async function cleanupOrphanedGatewayIfPresent(
	options: {
		readonly stateDir: string;
	},
	dependencies: {
		readonly deleteRuntimeRecord: (stateDir: string) => Promise<void>;
		readonly findSession: (sessionId: string) => Promise<{
			readonly alive: boolean;
			readonly id: string;
			readonly pid: number;
			readonly socketPath: string;
		} | null>;
		readonly getProcessCommand: (pid: number) => Promise<string | null>;
		readonly isProcessAlive: (pid: number) => boolean;
		readonly killProcess: (pid: number) => void;
		readonly loadRuntimeRecord: (stateDir: string) => Promise<GatewayRuntimeRecord | null>;
	},
): Promise<void> {
	const runtimeRecord = await dependencies.loadRuntimeRecord(options.stateDir);
	if (!runtimeRecord) {
		return;
	}

	try {
		if (dependencies.isProcessAlive(runtimeRecord.qemuPid)) {
			const command = await dependencies.getProcessCommand(runtimeRecord.qemuPid);
			if (command?.includes('qemu-system')) {
				dependencies.killProcess(runtimeRecord.qemuPid);
			}
		}
		await dependencies.findSession(runtimeRecord.sessionId).catch(() => null);
	} finally {
		await dependencies.deleteRuntimeRecord(options.stateDir);
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway/gateway-recovery.test.ts
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
git add \
  packages/agent-vm/src/gateway/gateway-recovery.ts \
  packages/agent-vm/src/gateway/gateway-recovery.test.ts
git commit -m "feat: add orphaned gateway cleanup"
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

### Task 6: Teach Gateway Startup To Detect-Kill-Create

**Files:**
- Modify: [packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts)
- Modify: [packages/agent-vm/src/gateway/gateway-zone-support.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-zone-support.ts)
- Modify: [packages/agent-vm/src/controller/controller-runtime-types.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/controller-runtime-types.ts)
- Test: [packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts)

- [ ] **Step 1: Write the failing orchestrator tests**

```ts
it('runs orphan cleanup before creating a fresh gateway VM', async () => {
	const cleanupOrphanedGatewayIfPresent = vi.fn(async () => {});
	const createManagedVm = vi.fn(async () => freshManagedVm);

	await startGatewayZone(
		{ runTask, secretResolver, systemConfig, zoneId: 'shravan' },
		{
			cleanupOrphanedGatewayIfPresent,
			createManagedVm,
		},
	);

	expect(cleanupOrphanedGatewayIfPresent).toHaveBeenCalled();
	expect(createManagedVm).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts
```

Expected:
- FAIL because there is no orphan cleanup path yet

- [ ] **Step 3: Add cleanup-before-create flow**

```ts
await cleanupOrphanedGatewayIfPresent({
	stateDir: zone.gateway.stateDir,
}, recoveryDependencies);
```

This should happen before the new `createManagedVm(...)` path.

Update dependency injection types so tests can mock:
- `cleanupOrphanedGatewayIfPresent`
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
		sessionId: managedVm.id,
		qemuPid: managedVm.getVmInstance().pid,
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
git commit -m "feat: clean orphaned gateways before restart"
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

### Task 8: Prove Crash-Safe Orphan Cleanup End To End

**Files:**
- Modify: [packages/agent-vm/src/integration-tests/live-controller-restart-persistence.integration.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/integration-tests/live-controller-restart-persistence.integration.test.ts)
- Modify: [packages/agent-vm/src/integration-tests/live-agent-model-roundtrip.integration.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/integration-tests/live-agent-model-roundtrip.integration.test.ts)

- [ ] **Step 1: Write a failing restart-recovery integration test**

```ts
it('kills an orphaned gateway and starts a fresh one after controller-only restart', async () => {
	const firstRuntime = await startRuntime();
	const firstGatewayVmId = firstRuntime.gateway.vm.id;

	await killControllerOnly(firstRuntime);

	const secondRuntime = await startRuntime();

	expect(secondRuntime.gateway.vm.id).not.toBe(firstGatewayVmId);
});
```

If the current fake VM seam cannot express orphan cleanup, extend it so the first runtime leaves behind an orphan marker / qemu pid that the second startup must clean before creating a fresh gateway.

- [ ] **Step 2: Add a live smoke command that proves the restarted gateway still works**

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
- FAIL because orphan cleanup is not implemented yet

- [ ] **Step 4: Adjust tests to use the real detect-kill-create path**

Make sure these tests:
- persist a runtime record
- restart only the controller layer
- assert the old orphan is cleaned up
- assert a fresh gateway `vm.id` is created
- still verify a real gateway command works after restart

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
git commit -m "test: cover gateway orphan cleanup after controller restart"
```

## Self-Review

### Spec Coverage

Covered:
- why the bug exists
- why existing `state` is insufficient
- stable project namespace
- persisted gateway runtime identity
- orphan cleanup strategy
- controller detect-kill-create startup
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
- `cleanupOrphanedGatewayIfPresent`

## Notes For The Implementer

- Do not weaken the current `controller stop` behavior. Clean shutdown should still terminate the gateway VM.
- Orphan cleanup must verify that a stored `qemuPid` still belongs to `qemu-system` before killing it.
- Keep cleanup bounded and in startup, not in request-serving background work.
- Keep the first pass limited to gateway recovery only. Do not bundle lease recovery into the same change.
