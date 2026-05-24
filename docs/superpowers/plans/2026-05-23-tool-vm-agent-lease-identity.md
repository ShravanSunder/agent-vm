# Tool VM Agent Lease Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make managed OpenClaw Tool VM identity `zoneId + agentId`, keep OpenClaw `scopeKey` as channel/session provenance, and harden recovery so startup never kills a running controller's gateway or Tool VMs.

**Architecture:** The controller port is the startup election: bind `host.controllerPort` before recovery, report `recovering` until gateways are healthy, and exit before cleanup if the port is already owned. Live leases are reused by `zoneId + agentId`, while arbitrary OpenClaw `scopeKey` values remain request/correlation/TTL provenance under that agent. Tool VM runtime records stay as small JSON files under `stateDir/tool-leases/<recordId>.json`; they contain only the ids and process/fence metadata needed to prove ownership and clean up (`recordId`, `agentId`, `leaseId`, `vmId`, `qemuPid`, `tcpSlot`, process identity, deployment fences, gateway identity, timestamps), but never `scopeKey`. Startup recovery cleans proven Tool VM children for a gateway in parallel first, then cleans the gateway process, so performance stays bounded by the slowest child cleanup plus the gateway cleanup.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm, Hono controller routes, OpenClaw Gondolin plugin, JSON runtime records.

---

## Current Evidence

- `packages/agent-vm/src/controller/leases/lease-manager.ts` currently keys live leases by `zoneId + scopeKey` and builds `lease.id` as `${zoneId}-${scopeKey}-${createdAt}`.
- `packages/agent-vm/src/controller/http/controller-http-routes.ts` receives `agentId`, `sessionKey`, and `scopeKey`, but the lease manager call still passes only `scopeKey`.
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts` derives `agentId` from `sessionKey` and caches handles by scope-shaped inputs.
- This branch already has an initial Tool VM recovery prototype:
  - `packages/agent-vm/src/controller/leases/tool-vm-runtime-record.ts`
  - `packages/agent-vm/src/controller/leases/tool-vm-recovery.ts`
  - `packages/agent-vm/src/shared/managed-vm-process.ts`
  - `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- The current prototype writes records under `$stateDir/tool-leases/<leaseId>.json`, includes `scopeKey` in the durable record, and quarantines mismatches. This plan hard-cuts runtime record schemas because this branch is still development work: no deployed runtime records need migration or compatibility support.

## Correct Mental Model

```text
agentId
  The managed Tool VM owner. One compatible Tool VM per zone + agent.

scopeKey
  OpenClaw scope/correlation/TTL provenance. It may encode channel,
  session, thread, or subagent context. It must not become Tool VM identity.

compatibility
  The lease identity axis is zoneId + agentId. Reuse is allowed only when
  the returning request is compatible with the existing agent lease:
  profileId, agentWorkspaceDir, hostWorkMountDir, guestWorkdir, and zone-git
  mount identity must match. Incompatible requests for the same zoneId +
  agentId are rejected; they do not silently reuse the wrong Tool VM.

lease.id
  Public API handle for renew/release/active-use routes.
  New shape: ${zoneId}-${agentId}-${createdAt}; no scope string.

recordId
  Controller-generated UUID for durable record filename.

runtime record JSON
  Crash-recovery breadcrumb, not truth. Cleanup must re-prove ownership
  from fences and host-side process evidence before signaling. Port checks
  are election/corroboration, not identity.

recovery order
  After the controller port is bound, load the current gateway record and
  Tool VM records for that zone. Clean valid child Tool VM records for the
  gateway in parallel, then clean the gateway record. Each record is deleted
  only after that record's process is proven gone or killed.
```

## Non-Goals

- Do not add SQLite, Drizzle, or a database. Runtime records are tiny per-VM JSON receipts with no query workload.
- Do not add file locks. The controller port bind is the startup lock/election.
- Do not require `scopeKey === agent:<agentId>`. OpenClaw scopes can vary inside the same agent.
- Do not remove `scopeKey` from HTTP request/response payloads. It remains useful provenance and TTL policy input.
- Do not make recovery call SSH, gateway health, or VM-internal commands. Startup recovery must use host-side checks only.
- Do not treat a port holder as the identity source. The controller port is the startup election; Tool VM and gateway ports are corroborating evidence used with record fences, pid, and process command/identity.
- Do not preserve pre-cutover runtime record schemas, backfills, migrations, or compatibility shims. This is new development work; change the record contracts everywhere in one pass.

## File Structure

- Modify `packages/agent-vm/src/controller/controller-runtime.ts`
  - Bind the HTTP controller before zone startup recovery.
  - Expose a recovering/not-ready state until gateway startup completes.
  - Return 503 for `/health` and `/lease` during recovery, but keep `/stop-controller` callable.

- Modify `packages/agent-vm/src/controller/http/controller-http-routes.ts`
  - Accept `agentId`, `scopeKey`, and `sessionKey`.
  - Resolve effective agent ownership from `sessionKey`; agent-shaped sessions use their embedded agent id, and non-agent-shaped OpenClaw sessions use OpenClaw's `main` fallback instead of trusting the payload agent id.
  - Stop rejecting channel/session-shaped `scopeKey` values.
  - Pass `agentId` and `requestScopeKey` into `LeaseManager.createLease`.
  - Return 503 during recovery for mutating routes that need a ready runtime: `POST /lease`, lease renew/release/active-use routes, zone-git push, credential refresh, zone destroy/upgrade, worker-task create/close/push/pull, zone SSH enable, and zone command execution. Keep `POST /stop-controller` callable.

- Modify `packages/agent-vm/src/controller/leases/lease-manager.ts`
  - Add `Lease.agentId`.
  - Add `Lease.runtimeRecordId`.
  - Validate `agentId` at the lease-manager boundary with the same path-safe OpenClaw agent id shape: `/^[a-z0-9][a-z0-9_-]{0,63}$/iu`.
  - Key live reuse by `zoneId + agentId`.
  - Before reusing an existing agent lease, verify the requested profile/workspace/workdir/zone-git compatibility fields match the live lease; reject mismatches with a typed conflict error.
  - Keep `Lease.scopeKey` as creation/request provenance used for TTL and response display.
  - Generate `lease.id` without raw `scopeKey`.

- Modify `packages/agent-vm/src/controller/leases/tool-vm-runtime-record.ts`
  - Hard-cut schema to UUID filenames.
  - Keep `agentId`, `leaseId`, `vmId`, `qemuPid`, `tcpSlot`, fences, and session labels.
  - Keep the record minimal: do not persist `profileId`, workspace paths, `scopeKey`, or request payloads because they are not needed to prove process ownership or clean up.
  - Reject `scopeKey` with a strict Zod schema.
  - Delete quarantine/path-safety helpers tied to lease-id filenames.

- Modify `packages/agent-vm/src/controller/leases/tool-vm-recovery.ts`
  - Warn+skip on unproven ownership.
  - Delete only records proven stale or records whose owned process was killed.
  - Use host-side PID/process identity and port evidence. Keep stored process identity and fix the parser bug in this changeset; port ownership is not identity by itself.

- Keep `packages/agent-vm/src/controller/leases/tcp-pool.ts`
  - Preserve in-memory slot quarantine for normal runtime close failures.
  - Treat quarantine as runtime backpressure only; it is not a durable record mechanism and not a startup recovery/migration path.

- Modify `packages/agent-vm/src/shared/managed-vm-process.ts`
  - Fix `findLstartCommandBoundary` so `ps -o lstart= -o command=` parses the five-token lstart value (`Day Mon DD HH:MM:SS YYYY`) correctly.
  - Keep this as the stored process identity check before signaling.

- Create `packages/agent-vm/src/shared/port-owner.ts`
  - Small host-side helper for checking whether a TCP listen port is free, held by the recorded pid, or held by someone else.
  - Use `lsof` on macOS/Linux. Tests inject this helper, so unit tests do not shell out.
  - Surface a clear controller startup error if recovery needs port-owner checks and `lsof` is unavailable.

- Modify `packages/agent-vm/src/gateway/gateway-recovery.ts`
  - Apply the same host-side port-owner guard to gateway recovery using `zone.gateway.port`.
  - Hard-cut the gateway runtime record schema to the new contract. Delete pre-cutover defaults, backfills, schema migrations, and quarantine paths.
  - Use warn+skip for in-process recovery mismatches and preserve strict throwing for offline cleanup.

- Modify `packages/agent-vm/src/operations/controller-offline-cleanup.ts`
  - Keep `agent-vm controller cleanup --config ... --zone ...` as the operator-initiated strict cleanup path.
  - Run Tool VM cleanup in `offline-cleanup` mode before gateway cleanup, matching startup ordering but throwing on unproven ownership instead of warn+skip.
  - Return both Tool VM cleanup details and gateway cleanup details so operator output and warnings do not discard child-cleanup evidence.

- Modify `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
  - Cache handles by agent identity plus workspace/profile, not raw scope key.
  - Preserve `scopeKey` in lease requests.

- Modify docs/manuals:
  - `docs/architecture/openclaw-gateway.md`
  - `docs/architecture/storage-model.md`
  - `docs/architecture/storage-matrix.md`
  - `docs/reference/configuration/system-json.md`
  - `packages/agent-vm/src/cli/manual-templates.ts`
  - `packages/agent-vm/src/cli/manual-templates.test.ts`

---

### Task 1: Bind Controller Port Before Recovery

**Files:**
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Test: `packages/agent-vm/src/controller/controller-runtime.test.ts`
- Test: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`

- [ ] **Step 1: Write failing test for early HTTP bind**

Add a test in `controller-runtime.test.ts` that proves the HTTP server is started before `startGatewayZone` performs cleanup/boot work:

```ts
it('binds the controller port before starting gateway zones', async () => {
	const events: string[] = [];
	const startHttpServer = vi.fn(async () => {
		events.push('http');
		return { close: vi.fn(async () => {}) };
	});
	const startGatewayZone = vi.fn(async () => {
		events.push('zone');
		return createGatewayZoneStartResult();
	});

	await startControllerRuntime(createRuntimeOptions(), {
		startHttpServer,
		startGatewayZone,
	});

	expect(events).toEqual(['http', 'zone']);
});
```

- [ ] **Step 2: Write failing tests for recovering state**

Add route-level assertions that recovery mode rejects mutating runtime operations but allows stop:

```ts
it('returns recovering health while runtime startup is not ready', async () => {
	const app = createControllerHttpApp(
		createControllerRouteOptions({
			runtimeReadiness: () => ({ ready: false, state: 'recovering' }),
		}),
	);

	const response = await app.request('/health');

	expect(response.status).toBe(503);
	await expect(response.json()).resolves.toMatchObject({
		ok: false,
		state: 'recovering',
	});
});

it('returns not-ready for lease creation while runtime is recovering', async () => {
	const app = createControllerHttpApp(
		createControllerRouteOptions({
			runtimeReadiness: () => ({ ready: false, state: 'recovering' }),
		}),
	);

	const response = await app.request('/lease', {
		method: 'POST',
		body: JSON.stringify(validLeaseCreateRequest()),
		headers: { 'content-type': 'application/json' },
	});

	expect(response.status).toBe(503);
	await expect(response.json()).resolves.toMatchObject({
		error: 'controller-not-ready',
		state: 'recovering',
	});
});
```

Add the same 503 expectation for:

```ts
it.each([
	['POST', '/lease/lease-123/renew'],
	['DELETE', '/lease/lease-123'],
	['POST', '/lease/lease-123/uses'],
	['POST', '/lease/lease-123/uses/01890f00-0000-7000-8000-000000000000/heartbeat'],
	['DELETE', '/lease/lease-123/uses/use_01890f00000070008000000000000000'],
	['POST', '/zones/shravan/worker-tasks'],
] as const)('returns not-ready for %s %s while runtime is recovering', async (method, path) => {
	const app = createControllerHttpApp(
		createControllerRouteOptions({
			runtimeReadiness: () => ({ ready: false, state: 'recovering' }),
		}),
	);

	const response = await app.request(path, {
		method,
		body: method === 'DELETE' ? undefined : JSON.stringify({}),
		headers: { 'content-type': 'application/json' },
	});

	expect(response.status).toBe(503);
});
```

- [ ] **Step 3: Run focused tests to verify failure**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/controller-runtime.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: FAIL because the controller currently starts HTTP after zone startup.

- [ ] **Step 4: Implement early HTTP bind**

In `controller-runtime.ts`, introduce a runtime readiness object:

```ts
type ControllerRuntimeState = 'recovering' | 'ready' | 'stopping';

const runtimeReadiness = createMutableControllerRuntimeReadiness('recovering');
```

Start HTTP before zone startup:

```ts
await runTaskStep(`Controller API on :${options.systemConfig.host.controllerPort}`, async () => {
	serverRef.current = await (dependencies.startHttpServer ?? startControllerHttpServer)({
		app: createControllerHttpApp({
			...routeOptions,
			runtimeReadiness: runtimeReadiness.get,
		}),
		port: options.systemConfig.host.controllerPort,
	});
});

try {
	await startGatewayZones();
	runtimeReadiness.set('ready');
} catch (error) {
	runtimeReadiness.set('stopping');
	await serverRef.current?.close();
	throw error;
}
```

Do not add a file lock. If `startHttpServer` throws `EADDRINUSE`, let startup fail before cleanup begins.

- [ ] **Step 5: Gate lease routes during recovery**

In `controller-http-routes.ts`, add a route option and a helper used by every mutating lease route:

```ts
readonly runtimeReadiness?: () => {
	readonly ready: boolean;
	readonly state: 'recovering' | 'ready' | 'stopping';
};

function controllerNotReadyResponse(
	context: Context,
	operation: string,
	readiness: { readonly ready: boolean; readonly state: 'recovering' | 'ready' | 'stopping' },
): Response | null {
	if (readiness.ready) {
		return null;
	}
	return context.json(
		{
			error: 'controller-not-ready',
			message: `Controller is ${readiness.state}; ${operation} is disabled until gateway recovery and boot finish.`,
			state: readiness.state,
		},
		503,
	);
}
```

```ts
const readiness = options.runtimeReadiness?.();
if (readiness) {
	const notReady = controllerNotReadyResponse(context, 'lease creation', readiness);
	if (notReady) {
		return notReady;
	}
}
```

Apply the same helper to:

- `POST /lease`
- `POST /lease/:leaseId/renew`
- `DELETE /lease/:leaseId`
- `POST /lease/:leaseId/uses`
- `POST /lease/:leaseId/uses/:useId/heartbeat`
- `DELETE /lease/:leaseId/uses/:useId`
- `POST /zones/:zoneId/worker-tasks`

Keep read-only `GET /lease/:leaseId`, `GET /lease/:leaseId/peek`, and `GET /leases` available for diagnostics during recovery.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/controller-runtime.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime.test.ts packages/agent-vm/src/controller/http/controller-http-routes.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
git commit -m "fix: bind controller before recovery"
```

---

### Task 2: Lease Manager Reuses Tool VMs By Agent

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.ts`
- Test: `packages/agent-vm/src/controller/leases/lease-manager.test.ts`

- [ ] **Step 1: Write failing reuse tests**

Add tests in `lease-manager.test.ts`:

```ts
it('reuses the same live Tool VM for different scope keys under one agent', async () => {
	const manager = createLeaseManager(createLeaseManagerOptions());

	const firstLease = await manager.createLease(
		createLeaseOptions({
			agentId: 'beta',
			scopeKey: 'agent:beta:discord:channel:123',
		}),
	);
	const secondLease = await manager.createLease(
		createLeaseOptions({
			agentId: 'beta',
			scopeKey: 'agent:beta:discord:channel:999',
		}),
	);

	expect(secondLease.id).toBe(firstLease.id);
	expect(secondLease.agentId).toBe('beta');
	expect(secondLease.scopeKey).toBe('agent:beta:discord:channel:123');
});

it('creates separate Tool VMs for separate agents in the same zone', async () => {
	const manager = createLeaseManager(createLeaseManagerOptions());

	const betaLease = await manager.createLease(createLeaseOptions({ agentId: 'beta' }));
	const lauraLease = await manager.createLease(createLeaseOptions({ agentId: 'laura' }));

	expect(lauraLease.id).not.toBe(betaLease.id);
	expect(manager.listLeases()).toHaveLength(2);
});

it('does not put raw scopeKey into lease id', async () => {
	const manager = createLeaseManager(createLeaseManagerOptions());

	const lease = await manager.createLease(
		createLeaseOptions({
			agentId: 'beta',
			scopeKey: 'agent:beta:discord:channel:123',
		}),
	);

	expect(lease.id).toMatch(/^shravan-beta-\d+$/u);
	expect(lease.id).not.toContain('agent:');
	expect(lease.id).not.toContain('discord');
});

it('rejects an incompatible workspace request for an existing agent lease', async () => {
	const manager = createLeaseManager(createLeaseManagerOptions());

	await manager.createLease(
		createLeaseOptions({
			agentId: 'beta',
			hostWorkMountDir: '/tmp/beta-workspace-a',
		}),
	);

	await expect(
		manager.createLease(
			createLeaseOptions({
				agentId: 'beta',
				hostWorkMountDir: '/tmp/beta-workspace-b',
			}),
		),
	).rejects.toThrow(/existing Tool VM lease for agent 'beta' is not compatible/u);
});

it('rejects an incompatible profile request for an existing agent lease', async () => {
	const manager = createLeaseManager(createLeaseManagerOptions());

	await manager.createLease(
		createLeaseOptions({
			agentId: 'beta',
			profileId: 'standard',
		}),
	);

	await expect(
		manager.createLease(
			createLeaseOptions({
				agentId: 'beta',
				profileId: 'large',
			}),
		),
	).rejects.toThrow(/existing Tool VM lease for agent 'beta' is not compatible/u);
});
```

- [ ] **Step 2: Run lease-manager tests to verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-manager.test.ts
```

Expected: FAIL because reuse is still scope-keyed and `createLease` does not accept `agentId`.

- [ ] **Step 3: Implement agent-keyed lease state**

Add a local validator near the lease manager helpers:

```ts
const leaseAgentIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;

function assertValidLeaseAgentId(agentId: string): void {
	if (!leaseAgentIdPattern.test(agentId)) {
		throw new Error(
			`Invalid Tool VM lease agentId '${agentId}': expected an OpenClaw agent id matching /^[a-z0-9][a-z0-9_-]{0,63}$/i.`,
		);
	}
}
```

Call it at `createLease` entry before constructing `lease.id`.

Update `Lease`:

```ts
export interface Lease {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly createdAt: number;
	readonly effectiveIdleTtlMs: number;
	readonly guestWorkdir: string;
	readonly id: string;
	readonly lastUsedAt: number;
	readonly profileId: string;
	readonly runtimeRecordId: string;
	readonly scopeKey: string;
	readonly sshAccess: {
		readonly command?: string;
		readonly host: string;
		readonly identityFile?: string;
		readonly port: number;
		readonly user?: string;
	};
	readonly tcpSlot: number;
	readonly vm: ManagedVm;
	readonly hostWorkMountDir: string;
	readonly zoneGitMount?: ZoneGitToolVmMount;
	readonly zoneId: string;
}
```

Update create options:

```ts
createLease(options: {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly effectiveIdleTtlMs?: number;
	readonly profile: ToolVmProfile;
	readonly profileId: string;
	readonly scopeKey: string;
	readonly guestWorkdir: string;
	readonly hostWorkMountDir: string;
	readonly zoneGitMount?: ZoneGitToolVmMount;
	readonly zoneId: string;
}): Promise<Lease>;
```

Replace the scope index:

```ts
function agentLeaseIndexKey(agentLease: {
	readonly agentId: string;
	readonly zoneId: string;
}): string {
	return `${agentLease.zoneId}\0${agentLease.agentId}`;
}
```

Rename the map:

```ts
const leaseIdsByAgent = new Map<string, string>();
```

Generate the lease id:

```ts
const leaseId = `${leaseOptions.zoneId}-${leaseOptions.agentId}-${createdAt}`;
```

- [ ] **Step 4: Reject incompatible reuse before returning an existing lease**

Add a compatibility assertion:

```ts
function zoneGitMountsEqual(
	left: ZoneGitToolVmMount | undefined,
	right: ZoneGitToolVmMount | undefined,
): boolean {
	if (left === undefined || right === undefined) {
		return left === right;
	}
	return (
		left.hostZoneFilesDir === right.hostZoneFilesDir &&
		left.hostZoneGitRoot === right.hostZoneGitRoot
	);
}

function assertCompatibleAgentLeaseRequest(options: {
	readonly existingLease: Lease;
	readonly requestedLease: {
		readonly agentWorkspaceDir: string;
		readonly guestWorkdir: string;
		readonly hostWorkMountDir: string;
		readonly profileId: string;
		readonly zoneGitMount?: ZoneGitToolVmMount;
	};
}): void {
	const mismatches = [
		options.existingLease.profileId === options.requestedLease.profileId
			? undefined
			: 'profileId',
		options.existingLease.agentWorkspaceDir === options.requestedLease.agentWorkspaceDir
			? undefined
			: 'agentWorkspaceDir',
		options.existingLease.guestWorkdir === options.requestedLease.guestWorkdir
			? undefined
			: 'guestWorkdir',
		options.existingLease.hostWorkMountDir === options.requestedLease.hostWorkMountDir
			? undefined
			: 'hostWorkMountDir',
		zoneGitMountsEqual(options.existingLease.zoneGitMount, options.requestedLease.zoneGitMount)
			? undefined
			: 'zoneGitMount',
	].filter((field): field is string => field !== undefined);
	if (mismatches.length > 0) {
		throw new AgentLeaseCompatibilityConflictError(
			`existing Tool VM lease for agent '${options.existingLease.agentId}' is not compatible with this request; mismatched fields: ${mismatches.join(', ')}`,
		);
	}
}
```

Use it when `leaseIdsByAgent` finds an existing lease. Add `AgentLeaseCompatibilityConflictError` as the typed controller error for this path; do not reuse the old scope-conflict name because scope is not the identity axis anymore. The HTTP route should map this error to `409` with structured `error`, `message`, `guidance`, and `received` fields.

- [ ] **Step 5: Preserve scopeKey as provenance, not identity**

Keep `scopeKey` on the `Lease` response, and keep `ttlForLease` scope-based. Do not use `scopeKey` for the reuse map or lock key.

When an existing agent lease is reused, return the existing lease unchanged. Do not mutate its `scopeKey` on every request; the field remains creation/request provenance for the public lease object.

- [ ] **Step 6: Run lease-manager tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-manager.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/src/controller/leases/lease-manager.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts
git commit -m "refactor: key tool vm leases by agent"
```

---

### Task 3: Lease Routes Accept Scope Provenance Without Scope Equality

**Files:**
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-lease-response-types.ts`
- Test: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
- Test: `packages/agent-vm/src/controller/http/controller-client.test.ts`

- [ ] **Step 1: Write route tests for arbitrary scopeKey under same agent**

Add to `controller-http-routes.test.ts`:

```ts
it('passes agentId and preserves channel-shaped scopeKey as provenance', async () => {
	const createLease = vi.fn(async (options) =>
		createLeaseStub('shravan-beta-100', 0, {
			agentId: options.agentId,
			scopeKey: options.scopeKey,
		}),
	);
	const app = createControllerHttpApp(createControllerRouteOptions({ createLease }));

	const response = await app.request('/lease', {
		method: 'POST',
		body: JSON.stringify({
			...validLeaseCreateRequest(),
			agentId: 'beta',
			scopeKey: 'agent:beta:discord:channel:123',
			sessionKey: 'agent:beta:discord:channel:123',
		}),
		headers: { 'content-type': 'application/json' },
	});

	expect(response.status).toBe(200);
	expect(createLease).toHaveBeenCalledWith(
		expect.objectContaining({
			agentId: 'beta',
			scopeKey: 'agent:beta:discord:channel:123',
		}),
	);
	await expect(response.json()).resolves.toMatchObject({
		agentId: 'beta',
		leaseId: 'shravan-beta-100',
		scopeKey: 'agent:beta:discord:channel:123',
	});
});
```

Add a mismatch test:

```ts
it('rejects agent-shaped session keys that belong to another agent', async () => {
	const app = createControllerHttpApp(createControllerRouteOptions());

	const response = await app.request('/lease', {
		method: 'POST',
		body: JSON.stringify({
			...validLeaseCreateRequest(),
			agentId: 'beta',
			scopeKey: 'agent:beta:discord:channel:123',
			sessionKey: 'agent:laura:discord:channel:123',
		}),
		headers: { 'content-type': 'application/json' },
	});

	expect(response.status).toBe(400);
	await expect(response.json()).resolves.toMatchObject({
		error: 'tool-vm-lease-agent-mismatch',
	});
});
```

- [ ] **Step 2: Run route tests to verify failure**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/agent-vm/src/controller/http/controller-client.test.ts
```

Expected: FAIL because current route/preflight is too scope-shaped and response types lack `agentId`.

- [ ] **Step 3: Implement route plumbing**

Pass `agentId` to the lease manager:

```ts
const lease = await options.leaseManager.createLease({
	agentId,
	agentWorkspaceDir: payload.agentWorkspaceDir,
	effectiveIdleTtlMs: effectiveIdleTtl.value,
	profile: defaultToolVmProfile,
	profileId: resolvedProfileId,
	scopeKey: payload.scopeKey,
	guestWorkdir: resolvedWorkMount.guestWorkdir,
	hostWorkMountDir: resolvedWorkMount.hostWorkMountDir,
	...(resolvedWorkMount.zoneGitMount ? { zoneGitMount: resolvedWorkMount.zoneGitMount } : {}),
	zoneId: payload.zoneId,
});
```

Remove exact `scopeKey === agent:<agentId>` rejection. Keep only agent ownership validation:

```ts
const sessionAgentId = resolveOpenClawAgentIdFromSessionKey(payload.sessionKey);
if (isOpenClawAgentSessionKey(payload.sessionKey) && sessionAgentId !== payload.agentId) {
	return context.json(
		{
			error: 'tool-vm-lease-agent-mismatch',
			message: `Lease agentId '${payload.agentId}' does not match sessionKey agent '${sessionAgentId}'.`,
		},
		400,
	);
}
```

- [ ] **Step 4: Map incompatible agent lease reuse to structured `409`**

In `controller-http-routes.ts`, catch `AgentLeaseCompatibilityConflictError` from `createLease` and return `409`. The error should be surfaced to the plugin and OpenClaw caller; do not auto-release the old lease, do not retry, and do not silently allocate a second VM for the same `zoneId + agentId`.

Expected response shape:

```json
{
  "error": "agent-tool-vm-lease-compatibility-conflict",
  "message": "existing Tool VM lease for agent 'beta' is not compatible with this request; mismatched fields: profileId",
  "guidance": "Managed OpenClaw/Gondolin reuses one Tool VM per zone and agent. Release the existing lease or use a compatible profile/workspace/workdir.",
  "received": {
    "agentId": "beta",
    "zoneId": "shravan",
    "mismatchedFields": ["profileId"]
  }
}
```

Add a controller route test that posts a second incompatible request and asserts `409` plus the structured fields above.

- [ ] **Step 5: Add agentId to response serialization**

In `controller-http-route-support.ts`, include:

```ts
agentId: lease.agentId,
```

In `controller-lease-response-types.ts`, include:

```ts
agentId: z.string(),
```

- [ ] **Step 6: Run route tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/agent-vm/src/controller/http/controller-client.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/src/controller/http/controller-http-routes.ts packages/agent-vm/src/controller/http/controller-http-route-support.ts packages/agent-vm/src/controller/http/controller-lease-response-types.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/agent-vm/src/controller/http/controller-client.test.ts
git commit -m "fix: preserve scope provenance for agent leases"
```

---

### Task 4: Plugin Caches Tool VM Handles By Agent

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-gondolin-contract.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
- Test: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`
- Test: `packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts`
- Test: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`

- [ ] **Step 1: Write plugin tests for channel-shaped scope reuse**

Add to `sandbox-backend-factory.test.ts`:

```ts
it('reuses one handle for channel-shaped scopes under the same agent', async () => {
	const requestLease = vi.fn(async () =>
		createLeaseResponse('shravan-beta-100', {
			agentId: 'beta',
			scopeKey: 'agent:beta:discord:channel:123',
		}),
	);
	const backendFactory = createGondolinSandboxBackendFactory(
		{ controllerUrl: 'http://controller.vm.host:18800', zoneId: 'shravan' },
		createDependencies({ requestLease }),
	);

	await backendFactory({
		agentWorkspaceDir: '/workspace/beta',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:discord:channel:123',
		sessionKey: 'agent:beta:discord:channel:123',
		workspaceDir: '/workspace/beta',
	});
	await backendFactory({
		agentWorkspaceDir: '/workspace/beta',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:discord:channel:999',
		sessionKey: 'agent:beta:discord:channel:999',
		workspaceDir: '/workspace/beta',
	});

	expect(requestLease).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run plugin tests to verify failure**

Run:

```bash
pnpm vitest run \
  packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts \
  packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts \
  packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts
```

Expected: FAIL because cache/preflight still treats raw scope as the identity axis.

- [ ] **Step 3: Loosen scope guidance and keep sandbox contract strict**

In `openclaw-gondolin-contract.ts`, keep sandbox config requirements strict:

```ts
backend === 'gondolin'
mode === 'all'
scope === 'agent'
workspaceAccess === 'rw'
```

Remove guidance that says the lease `scopeKey` must exactly equal `agent:<agentId>`. Replace with:

```ts
export const OPENCLAW_GONDOLIN_LEASE_SCOPE_GUIDANCE =
	'Managed OpenClaw/Gondolin requires an explicit agentId. scopeKey is OpenClaw scope provenance and may include channel, session, thread, or subagent segments under that agent.';
```

- [ ] **Step 4: Cache by agent identity**

In `sandbox-backend-handle-factory.ts`, replace the cache key helper with:

```ts
function agentLeaseCacheKey(params: {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly profileId: string;
	readonly workspaceDir: string;
	readonly zoneId: string;
}): string {
	return [
		params.zoneId,
		params.agentId,
		params.profileId,
		params.agentWorkspaceDir,
		params.workspaceDir,
	].join('\0');
}
```

Keep `scopeKey` in the controller request:

```ts
await requestLease({
	agentId,
	agentWorkspaceDir: params.agentWorkspaceDir,
	profileId,
	sandbox: params.cfg,
	scopeKey: params.scopeKey,
	sessionKey: params.sessionKey,
	workMountDir: params.workspaceDir,
	zoneId: options.zoneId,
});
```

- [ ] **Step 5: Surface controller `409` compatibility conflicts**

In `controller-lease-client.test.ts`, add a structured conflict test:

```ts
it('surfaces agent lease compatibility conflicts without retrying or releasing', async () => {
	const fetch = vi.fn(async () =>
		new Response(
			JSON.stringify({
				error: 'agent-tool-vm-lease-compatibility-conflict',
				guidance:
					'Managed OpenClaw/Gondolin reuses one Tool VM per zone and agent. Release the existing lease or use a compatible profile/workspace/workdir.',
				message:
					"existing Tool VM lease for agent 'beta' is not compatible with this request; mismatched fields: profileId",
				received: {
					agentId: 'beta',
					mismatchedFields: ['profileId'],
					zoneId: 'shravan',
				},
			}),
			{ status: 409, headers: { 'content-type': 'application/json' } },
		),
	);

	await expect(requestLease(validLeaseRequest(), { fetch })).rejects.toThrow(
		/existing Tool VM lease for agent 'beta'.*Guidance: Managed OpenClaw\/Gondolin/u,
	);
	expect(fetch).toHaveBeenCalledTimes(1);
});
```

The plugin must treat `409` as a hard create-backend failure from the controller and surface the structured message to OpenClaw. It must not auto-release, retry with a different scope, or allocate a second Tool VM for the same `zoneId + agentId`.

- [ ] **Step 6: Update fixtures for response `agentId`**

Every lease response helper should include:

```ts
agentId: overrides?.agentId ?? 'main',
```

- [ ] **Step 7: Run plugin tests**

Run:

```bash
pnpm vitest run \
  packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts \
  packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts \
  packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/openclaw-agent-vm-plugin/src/openclaw-gondolin-contract.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts
git commit -m "refactor: cache gondolin handles by agent"
```

---

### Task 5: Store Tool VM Runtime Records By UUID

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/tool-vm-runtime-record.ts`
- Test: `packages/agent-vm/src/controller/leases/tool-vm-runtime-record.test.ts`

- [ ] **Step 1: Write failing strict-schema tests**

Add to `tool-vm-runtime-record.test.ts`:

```ts
it('stores agent, lease, vm, and pid identity but rejects scopeKey', () => {
	const record = validToolVmRuntimeRecord({
		agentId: 'beta',
		leaseId: 'shravan-beta-1779576951215',
		qemuPid: 12345,
		recordId: '01890f00-0000-7000-8000-000000000000',
		vmId: 'vm-tool-beta',
	});

	expect(toolVmRuntimeRecordSchema.parse(record)).toMatchObject({
		agentId: 'beta',
		leaseId: 'shravan-beta-1779576951215',
		qemuPid: 12345,
		recordId: '01890f00-0000-7000-8000-000000000000',
		vmId: 'vm-tool-beta',
	});

	expect(() =>
		toolVmRuntimeRecordSchema.parse({
			...record,
			scopeKey: 'agent:beta:discord:channel:123',
		}),
	).toThrow();
});

it('uses recordId as the only filename identity', () => {
	const record = validToolVmRuntimeRecord({
		leaseId: 'shravan-beta-1779576951215',
		recordId: '01890f00-0000-7000-8000-000000000000',
	});

	expect(toolVmRuntimeRecordFilename(record)).toBe(
		'01890f00-0000-7000-8000-000000000000.json',
	);
});
```

- [ ] **Step 2: Run runtime-record tests to verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/tool-vm-runtime-record.test.ts
```

Expected: FAIL because schema still includes `scopeKey` and filenames derive from `leaseId`.

- [ ] **Step 3: Implement strict runtime record schema**

Replace the schema with:

```ts
export const toolVmRuntimeRecordSchema = z.strictObject({
	schemaVersion: z.literal(1),
	recordId: z.uuid(),
	agentId: z.string().min(1),
	leaseId: z.string().min(1),
	vmId: z.string().min(1),
	qemuPid: z.number().int().positive(),
	processIdentity: z.strictObject({
		command: z.string().min(1),
		lstart: z.string().min(1),
	}),
	configPath: z.string().min(1),
	controllerPort: z.number().int().positive(),
	projectNamespace: z.string().min(1),
	zoneId: z.string().min(1),
	gateway: z.strictObject({
		sessionLabel: z.string().min(1),
		vmId: z.string().min(1).optional(),
	}),
	tcpSlot: z.number().int().nonnegative(),
	sessionLabel: z.string().min(1),
	createdAt: z.iso.datetime(),
});
```

Implement filename helpers:

```ts
export function toolVmRuntimeRecordFilename(record: ToolVmRuntimeRecord): string {
	return `${record.recordId}.json`;
}
```

Delete `assertPathSafeLeaseId`, invalid/quarantine path helpers, and `quarantineToolVmRuntimeRecord`.

- [ ] **Step 4: Change loaders to warn/return parse errors without mutation**

Use a discriminated load result:

```ts
export type ToolVmRuntimeRecordLoadResult =
	| { readonly kind: 'loaded'; readonly path: string; readonly record: ToolVmRuntimeRecord }
	| { readonly kind: 'parse-error'; readonly path: string; readonly error: Error };
```

`loadAllToolVmRuntimeRecords` should return load results and never rename/delete malformed files.

- [ ] **Step 5: Run runtime-record tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/tool-vm-runtime-record.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/leases/tool-vm-runtime-record.ts packages/agent-vm/src/controller/leases/tool-vm-runtime-record.test.ts
git commit -m "refactor: store tool vm records by uuid"
```

---

### Task 6: Recovery Uses Host-Side Ownership Proof

**Files:**
- Create: `packages/agent-vm/src/shared/port-owner.ts`
- Create: `packages/agent-vm/src/shared/port-owner.test.ts`
- Modify: `packages/agent-vm/src/shared/managed-vm-process.ts`
- Test: `packages/agent-vm/src/shared/managed-vm-process.test.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-runtime-record.ts`
- Test: `packages/agent-vm/src/gateway/gateway-runtime-record.test.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-recovery.ts`
- Test: `packages/agent-vm/src/gateway/gateway-recovery.test.ts`
- Modify: `packages/agent-vm/src/controller/leases/tool-vm-recovery.ts`
- Test: `packages/agent-vm/src/controller/leases/tool-vm-recovery.test.ts`
- Modify: `packages/agent-vm/src/operations/controller-offline-cleanup.ts`
- Test: `packages/agent-vm/src/operations/controller-offline-cleanup.test.ts`

- [ ] **Step 1: Write port-owner tests**

Create `port-owner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseLsofPortOwnerOutput } from './port-owner.js';

describe('parseLsofPortOwnerOutput', () => {
	it('parses pid and command from lsof field output', () => {
		expect(parseLsofPortOwnerOutput('p12345\ncqemu-system-aarch64\n')).toEqual({
			command: 'qemu-system-aarch64',
			pid: 12345,
		});
	});

	it('returns null for empty lsof output', () => {
		expect(parseLsofPortOwnerOutput('')).toBeNull();
	});
});

it('maps missing lsof to an actionable host dependency error', async () => {
	await expect(
		readTcpListenPortOwner(19500, {
			execFile: async () => {
				const error = new Error('spawn lsof ENOENT') as Error & { code: string };
				error.code = 'ENOENT';
				throw error;
			},
		}),
	).rejects.toThrow(/requires 'lsof' on PATH/u);
});
```

- [ ] **Step 2: Implement port-owner helper**

Create `port-owner.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PortOwner {
	readonly command: string;
	readonly pid: number;
}

export function parseLsofPortOwnerOutput(output: string): PortOwner | null {
	const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
	const pidLine = lines.find((line) => line.startsWith('p'));
	const commandLine = lines.find((line) => line.startsWith('c'));
	if (!pidLine || !commandLine) {
		return null;
	}
	const pid = Number.parseInt(pidLine.slice(1), 10);
	if (!Number.isInteger(pid) || pid <= 0) {
		return null;
	}
	return { command: commandLine.slice(1), pid };
}

export class PortOwnerDependencyError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'PortOwnerDependencyError';
	}
}

export interface ReadTcpListenPortOwnerDependencies {
	readonly execFile?: typeof execFileAsync;
}

export async function readTcpListenPortOwner(
	port: number,
	dependencies: ReadTcpListenPortOwnerDependencies = {},
): Promise<PortOwner | null> {
	const runExecFile = dependencies.execFile ?? execFileAsync;
	try {
		const { stdout } = await runExecFile('lsof', [
			'-nP',
			`-iTCP:${String(port)}`,
			'-sTCP:LISTEN',
			'-F',
			'pc',
		]);
		return parseLsofPortOwnerOutput(stdout);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
			return null;
		}
		if (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'ENOENT'
		) {
			throw new PortOwnerDependencyError(
				`Tool VM/gateway recovery requires 'lsof' on PATH to verify TCP listener ownership for port ${String(port)}.`,
				{ cause: error },
			);
		}
		throw error;
	}
}
```

- [ ] **Step 3: Write recovery tests for warn+skip and port proof**

Add hard-cut gateway runtime record tests in `gateway-runtime-record.test.ts`:

```ts
it('rejects pre-cutover gateway runtime records without the new schema version', () => {
	expect(() =>
		gatewayRuntimeRecordSchema.parse({
			configPath: '/deployments/beta/config/system.jsonc',
			controllerPort: 18900,
			ingressPort: 18891,
			projectNamespace: 'shravan-claw-beta-25319b68',
			qemuPid: 12345,
			sessionLabel: 'shravan-claw-beta-25319b68:beta:gateway',
			vmId: 'gateway-beta',
			zoneId: 'beta',
		}),
	).toThrow();
});

it('rejects unsupported quarantine-era gateway runtime record fields', () => {
	expect(() =>
		gatewayRuntimeRecordSchema.parse({
			...validGatewayRuntimeRecord(),
			scopeKey: 'agent:beta',
		}),
	).toThrow();
});

it('requires process identity for current gateway runtime records', () => {
	const { processIdentity: _processIdentity, ...recordWithoutProcessIdentity } =
		validGatewayRuntimeRecord();

	expect(() => gatewayRuntimeRecordSchema.parse(recordWithoutProcessIdentity)).toThrow();
});
```

Add to `tool-vm-recovery.test.ts`:

```ts
it('skips without signaling when a tool VM port is held by a different pid', async () => {
	const record = validToolVmRuntimeRecord({
		qemuPid: 111,
		tcpSlot: 0,
	});
	await writeToolVmRuntimeRecord(stateDir, record);
	const killProcess = vi.fn();
	const warnings: string[] = [];

	await cleanupOrphanedToolVmsIfPresent(
		createCleanupOptions({
			logWarn: (message) => warnings.push(message),
			stateDir,
		}),
		{
			killProcess,
			readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
		},
	);

	expect(killProcess).not.toHaveBeenCalled();
	expect(warnings.join('\n')).toContain('held by pid 222, expected pid 111');
});

it('throws in offline cleanup when a tool VM port is held by a different pid', async () => {
	const record = validToolVmRuntimeRecord({
		qemuPid: 111,
		tcpSlot: 0,
	});
	await writeToolVmRuntimeRecord(stateDir, record);
	const killProcess = vi.fn();

	await expect(
		cleanupOrphanedToolVmsIfPresent(
			createCleanupOptions({
				mode: 'offline-cleanup',
				stateDir,
			}),
			{
				killProcess,
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
			},
		),
	).rejects.toThrow(/port .* is held by pid 222, expected pid 111/u);
	expect(killProcess).not.toHaveBeenCalled();
});
```

Add:

```ts
it('deletes a stale record when its pid is gone and its port is free', async () => {
	const record = validToolVmRuntimeRecord({ qemuPid: 111, tcpSlot: 0 });
	await writeToolVmRuntimeRecord(stateDir, record);

	await cleanupOrphanedToolVmsIfPresent(createCleanupOptions({ stateDir }), {
		isProcessAlive: () => false,
		readTcpListenPortOwner: async () => null,
	});

	await expect(access(toolVmRuntimeRecordPath(stateDir, record.recordId))).rejects.toMatchObject({
		code: 'ENOENT',
	});
});
```

Add the load-bearing signal paths:

```ts
it('terminates and deletes an owned record when the port is held by the recorded qemu pid', async () => {
	const record = validToolVmRuntimeRecord({ qemuPid: 111, tcpSlot: 0 });
	await writeToolVmRuntimeRecord(stateDir, record);
	const killProcess = vi.fn();

	await cleanupOrphanedToolVmsIfPresent(createCleanupOptions({ stateDir }), {
		killProcess,
		readTcpListenPortOwner: vi
			.fn()
			.mockResolvedValueOnce({ command: 'qemu-system-aarch64', pid: 111 })
			.mockResolvedValue(null),
		readProcessIdentity: async () => record.processIdentity,
	});

	expect(killProcess).toHaveBeenCalledWith(111, 'SIGTERM');
	await expect(access(toolVmRuntimeRecordPath(stateDir, record.recordId))).rejects.toMatchObject({
		code: 'ENOENT',
	});
});

it('escalates to SIGKILL when SIGTERM does not release the owned port', async () => {
	const record = validToolVmRuntimeRecord({ qemuPid: 111, tcpSlot: 0 });
	await writeToolVmRuntimeRecord(stateDir, record);
	const killProcess = vi.fn();

	await cleanupOrphanedToolVmsIfPresent(createCleanupOptions({ stateDir }), {
		killProcess,
		readTcpListenPortOwner: vi
			.fn()
			.mockResolvedValueOnce({ command: 'qemu-system-aarch64', pid: 111 })
			.mockResolvedValueOnce({ command: 'qemu-system-aarch64', pid: 111 })
			.mockResolvedValueOnce(null),
		readProcessIdentity: async () => record.processIdentity,
	});

	expect(killProcess).toHaveBeenCalledWith(111, 'SIGTERM');
	expect(killProcess).toHaveBeenCalledWith(111, 'SIGKILL');
});

it('warns and skips when the recorded pid owns the port but is not a managed VM command', async () => {
	const record = validToolVmRuntimeRecord({ qemuPid: 111, tcpSlot: 0 });
	await writeToolVmRuntimeRecord(stateDir, record);
	const killProcess = vi.fn();
	const warnings: string[] = [];

	await cleanupOrphanedToolVmsIfPresent(createCleanupOptions({ stateDir, logWarn: (message) => warnings.push(message) }), {
		killProcess,
		readTcpListenPortOwner: async () => ({ command: '/usr/bin/python3', pid: 111 }),
	});

	expect(killProcess).not.toHaveBeenCalled();
	expect(warnings.join('\n')).toContain('not a managed VM process');
});

it('throws when SIGTERM and SIGKILL do not release an owned port', async () => {
	const record = validToolVmRuntimeRecord({ qemuPid: 111, tcpSlot: 0 });
	await writeToolVmRuntimeRecord(stateDir, record);

	await expect(
		cleanupOrphanedToolVmsIfPresent(createCleanupOptions({ stateDir }), {
			killProcess: vi.fn(),
			readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 111 }),
			readProcessIdentity: async () => record.processIdentity,
		}),
	).rejects.toThrow('Failed to terminate owned Tool VM');
});

it('warns and skips malformed records during in-process recovery', async () => {
	await writeFile(path.join(toolVmRuntimeRecordsDir(stateDir), 'malformed.json'), '{}\n');
	const warnings: string[] = [];

	await cleanupOrphanedToolVmsIfPresent(
		createCleanupOptions({
			logWarn: (message) => warnings.push(message),
			mode: 'in-process-recovery',
			stateDir,
		}),
	);

	expect(warnings.join('\n')).toContain('skipping malformed Tool VM runtime record');
});

it('throws on malformed records during offline cleanup', async () => {
	await writeFile(path.join(toolVmRuntimeRecordsDir(stateDir), 'malformed.json'), '{}\n');

	await expect(
		cleanupOrphanedToolVmsIfPresent(
			createCleanupOptions({
				mode: 'offline-cleanup',
				stateDir,
			}),
		),
	).rejects.toThrow(/malformed Tool VM runtime record/u);
});
```

Add gateway parity tests in `gateway-recovery.test.ts`:

```ts
it('skips gateway recovery when the ingress port is held by a different pid during startup recovery', async () => {
	const record = validGatewayRuntimeRecord({ ingressPort: 18891, qemuPid: 111 });
	await writeGatewayRuntimeRecord(stateDir, record);
	const killProcess = vi.fn();
	const warnings: string[] = [];

	await cleanupOrphanedGatewayIfPresent(
		createGatewayRecoveryOptions({ mode: 'in-process-recovery', stateDir }),
		{
			killProcess,
			log: (message) => warnings.push(message),
			readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
		},
	);

	expect(killProcess).not.toHaveBeenCalled();
	expect(warnings.join('\n')).toContain('held by pid 222');
});

it('throws in offline cleanup when the gateway ingress port is held by a different pid', async () => {
	const record = validGatewayRuntimeRecord({ ingressPort: 18891, qemuPid: 111 });
	await writeGatewayRuntimeRecord(stateDir, record);
	const killProcess = vi.fn();

	await expect(
		cleanupOrphanedGatewayIfPresent(
			createGatewayRecoveryOptions({ mode: 'offline-cleanup', stateDir }),
			{
				killProcess,
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
			},
		),
	).rejects.toThrow(/port 18891 is held by pid 222/u);
	expect(killProcess).not.toHaveBeenCalled();
});
```

Add a startup-facing dependency error test in `gateway-zone-orchestrator.test.ts` or `controller-runtime.test.ts`:

```ts
it('fails startup with an actionable error when lsof is unavailable during recovery', async () => {
	await expect(
		startGatewayZone(
			createStartGatewayZoneOptions({
				cleanupOrphanedToolVmsIfPresent: async () => {
					throw new PortOwnerDependencyError(
						"Tool VM/gateway recovery requires 'lsof' on PATH to verify TCP listener ownership for port 19500.",
					);
				},
			}),
		),
	).rejects.toThrow(/requires 'lsof' on PATH/u);
});
```

- [ ] **Step 4: Run recovery tests to verify failure**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/shared/port-owner.test.ts \
  packages/agent-vm/src/controller/leases/tool-vm-recovery.test.ts
```

Expected: FAIL because recovery does not use port-owner checks and still quarantines mismatches.

- [ ] **Step 5: Fix stored process identity parsing**

In `managed-vm-process.ts`, fix `findLstartCommandBoundary` so it splits after the fifth `lstart` token:

```ts
function findLstartCommandBoundary(line: string): number | null {
	let tokenCount = 0;
	let inToken = false;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		const isSpace = character === ' ' || character === '\t';
		if (!isSpace && !inToken) {
			inToken = true;
		} else if (isSpace && inToken) {
			inToken = false;
			tokenCount += 1;
			if (tokenCount === 5) {
				return index;
			}
		}
	}
	return null;
}
```

Add a unit test with `Fri May 22 10:00:00 2026 qemu-system-aarch64 ...`.

- [ ] **Step 6: Implement warn+skip recovery**

In `tool-vm-recovery.ts`, dependency-inject:

```ts
readonly readTcpListenPortOwner?: (port: number) => Promise<PortOwner | null>;
readonly portForSlot?: (slot: number) => number;
readonly logWarn?: (message: string) => void;
```

Preserve the cleanup mode:

```ts
readonly mode?: 'in-process-recovery' | 'offline-cleanup';
```

For `mode: 'offline-cleanup'`, deployment fence mismatches, identity mismatches, port-owner mismatches, and malformed records keep throwing. For `mode: 'in-process-recovery'`, they warn+skip without signaling or mutating.

For each loaded result:

```ts
if (loadResult.kind === 'parse-error') {
	if (mode === 'offline-cleanup') {
		throw new Error(
			`malformed Tool VM runtime record '${loadResult.path}': ${loadResult.error.message}`,
			{ cause: loadResult.error },
		);
	}
	logWarn(`skipping malformed Tool VM runtime record '${loadResult.path}': ${loadResult.error.message}`);
	continue;
}
```

For ownership proof:

```ts
const expectedPort = portForSlot(record.tcpSlot);
const portOwner = await readTcpListenPortOwner(expectedPort);
if (portOwner === null) {
	// Port is free, but the record is not safe to delete yet. Continue into
	// the recorded-pid liveness + process-identity check. Delete only after
	// that pid is proven dead or after a matching managed VM process is killed.
} else if (portOwner.pid !== record.qemuPid) {
	const message = `Tool VM runtime record '${record.recordId}' port ${String(expectedPort)} is held by pid ${String(portOwner.pid)}, expected pid ${String(record.qemuPid)}.`;
	if (mode === 'offline-cleanup') {
		throw new Error(message);
	}
	logWarn(`skipping ${message}`);
	continue;
}
```

Keep the existing `processIdentityMatches` check before signaling. If identity or command does not match, warn+skip in startup mode and throw in offline cleanup mode.

- [ ] **Step 7: Apply the same port-owner guard to gateway recovery**

In `gateway-recovery.ts`, inject:

```ts
readonly readTcpListenPortOwner?: (port: number) => Promise<PortOwner | null>;
```

Before signaling the gateway pid, first check deployment fences (`configPath`, `controllerPort`, `projectNamespace`, `zoneId`, `sessionLabel`), then check `runtimeRecord.ingressPort`. If the port is free, continue into the recorded-pid process identity check before deleting the record. If the port is held by a different pid, branch exactly like Tool VM recovery:

```ts
const portOwner = await readTcpListenPortOwner(runtimeRecord.ingressPort);
if (portOwner !== null && portOwner.pid !== runtimeRecord.qemuPid) {
	const message = `Gateway runtime record for zone '${runtimeRecord.zoneId}' port ${String(runtimeRecord.ingressPort)} is held by pid ${String(portOwner.pid)}, expected pid ${String(runtimeRecord.qemuPid)}.`;
	if (mode === 'offline-cleanup') {
		throw new Error(message);
	}
	logWarn(`skipping ${message}`);
	return { cleanedUp: false, cleanupWarning: message, stateDir, zoneId: runtimeRecord.zoneId };
}
```

Delete pre-cutover gateway record defaults, backfills, schema migrations, and quarantine helpers. Gateway recovery should parse exactly one current schema and apply the same hard-cut behavior as Tool VM records. If a malformed or non-current record appears during `in-process-recovery`, warn+skip without mutating; if it appears during `offline-cleanup`, throw.

- [ ] **Step 8: Delete only after proof**

Keep this invariant:

```ts
// Delete only after:
// 1. record fences match this deployment,
// 2. pid is already dead and port is free, OR
// 3. pid/process identity/port evidence proves ownership and the kill succeeded.
```

- [ ] **Step 9: Preserve strict offline cleanup invocation**

In `controller-offline-cleanup.ts`, call Tool VM cleanup before gateway cleanup:

```ts
await cleanupOrphanedToolVmsIfPresent({
	...zoneCleanupOptions,
	mode: 'offline-cleanup',
});
await cleanupOrphanedGatewayIfPresent({
	...zoneCleanupOptions,
	mode: 'offline-cleanup',
});
```

Add `controller-offline-cleanup.test.ts` coverage proving:

- `agent-vm controller cleanup --config ... --zone ...` still refuses to run while the configured controller health endpoint is reachable unless `--force` is passed.
- When cleanup is allowed, Tool VM cleanup is invoked before gateway cleanup.
- Both cleanup calls receive `mode: 'offline-cleanup'`.
- A mismatch/error from either cleanup path is thrown to the operator, not warn+skipped.

- [ ] **Step 10: Run recovery tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/shared/port-owner.test.ts \
  packages/agent-vm/src/shared/managed-vm-process.test.ts \
  packages/agent-vm/src/gateway/gateway-recovery.test.ts \
  packages/agent-vm/src/operations/controller-offline-cleanup.test.ts \
  packages/agent-vm/src/controller/leases/tool-vm-runtime-record.test.ts \
  packages/agent-vm/src/controller/leases/tool-vm-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/agent-vm/src/shared/port-owner.ts packages/agent-vm/src/shared/port-owner.test.ts packages/agent-vm/src/shared/managed-vm-process.ts packages/agent-vm/src/shared/managed-vm-process.test.ts packages/agent-vm/src/gateway/gateway-runtime-record.ts packages/agent-vm/src/gateway/gateway-runtime-record.test.ts packages/agent-vm/src/gateway/gateway-recovery.ts packages/agent-vm/src/gateway/gateway-recovery.test.ts packages/agent-vm/src/controller/leases/tool-vm-recovery.ts packages/agent-vm/src/controller/leases/tool-vm-recovery.test.ts packages/agent-vm/src/operations/controller-offline-cleanup.ts packages/agent-vm/src/operations/controller-offline-cleanup.test.ts
git commit -m "fix: recover tool vms with host ownership proof"
```

---

### Task 7: Thread Runtime Record Fields From Lease Creation

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- Test: `packages/agent-vm/src/controller/leases/lease-manager.test.ts`
- Test: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`

Recovery ordering decision: after the controller port is bound, load the persisted gateway record and this zone's Tool VM records, clean valid Tool VM child records in parallel first, then clean the gateway record. Do not use a global "kill all then delete all" transaction. Delete each runtime record only after that record's process is proven gone or killed. This keeps recovery idempotent while preserving startup performance: child cleanup is parallel within the Tool VM phase, and unrelated Phase A startup branches stay concurrent.

- [ ] **Step 1: Write tests for record write shape**

In `lease-manager.test.ts`, assert record write receives:

```ts
expect(writeToolVmRuntimeRecord).toHaveBeenCalledWith(
	stateDir,
	expect.objectContaining({
		agentId: 'beta',
		leaseId: expect.stringMatching(/^shravan-beta-\d+$/u),
		qemuPid: expect.any(Number),
		recordId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
		vmId: 'vm-tool-beta',
	}),
);
```

Assert no scope:

```ts
expect(writeToolVmRuntimeRecord).toHaveBeenCalledWith(
	stateDir,
	expect.not.objectContaining({
		scopeKey: expect.anything(),
	}),
);
```

- [ ] **Step 2: Implement record construction**

When creating the lease:

```ts
const runtimeRecordId = crypto.randomUUID();
const leaseId = `${leaseOptions.zoneId}-${leaseOptions.agentId}-${createdAt}`;
```

Build the runtime record:

```ts
await writeToolVmRuntimeRecord(options.stateDir, {
	agentId: leaseOptions.agentId,
	configPath: options.configPath,
	controllerPort: options.controllerPort,
	createdAt: new Date(createdAt).toISOString(),
	gateway: options.gateway,
	leaseId,
	processIdentity,
	projectNamespace: options.projectNamespace,
	qemuPid: managedVm.pid,
	recordId: runtimeRecordId,
	schemaVersion: 1,
	sessionLabel,
	tcpSlot,
	vmId: managedVm.id,
	zoneId: leaseOptions.zoneId,
});
```

Use `runtimeRecordId` for deletes in `releaseLease` and evictions:

```ts
await deleteToolVmRuntimeRecord(options.stateDir, lease.runtimeRecordId);
```

- [ ] **Step 3: Sequence Tool VM child recovery before gateway recovery**

In `gateway-zone-orchestrator.ts`, make Phase A startup order explicit:

```ts
await runTaskStep('Cleaning orphaned Tool VM runtimes', async () => {
	await cleanupOrphanedToolVmsIfPresent(...);
});

await runTaskStep('Cleaning orphaned gateway runtime', async () => {
	await cleanupOrphanedGatewayIfPresent(...);
});
```

`cleanupOrphanedToolVmsIfPresent` should clean all valid Tool VM child records for the zone in parallel, with the same per-record ownership proof and per-record delete-after-proof invariant. Keep unrelated Phase A branches concurrent where they are independent (`mcp portal materialization`, OpenClaw requirement validation, secret resolution, image build). Do not run gateway cleanup and Tool VM cleanup in parallel with each other; the gateway parent cleanup starts only after the Tool VM child phase settles.

Keep `TcpPool.quarantine()`, `releaseQuarantined()`, and `isQuarantined()` as the normal-runtime close-failure defense. Startup recovery proves ownership from runtime records and port/process checks; TCP slot quarantine is only for the already-running controller after `vm.close()` fails or a port may still be settling.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/leases/lease-manager.test.ts \
  packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/leases/lease-manager.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts
git commit -m "refactor: record tool vm lease ownership"
```

---

### Task 8: Docs And Manuals

**Files:**
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/architecture/storage-model.md`
- Modify: `docs/architecture/storage-matrix.md`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Test: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Update architecture wording**

In `docs/architecture/openclaw-gateway.md`, replace scope-key identity prose with:

```md
Managed OpenClaw/Gondolin Tool VM leases are agent-keyed. The controller
creates or reuses one compatible Tool VM per `zoneId + agentId`. OpenClaw
`scopeKey` remains in the lease request and response as channel/session
provenance and TTL-policy input, but it is not a Tool VM identity axis.
```

- [ ] **Step 2: Update storage docs**

In `docs/architecture/storage-model.md` and `docs/architecture/storage-matrix.md`, document:

```md
Tool VM runtime records live under `$stateDir/tool-leases/<recordId>.json`.
`recordId` is a controller-generated UUID. Records keep `agentId`, `leaseId`,
`vmId`, `qemuPid`, deployment fences, and TCP/session evidence. They never
persist OpenClaw `scopeKey`.
```

- [ ] **Step 3: Document the host `lsof` requirement**

In `docs/reference/configuration/system-json.md`, add a host dependency note near the controller/gateway runtime requirements:

```md
Tool VM and gateway startup recovery use host-side TCP listener ownership checks
before signaling recorded QEMU/krun processes. The controller requires `lsof`
on the host for that recovery path. If `lsof` is unavailable and persisted
runtime records need port-owner verification, startup fails with a clear host
dependency error instead of guessing ownership.
```

- [ ] **Step 4: Update generated manual**

In `manual-templates.ts`, add:

```md
OpenClaw Tool VMs are agent-keyed in managed deployments: one compatible Tool
VM per zone and OpenClaw agent id. OpenClaw `scopeKey` may describe a channel,
thread, session, or subagent scope under that agent; it is not the Tool VM
identity. Controller startup binds the controller port before recovery, so a
second controller exits before cleanup instead of killing a running gateway.
Host recovery uses `lsof` to check TCP listener ownership before signaling
persisted gateway or Tool VM pids.
```

- [ ] **Step 5: Add manual assertions**

In `manual-templates.test.ts`:

```ts
expect(runtimePaths).toContain('one compatible Tool VM per zone and OpenClaw agent id');
expect(runtimePaths).toContain('scopeKey may describe a channel');
expect(runtimePaths).toContain('binds the controller port before recovery');
expect(runtimePaths).toContain('uses `lsof` to check TCP listener ownership');
```

- [ ] **Step 6: Run docs/manual test**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/architecture/openclaw-gateway.md docs/architecture/storage-model.md docs/architecture/storage-matrix.md docs/reference/configuration/system-json.md packages/agent-vm/src/cli/manual-templates.ts packages/agent-vm/src/cli/manual-templates.test.ts
git commit -m "docs: describe agent keyed tool vm recovery"
```

---

### Task 9: Local Automated Verification

**Files:**
- Test: unit, integration, smoke, type, lint, format, and fixture sweeps.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/controller-runtime.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/agent-vm/src/controller/leases/lease-manager.test.ts \
  packages/agent-vm/src/controller/leases/tool-vm-runtime-record.test.ts \
  packages/agent-vm/src/controller/leases/tool-vm-recovery.test.ts \
  packages/agent-vm/src/shared/port-owner.test.ts \
  packages/agent-vm/src/shared/managed-vm-process.test.ts \
  packages/agent-vm/src/gateway/gateway-recovery.test.ts \
  packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts \
  packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts \
  packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts \
  packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts \
  packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

- [ ] **Step 2: Sweep fixture drift**

Run:

```bash
rg -n "ToolVmRuntimeRecord|validToolVmRuntimeRecord|scopeKey:|leaseId:|recordId:" packages/agent-vm/src packages/openclaw-agent-vm-plugin/src
```

Expected:

- Tool VM runtime record fixtures include `agentId`, `leaseId`, `recordId`, `vmId`, and `qemuPid`.
- Tool VM runtime record fixtures do not include `scopeKey`.
- Lease request/response fixtures may still include `scopeKey`.

- [ ] **Step 3: Sweep lease id contract**

Run:

```bash
rg -n "lease\\.id|leaseId|scopeKey|agentId|recordId" \
  packages/agent-vm/src/controller/leases \
  packages/agent-vm/src/controller/http \
  packages/openclaw-agent-vm-plugin/src
```

Expected:

- `lease.id` construction uses `${zoneId}-${agentId}-${createdAt}`.
- `scopeKey` appears in request/response/TTL/provenance code only.
- `scopeKey` is not used as a live lease reuse key.
- `scopeKey` is not written to Tool VM runtime records.
- `recordId` is used for Tool VM runtime record filenames and deletes.

- [ ] **Step 4: Run package unit suite**

Run:

```bash
pnpm test:unit
```

Expected: PASS. Record the total test count and skipped count in the implementation PR body.

- [ ] **Step 5: Run integration suite**

Run:

```bash
pnpm test:integration
```

Expected: PASS or explicit environment-gated skips only. If a test skips, record the skip reason from Vitest output.

- [ ] **Step 6: Run smoke suite with pinned tools**

Run:

```bash
mise exec -- pnpm test:smoke
```

Expected: PASS or explicit smoke-gated skips only. This must use `mise exec --` so the repo-pinned Zig/Gondolin toolchain is active.

- [ ] **Step 7: Run full quality gate**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 8: Build packages**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 9: Commit verification fixes if tests forced code changes**

If verification discovers drift, fix it in the relevant task area and commit the fix. Do not create a "verification-only" commit unless a persistent test/doc artifact was added.

---

### Task 10: Local Runtime Smoke Before Beta

**Files:**
- Test: live local OpenClaw/Gondolin smoke where available.
- Inspect: local state records under a temporary smoke project.

- [ ] **Step 1: Assert the smoke state roots are clean**

This branch is new development work and does not include a runtime-record migration path. Before live testing, verify the beta/smoke state roots do not contain leftover runtime records from another run that would confuse the smoke:

```bash
find /Users/shravansunder/.agent-vm/state -path '*/tool-leases/*.json' -print
```

Expected: no records unless a controller is currently running and owns them. If records exist, stop and decide explicitly whether they are active runtime state that should be cleaned through the controller or local state the user wants removed. Do not add a startup migration or compatibility shim.

- [ ] **Step 2: Verify `lsof` is available**

Run:

```bash
command -v lsof
```

Expected: prints an absolute path. If missing, stop and fix the host dependency before live recovery testing.

- [ ] **Step 3: Run the live sandbox lease smoke**

Run:

```bash
AGENT_VM_GONDOLIN_SMOKE=1 pnpm vitest run packages/agent-vm/src/integration-tests/live-sandbox-e2e.integration.test.ts
```

Expected:

- PASS when the machine has QEMU/Gondolin support.
- If skipped by gate, record the exact gate output and rely on Task 11 beta proof for live behavior.

- [ ] **Step 4: Run OpenClaw MCP Portal smoke when the machine can boot Gondolin**

Run:

```bash
AGENT_VM_OPENCLAW_SMOKE=1 mise exec -- pnpm vitest run packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts
```

Expected:

- PASS when local Gondolin smoke prerequisites are present.
- If skipped, record the skip reason and do not claim local live OpenClaw proof.

- [ ] **Step 5: Inspect local smoke lease shape**

If Step 3 or Step 4 created local Tool VM records, run:

```bash
find /Users/shravansunder/.agent-vm/state -path '*/tool-leases/*.json' -print
```

For each record created by this worktree's smoke run:

```bash
for record_file in /Users/shravansunder/.agent-vm/state/*/tool-leases/*.json; do
	printf '%s\n' "$record_file"
	jq '{recordId, agentId, leaseId, vmId, qemuPid, hasScopeKey: has("scopeKey")}' "$record_file"
done
```

Expected:

```json
{
  "recordId": "01890f00-0000-7000-8000-000000000000",
  "agentId": "smoke",
  "leaseId": "mcp-portal-smoke-smoke-1779576951215",
  "vmId": "tool-vm-smoke",
  "qemuPid": 12345,
  "hasScopeKey": false
}
```

- [ ] **Step 6: Verify no local process leak after smoke**

Run:

```bash
ps -axo pid,command | rg "qemu-system|krun|gondolin" || true
```

Expected: no unexpected smoke-created Tool VM remains after test teardown. If a process remains, use record evidence and controller cleanup, not `pkill`.

---

### Task 11: Beta Deployment Verification And Startup Timing

**Files:**
- Inspect: beta deployment config and beta state directory.
- Test: local beta controller runtime after publish/update.

This task runs only after the branch is merged, packages are version-bumped and published, and beta has been updated to the new package version. Do not claim beta proof from unit tests.

- [ ] **Step 1: Capture beta baseline before changing beta**

In `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta`, record current package version, config path, controller port, zone id, state dir, and TCP pool:

```bash
cd /Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta
pwd
git status --short --branch
rg -n '"@agent-vm/agent-vm"|"controllerPort"|"stateDir"|"id":|"type": "openclaw"|"basePort"|"size"' package.json pnpm-lock.yaml config/system.jsonc config/gateways/beta/openclaw.json
```

Expected:

- The deployment being tested is the intended beta deployment.
- Current observed beta values before this plan: `controllerPort: 18900`, zone id `beta`, `stateDir: /Users/shravansunder/.agent-vm/state/beta`, `tcpPool.basePort: 19500`, and package `@agent-vm/agent-vm: 0.0.76`.
- If beta config changed, use the observed values from this step for the remaining beta commands and write them in the verification notes.

- [ ] **Step 2: Capture startup baseline timing before the update**

Stop beta cleanly if it is running:

```bash
pnpm exec agent-vm controller stop --config config/system.jsonc || true
```

Start beta in the background, poll `/health` until ready, and save logs. Do not use `/usr/bin/time` around the foreground controller process because that reports only after the long-running controller exits.

```bash
rm -f /tmp/agent-vm-beta-start-before.log
start_epoch_ms=$(node -e 'console.log(Date.now())')
pnpm exec agent-vm controller start --config config/system.jsonc --zone beta > /tmp/agent-vm-beta-start-before.log 2>&1 &
controller_pid=$!
for attempt in $(seq 1 240); do
	status_json=$(curl -fsS http://127.0.0.1:18900/health 2>/dev/null || true)
	if printf '%s\n' "$status_json" | jq -e '.ok == true or .ready == true' >/dev/null 2>&1; then
		ready_epoch_ms=$(node -e 'console.log(Date.now())')
		printf 'ready_ms=%s controller_pid=%s\n' "$((ready_epoch_ms - start_epoch_ms))" "$controller_pid" | tee /tmp/agent-vm-beta-start-before.ready
		break
	fi
	sleep 1
done
test -f /tmp/agent-vm-beta-start-before.ready
pnpm exec agent-vm controller stop --config config/system.jsonc || true
```

Expected:

- Controller reaches healthy/ready state.
- `/tmp/agent-vm-beta-start-before.ready` contains readiness latency in milliseconds.
- The baseline controller is stopped before package update begins.
- Save the first timestamped log line that says gateway startup/recovery begins and the line that says controller is ready, if present.

- [ ] **Step 3: Update beta to the published package version**

From the `agent-vm.perf-parallel-gateway-zone-start` worktree, verify the package version that was published:

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.perf-parallel-gateway-zone-start
published_version=$(node -p "require('./packages/agent-vm/package.json').version")
npm view @agent-vm/agent-vm@"$published_version" version
npm view @agent-vm/openclaw-agent-vm-plugin@"$published_version" version
```

Then update beta:

```bash
cd /Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta
published_version=$(npm view @agent-vm/agent-vm version)
pnpm up "@agent-vm/agent-vm@$published_version"
pnpm install
```

Expected:

- `package.json` and lockfile resolve every `@agent-vm/*` package to the same published version.
- Do not mix workspace packages with registry packages in beta.

- [ ] **Step 4: Start beta after update and capture startup timing**

Run:

```bash
rm -f /tmp/agent-vm-beta-start-after.log
start_epoch_ms=$(node -e 'console.log(Date.now())')
pnpm exec agent-vm controller start --config config/system.jsonc --zone beta > /tmp/agent-vm-beta-start-after.log 2>&1 &
controller_pid=$!
for attempt in $(seq 1 240); do
	status_json=$(curl -fsS http://127.0.0.1:18900/health 2>/dev/null || true)
	if printf '%s\n' "$status_json" | jq -e '.ok == true or .ready == true' >/dev/null 2>&1; then
		ready_epoch_ms=$(node -e 'console.log(Date.now())')
		printf 'ready_ms=%s controller_pid=%s\n' "$((ready_epoch_ms - start_epoch_ms))" "$controller_pid" | tee /tmp/agent-vm-beta-start-after.ready
		break
	fi
	sleep 1
done
test -f /tmp/agent-vm-beta-start-after.ready
```

Expected:

- Controller binds the controller port before recovery.
- During recovery, `/health` may return 503 with state `recovering`.
- Controller eventually reaches ready/healthy.
- The `ready_ms` value is not materially worse than the baseline. If it is more than 15% slower and the delta is not explained by image rebuild, dependency install, or cold cache, stop and investigate before PR/merge readiness.

- [ ] **Step 5: Verify the controller port election prevents unsafe cleanup**

While beta is running, try to start a second controller on the same config in another shell:

```bash
pnpm exec agent-vm controller start --config config/system.jsonc --zone beta
```

Expected:

- The second process fails on port bind before gateway or Tool VM recovery runs.
- The running beta gateway and existing Tool VMs continue running.
- No Tool VM runtime record is deleted or mutated by the losing process.

- [ ] **Step 6: Verify lease creation from beta**

Create a beta Tool VM lease through the same controller API payload shape the OpenClaw plugin sends. This avoids relying on Discord timing while still exercising controller lease creation, Tool VM boot, runtime record write, and process ownership.

```bash
mkdir -p /Users/shravansunder/.agent-vm/state/beta/sandboxes/beta-lease-proof
cat >/tmp/agent-vm-beta-parent-lease.json <<'JSON'
{
  "agentId": "beta",
  "agentWorkspaceDir": "/home/openclaw/.openclaw/state/sandboxes/beta-lease-proof",
  "profileId": "standard",
  "sandbox": {
    "backend": "gondolin",
    "mode": "all",
    "scope": "agent",
    "workspaceAccess": "rw"
  },
  "scopeKey": "agent:beta:manual:parent-proof",
  "sessionKey": "agent:beta:manual-parent",
  "workMountDir": "/home/openclaw/.openclaw/state/sandboxes/beta-lease-proof",
  "zoneId": "beta"
}
JSON
curl -fsS \
  -H 'content-type: application/json' \
  -d @/tmp/agent-vm-beta-parent-lease.json \
  http://127.0.0.1:18900/lease | tee /tmp/agent-vm-beta-parent-lease-response.json
pnpm exec agent-vm controller lease list --config config/system.jsonc | tee /tmp/agent-vm-beta-leases.json
```

Expected shape:

```json
[
  {
    "agentId": "beta",
    "id": "beta-beta-1779576951215",
    "profileId": "standard",
    "scopeKey": "agent:beta:manual:parent-proof",
    "zoneId": "beta"
  }
]
```

Important assertions:

- `id` does not contain `agent:` or any channel/session/subagent scope string.
- `agentId` is present.
- `scopeKey` is still present and may be channel/session/subagent-shaped.
- Parent and subagent tool use keep one compatible Tool VM lease for the same beta agent/profile/workspace.

- [ ] **Step 7: Verify lease reuse across parent and subagent**

Issue a second lease request for the same beta agent/profile/workspace with a different subagent-shaped scope:

```bash
cat >/tmp/agent-vm-beta-subagent-lease.json <<'JSON'
{
  "agentId": "beta",
  "agentWorkspaceDir": "/home/openclaw/.openclaw/state/sandboxes/beta-lease-proof",
  "profileId": "standard",
  "sandbox": {
    "backend": "gondolin",
    "mode": "all",
    "scope": "agent",
    "workspaceAccess": "rw"
  },
  "scopeKey": "agent:beta:subagent:manual-child",
  "sessionKey": "agent:beta:subagent:manual-child",
  "workMountDir": "/home/openclaw/.openclaw/state/sandboxes/beta-lease-proof",
  "zoneId": "beta"
}
JSON
curl -fsS \
  -H 'content-type: application/json' \
  -d @/tmp/agent-vm-beta-subagent-lease.json \
  http://127.0.0.1:18900/lease | tee /tmp/agent-vm-beta-subagent-lease-response.json
jq -r '.leaseId // .id' /tmp/agent-vm-beta-parent-lease-response.json
jq -r '.leaseId // .id' /tmp/agent-vm-beta-subagent-lease-response.json
test "$(jq -r '.leaseId // .id' /tmp/agent-vm-beta-parent-lease-response.json)" = "$(jq -r '.leaseId // .id' /tmp/agent-vm-beta-subagent-lease-response.json)"
pnpm exec agent-vm controller lease list --config config/system.jsonc | jq '[.[] | {id, agentId, profileId, scopeKey, tcpSlot, zoneId}]'
```

Expected:

- Exactly one live compatible lease for `agentId == "beta"` when profile/workspace are compatible.
- `scopeKey` may reflect the first request's channel/session/subagent provenance.
- A subagent does not create a second Tool VM merely because its OpenClaw scope string is different.

- [ ] **Step 8: Verify runtime record JSON in beta**

Run:

```bash
find /Users/shravansunder/.agent-vm/state/beta/tool-leases -maxdepth 1 -type f -name '*.json' -print
jq '{
  recordId,
  agentId,
  leaseId,
  vmId,
  qemuPid,
  tcpSlot,
  hasScopeKey: has("scopeKey")
}' /Users/shravansunder/.agent-vm/state/beta/tool-leases/*.json
```

Expected:

```json
{
  "recordId": "01890f00-0000-7000-8000-000000000000",
  "agentId": "beta",
  "leaseId": "beta-beta-1779576951215",
  "vmId": "tool-vm-beta",
  "qemuPid": 12345,
  "tcpSlot": 0,
  "hasScopeKey": false
}
```

- [ ] **Step 9: Verify process ownership evidence**

For each beta runtime record:

```bash
for record in /Users/shravansunder/.agent-vm/state/beta/tool-leases/*.json; do
	pid=$(jq -r '.qemuPid' "$record")
	tcp_slot=$(jq -r '.tcpSlot' "$record")
	tool_port=$((19500 + tcp_slot))
	printf 'record=%s pid=%s tcpSlot=%s port=%s\n' "$record" "$pid" "$tcp_slot" "$tool_port"
	ps -p "$pid" -o pid= -o lstart= -o command=
	lsof -nP -iTCP:"$tool_port" -sTCP:LISTEN -F pc
done
```

Expected:

- `ps` shows a managed VM command (`qemu-system-*` or `krun`) for the recorded pid.
- `lsof` reports the same pid for the Tool VM listen port.
- The listen port check corroborates the record; it is not treated as identity by itself.

- [ ] **Step 10: Verify restart recovery does not hurt startup speed**

Stop beta cleanly:

```bash
pnpm exec agent-vm controller stop --config config/system.jsonc || true
```

Start beta again with timing:

```bash
rm -f /tmp/agent-vm-beta-start-restart.log
start_epoch_ms=$(node -e 'console.log(Date.now())')
pnpm exec agent-vm controller start --config config/system.jsonc --zone beta > /tmp/agent-vm-beta-start-restart.log 2>&1 &
controller_pid=$!
for attempt in $(seq 1 240); do
	status_json=$(curl -fsS http://127.0.0.1:18900/health 2>/dev/null || true)
	if printf '%s\n' "$status_json" | jq -e '.ok == true or .ready == true' >/dev/null 2>&1; then
		ready_epoch_ms=$(node -e 'console.log(Date.now())')
		printf 'ready_ms=%s controller_pid=%s\n' "$((ready_epoch_ms - start_epoch_ms))" "$controller_pid" | tee /tmp/agent-vm-beta-start-restart.ready
		break
	fi
	sleep 1
done
test -f /tmp/agent-vm-beta-start-restart.ready
```

Expected:

- Warm restart `ready_ms` is within 15% of the pre-change warm baseline unless logs show a legitimate cold rebuild/cache miss.
- Recovery does not perform broad process scans or process-tree kills.
- Recovery logs are bounded by the number of persisted runtime records.

- [ ] **Step 11: Verify no unsafe orphan cleanup against a running controller**

With beta running, capture pids:

```bash
pnpm exec agent-vm controller lease list --config config/system.jsonc
ps -axo pid,command | rg "qemu-system|krun|gondolin" | tee /tmp/agent-vm-beta-vms-before-second-start.txt
```

Attempt the second start from Step 5 again, then capture pids:

```bash
ps -axo pid,command | rg "qemu-system|krun|gondolin" | tee /tmp/agent-vm-beta-vms-after-second-start.txt
diff -u /tmp/agent-vm-beta-vms-before-second-start.txt /tmp/agent-vm-beta-vms-after-second-start.txt || true
```

Expected:

- Any diff is explainable by normal runtime churn, not by the losing process killing gateway/Tool VM pids.
- If any recorded pid disappears, stop and diagnose before continuing.

- [ ] **Step 12: Record beta evidence**

Save the following in the PR body or release notes, not as a repo artifact unless the user asks for one:

- Published package version installed in beta.
- Startup baseline `ready_ms` and after-change `ready_ms`.
- Lease list excerpt proving `lease.id` excludes scope and includes `agentId`.
- Runtime record excerpt proving `recordId`, `agentId`, `leaseId`, `vmId`, `qemuPid`, and no `scopeKey`.
- Subagent reuse evidence proving one live compatible lease for beta.

---

### Task 12: Subagent Review Gate

**Files:**
- Review: entire branch diff and this plan.

- [ ] **Step 1: Commit all implementation work before review**

Run:

```bash
git status --short --branch
git log --oneline --decorate origin/master..HEAD
```

Expected:

- All implementation changes are committed.
- Only intentional untracked local evidence files remain, if any.

- [ ] **Step 2: Ask a reviewer subagent for adversarial review**

Spawn a reviewer with this exact scope:

```text
Review the entire perf/parallel-gateway-zone-start branch against origin/master.
Focus on:
1. Managed OpenClaw Tool VM identity is zoneId + agentId, not scopeKey.
2. scopeKey remains request/response/TTL provenance and may vary by channel/session/subagent.
3. lease.id never includes scopeKey.
4. Tool VM runtime records persist recordId, agentId, leaseId, vmId, qemuPid, fences, and no scopeKey.
5. Controller port bind happens before recovery and prevents a second controller from cleaning a running controller's gateway/Tool VMs.
6. Ports are locks/corroborating evidence, not identity.
7. Gateway and Tool VM recovery do not signal unless ownership is proven.
8. Startup speed is not materially regressed.
9. Tests and docs/manuals cover the contract.

Return findings ordered P0-P3 with exact file/line citations and distinguish observed facts from inference.
```

- [ ] **Step 3: Triage reviewer findings**

For each finding:

- P0/P1 correctness or safety issue: fix before PR readiness.
- P2 test/doc gap: fix unless the finding is based on a false premise; document why if rejected.
- P3 style/naming issue: fix if low risk; otherwise record as follow-up.

- [ ] **Step 4: Re-run impacted tests after review fixes**

Run the narrow tests for changed areas, then:

```bash
pnpm test:unit
pnpm check
```

Expected: PASS.

- [ ] **Step 5: Final branch readiness check**

Run:

```bash
git status --short --branch
git log --oneline --decorate origin/master..HEAD
```

Expected:

- Branch contains coherent commits.
- No unrelated dirty files.
- PR body can cite local automated proof, beta proof, startup timing proof, and reviewer proof.

---

## Self-Review

### Spec Coverage

- Agent-keyed VM reuse: Task 2, Task 3, Task 4, Task 9.
- Agent lease compatibility guards for profile/workspace/workdir: Task 2 and Task 4.
- Arbitrary scopeKey under an agent: Task 3 and Task 4.
- Lease id excludes scope id: Task 2 and Task 9.
- Runtime record keeps `agentId`, `leaseId`, `vmId`, `qemuPid`, and no `scopeKey`: Task 5, Task 7, Task 9.
- Controller port is the lock/election; no file lock: Task 1.
- `/health` reports recovering/not-ready until startup is ready: Task 1 and Task 11.
- Recovery does not kill a live controller's gateway: Task 1 and Task 6.
- Port is not identity: covered by Correct Mental Model and Task 6; port-owner checks are corroborating evidence plus controller election.
- Gateway recovery parity and hard-cut record schema: covered by Task 6.
- Offline cleanup stays strict: covered by Task 6.
- Recovery route gating: covered by Task 1.
- No runtime-record migration/backward compatibility: Non-goals, Task 5, Task 6, and Task 10.
- Local automated test proof: covered by Task 9.
- Local live smoke proof: covered by Task 10.
- Beta lease/process/startup-speed proof: covered by Task 11.
- Beta direct lease and subagent-shaped lease reuse proof: covered by Task 11.
- Subagent/adversarial review gate: covered by Task 12.
- Files, not SQLite/Drizzle: Non-goals and Task 5.
- Warn+skip for unproven ownership: Task 6.
- Docs/manuals aligned: Task 8.

### Placeholder Scan

No TBD/TODO/fill-in placeholders. Every task names files, test snippets, implementation snippets, commands, and expected outcomes.

### Type Consistency

- `agentId` is a required lease/request/record field.
- `scopeKey` remains a request/response field and TTL input, but is not a reuse key and is not durable recovery state.
- `leaseId` is public API correlation and safe after the new shape removes raw scope.
- `recordId` is the only durable filename identity.
- `runtimeReadiness` gates routes while the controller is recovering.
- `processIdentity` stays in runtime records; port-owner checks do not replace identity checks.
