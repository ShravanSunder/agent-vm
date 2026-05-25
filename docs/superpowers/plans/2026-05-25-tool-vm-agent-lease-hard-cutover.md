# Tool VM Agent Lease Hard Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hard-cut the current scope-bearing Tool VM lease API/storage/TTL surface to an agent-scoped contract, and ship the companion managed Gondolin ingress defaults needed for agent workloads.

**Architecture:** Agent-vm supports only managed OpenClaw/Gondolin Tool VM leases for `zoneId + agentId`. OpenClaw `scopeKey` stays outside agent-vm: the plugin may receive it from OpenClaw core, but it must not send it to the controller, and the controller must not store, return, log, or derive TTL from it. Lease renewal becomes a validity check: existing, unexpired, and live; invalid leases are evicted and the plugin refreshes its cached handle by creating a new lease. Managed VM ingress defaults are applied in the Gondolin adapter so OpenClaw/gateway traffic is not constrained by low buffering or short upstream timeouts unless the caller explicitly overrides them.

**Tech Stack:** TypeScript, pnpm, Vitest, Zod, Hono, `uuid` v7, `@agent-vm/gateway-interface`, `@agent-vm/openclaw-agent-vm-plugin`, `@agent-vm/agent-vm`.

---

## Non-Negotiable Contract

The managed lease identity is:

```text
zoneId + agentId
```

The current code already reuses leases primarily by `zoneId + agentId`; this plan does not claim that reuse identity is still scope-shaped. The hard cutover removes `scopeKey` from the remaining API, runtime record, response, log, TTL, docs, and test surfaces where it still creates the wrong mental model.

The following values are not lease identity:

```text
scopeKey
createdAt
sessionKey
workMountDir
guest workdir
profileId
tcpSlot
pid
vmId
```

`profileId`, `workMountDir`, `agentWorkspaceDir`, and zone-git mount details are reuse constraints for an existing per-agent VM. They are not id components.

`scopeKey` is removed completely from:

```text
controller /lease request body
controller /lease response body
controller /lease/:id/peek response body
controller /leases list output
Lease type
LeaseManager createLease options
LeaseManager idle reaper inputs
ToolVmSshLease and ToolVmLeasePeek gateway-interface types
controller request schemas
controller response schemas
runtime records
docs/manual examples
```

The plugin may keep `params.scopeKey` only as an OpenClaw SDK input it ignores for agent-vm lease purposes. Do not log it in lease failure messages.

There is no old-record or old-API support in this plan. Runtime records, HTTP request bodies, response bodies, tests, docs, and generated manuals cut over in one pass. Startup must not migrate, quarantine, rename, or silently delete records that do not match the new schema.

## OpenClaw Boundary Facts

These facts are grounded in the local OpenClaw checkout at `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw` and were cross-checked with DeepWiki for `openclaw/openclaw`.

- `src/agents/sandbox/context.ts` resolves sandbox paths before calling the backend factory. Under the managed `workspaceAccess: "rw"` tuple, `workspaceDir` equals `agentWorkspaceDir`, and both are resolved host/RealFS paths.
- The backend factory never receives Tool VM guest `/workspace` through the OpenClaw SDK. `/workspace` is the guest mount path returned by agent-vm after the controller chooses the validated RealFS source.
- `src/agents/sandbox/shared.ts` resolves `scope="agent"` to `agent:<agentId>`. The plugin still treats any received `scopeKey` as discardable SDK context, because agent-vm identity is `zoneId + agentId`.
- `src/agents/tools/sessions-spawn-tool.ts` forwards `cwd` to the ACP branch. The normal `runtime="subagent"` branch passes workspace context, not `cwd`, to child sessions.

## Companion Gondolin Ingress Fix

The lease fix and ingress fix are separate behaviors in one branch because they were found in the same beta workflow failure path.

Ingress issue:

```text
Managed agent traffic should let the client and server own streaming,
websocket, upload, and download behavior. The adapter should not add
small buffering or short upstream timeout defaults that make OpenClaw
or subagent workflows look broken from the outside.
```

Managed default behavior:

```ts
export const MANAGED_VM_DEFAULT_INGRESS_OPTIONS = {
	allowWebSockets: true,
	bufferResponseBody: false,
	maxBufferedResponseBodyBytes: 512 * 1024 * 1024,
	upstreamHeaderTimeoutMs: 120_000,
	upstreamResponseTimeoutMs: 120_000,
} satisfies EnableIngressOptions;
```

Explicit caller options still win. A controller or future package adapter may pass a smaller buffer, disable websockets, or change timeouts for a specific VM; the adapter default only fills omitted values.

## Target Request And Response

Plugin to controller:

```ts
export interface LeaseRequest {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly idleTtlMs?: number;
	readonly profileId: string;
	readonly sessionKey: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}
```

Controller to plugin:

```ts
export interface ToolVmSshLease extends VmSshLease<'ssh-sandbox'> {
	readonly agentId: string;
	readonly idleTtlMs?: number;
	readonly tcpSlot: number;
	readonly workdir: string;
}
```

Peek response:

```ts
export interface ToolVmLeasePeek extends VmCapabilityLease<'ssh-sandbox'> {
	readonly agentId: string;
	readonly createdAt: number;
	readonly lastUsedAt: number;
	readonly profileId: string;
	readonly ssh: VmSshPublicEndpoint;
	readonly tcpSlot: number;
	readonly workdir: string;
	readonly zoneId: string;
}
```

No `scopeKey`. No `sandbox` tuple. `backend=gondolin`, `mode=all`, `scope=agent`, and `workspaceAccess=rw` are fixed by the managed OpenClaw plugin and asserted plugin-side before any controller request.

## Requirements Matrix

| Requirement | Unit Tests | Integration Tests | Smoke/Manual Proof |
|---|---|---|---|
| `scopeKey` removed from lease API/model | `tool-vm-lease.test.ts`, `controller-request-schemas.test.ts`, `lease-manager.test.ts` | `controller-http-routes.test.ts`, `controller-integration.test.ts` | `curl /lease` response has no `scopeKey` |
| Opaque UUIDv7 lease id | `tool-vm-lease-id.test.ts`, `lease-manager.test.ts` | `controller-http-routes.test.ts` | `/leases` ids match UUIDv7 and do not contain zone/agent/scope |
| Expired renew cannot resurrect lease | `lease-manager.test.ts` | `controller-http-routes.test.ts`, plugin cache test | beta subagent rerun creates fresh lease after expiry |
| Dead VM renew cannot return 200 | `lease-manager.test.ts` | plugin/controller integration test | controller logs eviction; plugin creates fresh handle |
| Plugin refreshes cached handle on refreshable renew failure | `sandbox-backend-factory.test.ts` | `controller-integration.test.ts` | fresh subagent command succeeds after killed Tool VM |
| Same-agent subagents reuse one Tool VM | plugin cache test | OpenClaw-shaped controller integration fixture | two same-agent sessions produce one lease id |
| Cross-agent subagents use separate Tool VMs | plugin cache test | controller integration fixture | beta/alpha requests produce different lease ids |
| `/workspace` rejected as lease input | `lease-work-mount-paths.test.ts` | `controller-http-routes.test.ts` | negative curl returns `outside-allowed-roots` |
| `/workspace` returned as normal Tool VM workdir | `controller-http-route-support.test.ts` or route test | controller integration fixture | lease response `workdir=/workspace` |
| Single TTL default | `lease-idle-policy.test.ts` removal/rewrite | route response test | configless lease returns expected idle TTL |
| Active-use is only an operation guard | `lease-manager.test.ts`, `tool-vm-active-use.test.ts` | plugin exec/finalize tests | long command not idle-released while active |
| Plugin SSH probe/report invalidates stale handles | `tool-vm-active-use.test.ts`, `tool-vm-ssh-operation-guard.test.ts`, `sandbox-backend-factory.test.ts` | plugin/controller active-use route tests | killed or hung SSH causes next operation to request a fresh lease |
| Managed ingress defaults support agent traffic | `vm-adapter.test.ts` | gateway/openclaw smoke after lease work | `enableIngress()` defaults include websockets, no buffering, 512MiB cap, 120s timeouts |

## File Structure

Create:

- `packages/gateway-interface/src/tool-vm-lease-id.ts`
  - Owns opaque Tool VM lease id creation and validation.
  - Uses UUIDv7 through the existing `uuid` package.

- `packages/gateway-interface/src/tool-vm-lease-id.test.ts`
  - Proves lease ids are UUIDv7 and rejects UUIDv4/non-uuid values.

Modify:

- `packages/gateway-interface/src/tool-vm-lease.ts`
  - Remove `scopeKey` from `ToolVmSshLease` and `ToolVmLeasePeek`.
  - Require `leaseId` validation through `isToolVmLeaseId` where practical.

- `packages/gateway-interface/src/tool-vm-lease.test.ts`
  - Update shape tests to reject `scopeKey`.

- `packages/gateway-interface/src/tool-vm-active-use.ts`
  - Add typed operation report payloads for plugin-observed SSH state.
  - Heartbeats remain operation guards, not VM health probes.
  - Add jittered heartbeat scheduling without retaining report history.

- `packages/gateway-interface/src/tool-vm-active-use.test.ts`
  - Prove active-use reports are bounded to the latest value.
  - Prove jittered heartbeat scheduling and timer cleanup do not leak after dispose.

- `packages/gateway-interface/src/index.ts`
  - Export lease id helpers.
  - Export active-use report types if they are not already exported through the package barrel.

- `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
  - Remove `scopeKey` and `sandbox` from `LeaseRequest`.
  - Keep `sessionKey`, `agentId`, `profileId`, `agentWorkspaceDir`, `workMountDir`, `zoneId`, `idleTtlMs`.
  - Treat renew 404/410 as refreshable.

- `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`
  - Prove request body has no `scopeKey` and no `sandbox`.
  - Prove returned lease parser does not require `scopeKey`.

- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
  - Assert managed tuple locally.
  - Do not send `scopeKey` or `sandbox` to controller.
  - Do not include `scopeKey` in cache key or logs.
  - Refresh cached handle on controller renew 404/410.
  - Treat plugin-observed SSH failures, command timeouts, and active-use refreshable failures as stale-handle signals.

- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.ts`
  - Owns plugin-side SSH operation timeout, jittered active-use reporting, stale-handle classification, and best-effort cleanup.
  - Stores only the latest operation report; no retained stdout/stderr buffers and no unbounded arrays.

- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.test.ts`
  - Proves bounded timers, jitter, timeout failure, best-effort controller reporting, stale-handle classification, and timer cleanup.

- `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`
  - Same-agent different `scopeKey` inputs reuse the same handle and only send agent-scoped request.
  - Dead/expired renew response causes cache drop and fresh request.
  - SSH failure or timeout during a cached operation drops the cached handle, so the next operation requests a fresh lease.

- `packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts`
  - Boundary integration for same-agent subagent-like requests, cross-agent requests, expired renew refresh, no `scopeKey` in request/response.

- `packages/agent-vm/src/controller/http/controller-request-schemas.ts`
  - Remove `safeScopeKeySchema`.
  - Remove `scopeKey` and `sandbox` from `controllerLeaseCreateRequestSchema`.
  - Validate `agentId` with OpenClaw-compatible regex.
  - Add Zod schemas for optional active-use operation reports.

- `packages/agent-vm/src/controller/http/controller-request-schemas.test.ts`
  - Update JSON schema snapshot expectations.
  - Add negative tests proving `scopeKey` and `sandbox` are rejected by strict schema.

- `packages/agent-vm/src/controller/http/controller-lease-response-types.ts`
  - Remove `scopeKey`.

- `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
  - Remove `scopeKey` from serialized lease and peek responses.

- `packages/agent-vm/src/controller/http/controller-http-routes.ts`
  - Remove sandbox validation.
  - Validate `agentId` matches `sessionKey` resolved agent id.
  - Pass no `scopeKey` into lease manager, seeding, workdir resolver, TTL, logs, or responses.
  - Return structured 404 refreshable error for missing/expired/dead renew.

- `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
  - Integration tests for new request/response contract.
  - Negative tests for `/workspace` request input.
  - Renew expired/dead lease returns refreshable failure.
  - Active-use start/heartbeat/end accepts bounded operation reports and stores only the latest report.

- `packages/agent-vm/src/controller/leases/lease-manager.ts`
  - Remove `scopeKey` from `Lease` and create options.
  - Replace lease id construction with injected `createLeaseId`, defaulting to UUIDv7.
  - Make `renewLease` async and liveness/expiry aware.
  - Add synchronous expiry checks for renew/create-reuse/start-active-use/heartbeat-active-use.
  - Add dead idle lease reaping for non-active leases.
  - Store the latest active-use operation report for diagnostics; do not use reports as VM liveness proof.

- `packages/agent-vm/src/controller/leases/lease-manager.test.ts`
  - Opaque id tests.
  - Expired renew eviction tests.
  - Dead VM renew eviction tests.
  - Same-agent different OpenClaw scopes no longer affect lease manager because they never enter it.
  - Latest active-use report replacement test; no report history arrays.

- `packages/agent-vm/src/controller/leases/idle-reaper.ts`
  - Remove `scopeKey` from inputs.

- `packages/agent-vm/src/controller/leases/idle-reaper.test.ts`
  - Update fixtures and add no-scope regression.

- `packages/agent-vm/src/controller/leases/lease-idle-policy.ts`
  - Remove scope-kind/prefix policy.
  - Export a single default idle TTL constant and bounds helpers.

- `packages/agent-vm/src/controller/leases/lease-idle-policy.test.ts`
  - Replace scope-prefix tests with default/requested TTL tests.

- `packages/agent-vm/src/controller/controller-runtime.ts`
  - Use one default TTL policy.
  - Remove `scopeKey` from idle reaper input.
  - Call dead idle lease reaper before idle expiry release.

- `packages/agent-vm/src/controller/controller-runtime.test.ts`
  - Update fixtures.
  - Add test that dead non-active lease is evicted by runtime reaper.

- `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts`
  - Remove `scopeKey` from inputs/results/log messages.
  - Seed by `agentId` and `hostWorkMountDir`.

- `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts`
  - Update expected result shapes and logs.

- `packages/agent-vm/src/controller/leases/tool-vm-runtime-record.ts`
  - Confirm runtime record has no `scopeKey`.
  - Ensure runtime record stores `leaseId`, `agentId`, `recordId`, `vmId`, `qemuPid`, `tcpSlot`.

- `packages/agent-vm/src/controller/leases/tool-vm-runtime-record.test.ts`
  - Strengthen rejection of `scopeKey`.
  - Assert opaque UUIDv7 `leaseId` fixtures.

- `docs/architecture/storage-model.md`
  - Update lease vocabulary and remove remaining scope-bearing lease references.

- `docs/architecture/openclaw-gateway.md`
  - Update managed Tool VM lease contract and same-agent subagent behavior.

- `docs/reference/configuration/system-json.md`
  - Remove scope-based lease TTL examples.
  - Document single lease idle TTL default.

- `packages/agent-vm/src/cli/manual-templates.ts`
  - Update generated manual text for lease identity, `/workspace`, and no `scopeKey`.

- `packages/agent-vm/src/cli/manual-templates.test.ts`
  - Assert new manual text.

- `packages/gondolin-adapter/src/vm-adapter.ts`
  - Add named managed ingress default constants.
  - Resolve omitted `enableIngress()` options against those defaults.
  - Preserve explicit caller overrides.

- `packages/gondolin-adapter/src/vm-adapter.test.ts`
  - Assert default `enableIngress()` options.
  - Assert explicit options override defaults.

Delete if unused after hard cutover:

- `packages/agent-vm/src/controller/leases/lease-scope.ts`
  - Delete only after `rg "parseAgentScopeKey|parseAgentIdFromScopeKey|lease-scope"` returns no production imports.

## Execution Preflight

- [ ] **Step 1: Confirm worktree and unrelated changes**

Run:

```bash
git status --short
git branch --show-current
```

Expected:

```text
fix/tool-vm-lease-and-ingress-defaults
```

If files outside this plan are already modified, do not revert them. Avoid editing unrelated modified files unless the task explicitly requires it.

- [ ] **Step 2: Capture the current non-lease test baseline only if needed**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/core/portal-core.test.ts -t "surfaces input validation issues in failed core item errors"
```

Expected on the plan branch when this plan was written: PASS with 1 passed and 19 skipped, or SKIP if the test name changed on a later branch. Do not bake a presumed MCP Portal failure into the lease work. If broad verification fails in MCP Portal later, rerun the focused MCP Portal test from the current checkout and classify it from current output before touching lease code.

---

### Task 0: Managed Gondolin Ingress Defaults

**Files:**
- Modify: `packages/gondolin-adapter/src/vm-adapter.ts`
- Modify: `packages/gondolin-adapter/src/vm-adapter.test.ts`

- [ ] **Step 1: Write failing ingress default tests**

In `packages/gondolin-adapter/src/vm-adapter.test.ts`, add:

```ts
it('applies managed ingress defaults when enabling ingress without explicit options', async () => {
	const enableIngressMock = vi.fn(async () => ({ host: '127.0.0.1', port: 18791 }));
	const fakeVmInstance: ManagedVmInstance = {
		...createFakeVmInstance(),
		enableIngress: enableIngressMock,
	};
	const dependencies = createBaseDependencies({
		createVm: vi.fn(async (): Promise<ManagedVmInstance> => fakeVmInstance),
	});

	const managedVm = await createManagedVm(
		{
			allowedHosts: [],
			cpus: 1,
			imagePath: '/vm-images/gateways/openclaw',
			memory: '1G',
			rootfsMode: 'memory',
			secrets: {},
			vfsMounts: {},
		},
		dependencies,
	);

	await managedVm.enableIngress();

	expect(enableIngressMock).toHaveBeenCalledWith({
		allowWebSockets: true,
		bufferResponseBody: false,
		maxBufferedResponseBodyBytes: 512 * 1024 * 1024,
		upstreamHeaderTimeoutMs: 120_000,
		upstreamResponseTimeoutMs: 120_000,
	});
});

it('lets explicit ingress options override managed defaults', async () => {
	const enableIngressMock = vi.fn(async () => ({ host: '127.0.0.1', port: 18891 }));
	const fakeVmInstance: ManagedVmInstance = {
		...createFakeVmInstance(),
		enableIngress: enableIngressMock,
	};
	const dependencies = createBaseDependencies({
		createVm: vi.fn(async (): Promise<ManagedVmInstance> => fakeVmInstance),
	});

	const managedVm = await createManagedVm(
		{
			allowedHosts: [],
			cpus: 1,
			imagePath: '/vm-images/gateways/openclaw',
			memory: '1G',
			rootfsMode: 'memory',
			secrets: {},
			vfsMounts: {},
		},
		dependencies,
	);

	await managedVm.enableIngress({
		allowWebSockets: false,
		bufferResponseBody: true,
		listenPort: 18891,
		maxBufferedResponseBodyBytes: 64 * 1024 * 1024,
		upstreamHeaderTimeoutMs: 5_000,
		upstreamResponseTimeoutMs: 10_000,
	});

	expect(enableIngressMock).toHaveBeenCalledWith({
		allowWebSockets: false,
		bufferResponseBody: true,
		listenPort: 18891,
		maxBufferedResponseBodyBytes: 64 * 1024 * 1024,
		upstreamHeaderTimeoutMs: 5_000,
		upstreamResponseTimeoutMs: 10_000,
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/vm-adapter.test.ts -t "ingress"
```

Expected: FAIL because `enableIngress()` forwards `undefined` instead of managed defaults.

- [ ] **Step 3: Implement managed ingress defaults**

In `packages/gondolin-adapter/src/vm-adapter.ts`, add:

```ts
export const MANAGED_VM_DEFAULT_INGRESS_MAX_BUFFERED_RESPONSE_BODY_BYTES = 512 * 1024 * 1024;
export const MANAGED_VM_DEFAULT_INGRESS_UPSTREAM_HEADER_TIMEOUT_MS = 120_000;
export const MANAGED_VM_DEFAULT_INGRESS_UPSTREAM_RESPONSE_TIMEOUT_MS = 120_000;

export const MANAGED_VM_DEFAULT_INGRESS_OPTIONS = {
	allowWebSockets: true,
	bufferResponseBody: false,
	maxBufferedResponseBodyBytes: MANAGED_VM_DEFAULT_INGRESS_MAX_BUFFERED_RESPONSE_BODY_BYTES,
	upstreamHeaderTimeoutMs: MANAGED_VM_DEFAULT_INGRESS_UPSTREAM_HEADER_TIMEOUT_MS,
	upstreamResponseTimeoutMs: MANAGED_VM_DEFAULT_INGRESS_UPSTREAM_RESPONSE_TIMEOUT_MS,
} satisfies EnableIngressOptions;
```

Add:

```ts
function resolveManagedVmIngressOptions(
	ingressOptions: EnableIngressOptions = {},
): EnableIngressOptions {
	const resolvedOptions: EnableIngressOptions = {
		...MANAGED_VM_DEFAULT_INGRESS_OPTIONS,
	};

	if (ingressOptions.listenHost !== undefined) {
		resolvedOptions.listenHost = ingressOptions.listenHost;
	}
	if (ingressOptions.listenPort !== undefined) {
		resolvedOptions.listenPort = ingressOptions.listenPort;
	}
	if (ingressOptions.allowWebSockets !== undefined) {
		resolvedOptions.allowWebSockets = ingressOptions.allowWebSockets;
	}
	if (ingressOptions.hooks !== undefined) {
		resolvedOptions.hooks = ingressOptions.hooks;
	}
	if (ingressOptions.bufferResponseBody !== undefined) {
		resolvedOptions.bufferResponseBody = ingressOptions.bufferResponseBody;
	}
	if (ingressOptions.maxBufferedResponseBodyBytes !== undefined) {
		resolvedOptions.maxBufferedResponseBodyBytes = ingressOptions.maxBufferedResponseBodyBytes;
	}
	if (ingressOptions.upstreamHeaderTimeoutMs !== undefined) {
		resolvedOptions.upstreamHeaderTimeoutMs = ingressOptions.upstreamHeaderTimeoutMs;
	}
	if (ingressOptions.upstreamResponseTimeoutMs !== undefined) {
		resolvedOptions.upstreamResponseTimeoutMs = ingressOptions.upstreamResponseTimeoutMs;
	}

	return resolvedOptions;
}
```

Change managed VM ingress forwarding to:

```ts
async enableIngress(ingressOptions?: EnableIngressOptions): Promise<IngressAccess> {
	return await vmInstance.enableIngress(resolveManagedVmIngressOptions(ingressOptions));
}
```

- [ ] **Step 4: Run ingress tests**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/vm-adapter.test.ts -t "ingress"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gondolin-adapter/src/vm-adapter.ts packages/gondolin-adapter/src/vm-adapter.test.ts
git commit -m "fix: default managed gondolin ingress for agent traffic"
```

---

### Task 1: Opaque Lease Id Contract In Gateway Interface

**Files:**
- Create: `packages/gateway-interface/src/tool-vm-lease-id.ts`
- Create: `packages/gateway-interface/src/tool-vm-lease-id.test.ts`
- Modify: `packages/gateway-interface/src/tool-vm-lease.ts`
- Modify: `packages/gateway-interface/src/tool-vm-lease.test.ts`
- Modify: `packages/gateway-interface/src/index.ts`

- [ ] **Step 1: Write failing lease id tests**

Create `packages/gateway-interface/src/tool-vm-lease-id.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createToolVmLeaseId, isToolVmLeaseId } from './tool-vm-lease-id.js';

describe('Tool VM lease ids', () => {
	it('creates UUIDv7 lease ids and rejects UUIDv4 ids', () => {
		const leaseId = createToolVmLeaseId();

		expect(isToolVmLeaseId(leaseId)).toBe(true);
		expect(isToolVmLeaseId('1b5c5d78-91b4-4c8e-a15e-f475dced59ef')).toBe(false);
		expect(isToolVmLeaseId('shravan-main-1700000000000')).toBe(false);
		expect(isToolVmLeaseId('agent:main:discord:channel:123')).toBe(false);
		expect(isToolVmLeaseId('not-a-uuid')).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/tool-vm-lease-id.test.ts
```

Expected: FAIL with module not found for `./tool-vm-lease-id.js`.

- [ ] **Step 3: Implement lease id helper**

Create `packages/gateway-interface/src/tool-vm-lease-id.ts`:

```ts
import { v7 as uuidv7, validate as validateUuid, version as uuidVersion } from 'uuid';

export function createToolVmLeaseId(): string {
	return uuidv7();
}

export function isToolVmLeaseId(value: unknown): value is string {
	return typeof value === 'string' && validateUuid(value) && uuidVersion(value) === 7;
}
```

- [ ] **Step 4: Export lease id helper**

Modify `packages/gateway-interface/src/index.ts` and add this export beside the active-use exports:

```ts
export { createToolVmLeaseId, isToolVmLeaseId } from './tool-vm-lease-id.js';
```

- [ ] **Step 5: Remove `scopeKey` from gateway lease types**

Replace `packages/gateway-interface/src/tool-vm-lease.ts` with this shape:

```ts
import { isToolVmLeaseId } from './tool-vm-lease-id.js';
import {
	isVmCapabilityLease,
	isVmSshEndpoint,
	isVmSshPublicEndpoint,
	type VmCapabilityLease,
	type VmSshLease,
	type VmSshPublicEndpoint,
} from './vm-capability-lease.js';

export interface ToolVmSshLease extends VmSshLease<'ssh-sandbox'> {
	readonly agentId: string;
	readonly idleTtlMs?: number;
	readonly tcpSlot: number;
	readonly workdir: string;
}

export interface ToolVmLeasePeek extends VmCapabilityLease<'ssh-sandbox'> {
	readonly agentId: string;
	readonly createdAt: number;
	readonly lastUsedAt: number;
	readonly profileId: string;
	readonly ssh: VmSshPublicEndpoint;
	readonly tcpSlot: number;
	readonly workdir: string;
	readonly zoneId: string;
}

function objectValue(value: unknown): object | undefined {
	return typeof value === 'object' && value !== null ? value : undefined;
}

export function isToolVmSshLease(value: unknown): value is ToolVmSshLease {
	const record = objectValue(value);
	return (
		isVmCapabilityLease(record, 'ssh-sandbox') &&
		isToolVmLeaseId(Reflect.get(record, 'leaseId')) &&
		isVmSshEndpoint(Reflect.get(record, 'ssh')) &&
		typeof Reflect.get(record, 'agentId') === 'string' &&
		(Reflect.get(record, 'idleTtlMs') === undefined ||
			typeof Reflect.get(record, 'idleTtlMs') === 'number') &&
		typeof Reflect.get(record, 'tcpSlot') === 'number' &&
		typeof Reflect.get(record, 'workdir') === 'string' &&
		!Reflect.has(record, 'scopeKey')
	);
}

export function isToolVmLeasePeek(value: unknown): value is ToolVmLeasePeek {
	const record = objectValue(value);
	return (
		isVmCapabilityLease(record, 'ssh-sandbox') &&
		isToolVmLeaseId(Reflect.get(record, 'leaseId')) &&
		typeof Reflect.get(record, 'agentId') === 'string' &&
		typeof Reflect.get(record, 'createdAt') === 'number' &&
		typeof Reflect.get(record, 'lastUsedAt') === 'number' &&
		typeof Reflect.get(record, 'profileId') === 'string' &&
		isVmSshPublicEndpoint(Reflect.get(record, 'ssh')) &&
		typeof Reflect.get(record, 'tcpSlot') === 'number' &&
		typeof Reflect.get(record, 'workdir') === 'string' &&
		typeof Reflect.get(record, 'zoneId') === 'string' &&
		!Reflect.has(record, 'scopeKey')
	);
}
```

- [ ] **Step 6: Update gateway-interface lease tests**

Modify `packages/gateway-interface/src/tool-vm-lease.test.ts` so valid fixtures no longer include `scopeKey`, and add:

```ts
it('rejects Tool VM lease responses that still include scopeKey', () => {
	expect(
		isToolVmSshLease({
			agentId: 'main',
			leaseId: '01890f00-0000-7000-8000-000000000000',
			scopeKey: 'agent:main:discord:channel:123',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'identity',
				knownHostsLine: '',
				port: 22,
				user: 'root',
			},
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
		}),
	).toBe(false);
});
```

- [ ] **Step 7: Run gateway-interface tests**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/tool-vm-lease-id.test.ts packages/gateway-interface/src/tool-vm-lease.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway-interface/src/tool-vm-lease-id.ts packages/gateway-interface/src/tool-vm-lease-id.test.ts packages/gateway-interface/src/tool-vm-lease.ts packages/gateway-interface/src/tool-vm-lease.test.ts packages/gateway-interface/src/index.ts
git commit -m "feat: make tool vm lease ids opaque"
```

---

### Task 2: Controller Request And Response Contract Without Scope

**Files:**
- Modify: `packages/agent-vm/src/controller/http/controller-request-schemas.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-request-schemas.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-lease-response-types.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`

- [ ] **Step 1: Write failing controller schema tests**

In `packages/agent-vm/src/controller/http/controller-request-schemas.test.ts`, add:

```ts
it('rejects deprecated lease scopeKey and sandbox fields', () => {
	const payload = {
		agentId: 'main',
		agentWorkspaceDir: '/zone/agents/main',
		profileId: 'standard',
		scopeKey: 'agent:main',
		sandbox: {
			backend: 'gondolin',
			mode: 'all',
			scope: 'agent',
			workspaceAccess: 'rw',
		},
		sessionKey: 'agent:main:manual',
		workMountDir: '/zone/agents/main',
		zoneId: 'shravan',
	};

	const result = controllerLeaseCreateRequestSchema.safeParse(payload);

	expect(result.success).toBe(false);
	expect(result.success ? [] : result.error.issues.map((issue) => issue.path)).toEqual(
		expect.arrayContaining([['scopeKey'], ['sandbox']]),
	);
});

it('accepts the hard-cutover agent lease request shape', () => {
	const result = controllerLeaseCreateRequestSchema.safeParse({
		agentId: 'main',
		agentWorkspaceDir: '/zone/agents/main',
		profileId: 'standard',
		sessionKey: 'agent:main:manual',
		workMountDir: '/zone/agents/main',
		zoneId: 'shravan',
	});

	expect(result.success).toBe(true);
});
```

- [ ] **Step 2: Run schema tests to verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-request-schemas.test.ts
```

Expected: FAIL because current schema requires `scopeKey` and `sandbox`.

- [ ] **Step 3: Replace lease create request schema**

In `packages/agent-vm/src/controller/http/controller-request-schemas.ts`, delete `safeScopeKeyPattern` and `safeScopeKeySchema`. Add:

```ts
const openClawAgentIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;

const controllerLeaseAgentIdSchema = z.string().min(1).regex(openClawAgentIdPattern, {
	message: 'agentId must match /^[a-z0-9][a-z0-9_-]{0,63}$/i',
});
```

Replace `controllerLeaseCreateRequestSchema` with:

```ts
export const controllerLeaseCreateRequestSchema = z.strictObject({
	agentId: controllerLeaseAgentIdSchema,
	agentWorkspaceDir: controllerLeaseAgentWorkspacePathSchema,
	idleTtlMs: z.number().int().positive().optional(),
	profileId: z.string().min(1),
	sessionKey: z.string().min(1),
	workMountDir: z.string().min(1),
	zoneId: z.string().min(1),
});
```

- [ ] **Step 4: Remove `scopeKey` from controller response schema**

Replace `packages/agent-vm/src/controller/http/controller-lease-response-types.ts` with:

```ts
import { z } from 'zod';

export const controllerLeasePeekResponseSchema = z.object({
	agentId: z.string(),
	createdAt: z.number(),
	lastUsedAt: z.number(),
	leaseId: z.string(),
	profileId: z.string(),
	ssh: z.object({
		host: z.string(),
		port: z.number().int(),
		user: z.string(),
	}),
	tcpSlot: z.number().int(),
	transport: z.literal('ssh-sandbox'),
	workdir: z.string(),
	zoneId: z.string(),
});

export type ControllerLeasePeekResponse = z.infer<typeof controllerLeasePeekResponseSchema>;
```

- [ ] **Step 5: Remove `scopeKey` from route support serializers**

In `packages/agent-vm/src/controller/http/controller-http-route-support.ts`, update `serializeLeaseForResponse` return type to remove `scopeKey`, and return:

```ts
return {
	agentId: lease.agentId,
	...(options.idleTtlMs !== undefined ? { idleTtlMs: options.idleTtlMs } : {}),
	leaseId: lease.id,
	ssh: {
		host: `tool-${lease.tcpSlot}.vm.host`,
		identityPem,
		knownHostsLine: '',
		port: 22,
		user: lease.sshAccess.user ?? 'root',
	},
	tcpSlot: lease.tcpSlot,
	transport: 'ssh-sandbox',
	workdir: lease.guestWorkdir,
};
```

Update `serializeLeasePeekForResponse` to remove `scopeKey`:

```ts
return {
	agentId: lease.agentId,
	createdAt: lease.createdAt,
	lastUsedAt: lease.lastUsedAt,
	leaseId: lease.id,
	profileId: lease.profileId,
	ssh: {
		host: lease.sshAccess.host,
		port: lease.sshAccess.port,
		user: lease.sshAccess.user ?? 'root',
	},
	tcpSlot: lease.tcpSlot,
	transport: 'ssh-sandbox',
	workdir: lease.guestWorkdir,
	zoneId: lease.zoneId,
};
```

- [ ] **Step 6: Write failing route contract test**

In `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`, add:

```ts
it('creates an agent-scoped lease without accepting or returning scopeKey or sandbox', async () => {
	const lease = createLeaseStub('01890f00-0000-7000-8000-000000000000', 0);
	const createLease = vi.fn(async () => lease);
	const app = createControllerAppForTest({
		leaseManager: {
			createLease,
			listLeases: vi.fn(() => []),
			peekLease: vi.fn(),
			releaseLease: vi.fn(async () => {}),
			renewLease: vi.fn(),
		},
	});

	const response = await app.request('/lease', {
		body: JSON.stringify({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
			profileId: 'standard',
			sessionKey: 'agent:main:manual',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
			zoneId: 'shravan',
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});

	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body).not.toHaveProperty('scopeKey');
	expect(createLease).toHaveBeenCalledWith(
		expect.objectContaining({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
			profileId: 'standard',
			zoneId: 'shravan',
		}),
	);
	expect(createLease).toHaveBeenCalledWith(
		expect.not.objectContaining({
			scopeKey: expect.anything(),
		}),
	);
});
```

- [ ] **Step 7: Run route test to verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts -t "creates an agent-scoped lease without accepting or returning scopeKey or sandbox"
```

Expected: FAIL because current route schema expects `scopeKey` and `sandbox`.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-vm/src/controller/http/controller-request-schemas.ts packages/agent-vm/src/controller/http/controller-request-schemas.test.ts packages/agent-vm/src/controller/http/controller-lease-response-types.ts packages/agent-vm/src/controller/http/controller-http-route-support.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
git commit -m "feat: remove scope from lease http contract"
```

---

### Task 3: Lease Manager Hard Cutover

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.test.ts`
- Modify: `packages/agent-vm/src/controller/leases/idle-reaper.ts`
- Modify: `packages/agent-vm/src/controller/leases/idle-reaper.test.ts`

- [ ] **Step 1: Write failing opaque lease id test**

In `packages/agent-vm/src/controller/leases/lease-manager.test.ts`, add:

```ts
it('creates opaque UUIDv7 lease ids instead of encoding zone, agent, or createdAt', async () => {
	const leaseManager = createLeaseManager({
		...defaultRuntimeRecordOptions,
		createLeaseId: () => '01890f00-0000-7000-8000-000000000000',
		createManagedVm: vi.fn(async () => createManagedVmStub()),
		now: () => 1700000000000,
		tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
	});

	const lease = await leaseManager.createLease(
		createAgentLeaseOptions({
			agentId: 'beta',
		}),
	);

	expect(lease.id).toBe('01890f00-0000-7000-8000-000000000000');
	expect(lease.id).not.toContain('beta');
	expect(lease.id).not.toContain('shravan');
	expect(lease.id).not.toContain('1700000000000');
});
```

- [ ] **Step 2: Write failing expired renew test**

In `packages/agent-vm/src/controller/leases/lease-manager.test.ts`, add:

```ts
it('evicts and refuses to renew an expired lease instead of resurrecting it', async () => {
	let now = 1_000;
	const closeMock = vi.fn(async () => {});
	const leaseManager = createLeaseManager({
		...defaultRuntimeRecordOptions,
		createLeaseId: () => '01890f00-0000-7000-8000-000000000001',
		createManagedVm: vi.fn(async () => ({
			...createManagedVmStub(),
			close: closeMock,
		})),
		now: () => now,
		tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
	});
	const lease = await leaseManager.createLease(
		createAgentLeaseOptions({
			effectiveIdleTtlMs: 1_000,
		}),
	);
	now = 2_001;

	const renewal = await leaseManager.renewLease(lease.id);

	expect(renewal).toEqual({ kind: 'not-found', reason: 'expired' });
	expect(closeMock).toHaveBeenCalledOnce();
	expect(leaseManager.peekLease(lease.id)).toBeUndefined();
});
```

- [ ] **Step 3: Write failing dead renew test**

In `packages/agent-vm/src/controller/leases/lease-manager.test.ts`, add:

```ts
it('evicts and refuses to renew a lease whose VM liveness check fails', async () => {
	const closeMock = vi.fn(async () => {});
	const leaseManager = createLeaseManager({
		...defaultRuntimeRecordOptions,
		createLeaseId: () => '01890f00-0000-7000-8000-000000000002',
		createManagedVm: vi.fn(async () => ({
			...createManagedVmStub(),
			close: closeMock,
			exec: vi.fn(() => createFakeExecProcess({ exitCode: 1, stdout: '', stderr: 'dead' })),
		})),
		now: () => 1_000,
		tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
	});
	const lease = await leaseManager.createLease(createAgentLeaseOptions());

	const renewal = await leaseManager.renewLease(lease.id);

	expect(renewal).toEqual({ kind: 'not-found', reason: 'dead' });
	expect(closeMock).toHaveBeenCalledOnce();
	expect(leaseManager.peekLease(lease.id)).toBeUndefined();
});
```

- [ ] **Step 4: Run lease-manager tests to verify failures**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-manager.test.ts -t "opaque UUIDv7|expired lease|VM liveness"
```

Expected: FAIL because `createLeaseId` does not exist and `renewLease` is synchronous/touch-only.

- [ ] **Step 5: Update Lease interfaces**

In `packages/agent-vm/src/controller/leases/lease-manager.ts`, remove `scopeKey` from `Lease` and `createLease` options. Change `LeaseRenewal` to:

```ts
export type LeaseRenewal =
	| {
			readonly kind: 'renewed';
			readonly lastUsedAt: number;
			readonly lease: Lease;
	  }
	| {
			readonly kind: 'not-found';
			readonly reason: 'dead' | 'expired' | 'missing';
	  };
```

Add to `createLeaseManager` options:

```ts
readonly createLeaseId?: () => string;
```

Replace `const createRuntimeRecordId = options.createRuntimeRecordId ?? randomUUID;` with:

```ts
const createLeaseId = options.createLeaseId ?? createToolVmLeaseId;
const createRuntimeRecordId = options.createRuntimeRecordId ?? randomUUID;
```

Import from gateway-interface:

```ts
createToolVmLeaseId,
```

- [ ] **Step 6: Add expiry helper**

In `lease-manager.ts`, add near `touchLease`:

```ts
function isLeaseExpired(lease: Lease): boolean {
	return lease.lastUsedAt + lease.effectiveIdleTtlMs < options.now();
}
```

- [ ] **Step 7: Use opaque lease id at creation**

Replace:

```ts
id: `${leaseOptions.zoneId}-${leaseOptions.agentId}-${createdAt}`,
```

with:

```ts
id: createLeaseId(),
```

Remove:

```ts
scopeKey: leaseOptions.scopeKey,
```

- [ ] **Step 8: Make renewLease async and validity aware**

Replace current `renewLease` method with:

```ts
async renewLease(leaseId: string): Promise<LeaseRenewal> {
	const lease = leases.get(leaseId);
	if (!lease) {
		return { kind: 'not-found', reason: 'missing' };
	}
	if (isLeaseExpired(lease)) {
		await evictLease(lease);
		return { kind: 'not-found', reason: 'expired' };
	}
	if (!(await isLeaseVmLive(lease))) {
		await evictLease(lease);
		return { kind: 'not-found', reason: 'dead' };
	}
	const renewedLease = touchLease(lease);
	return {
		kind: 'renewed',
		lastUsedAt: renewedLease.lastUsedAt,
		lease: renewedLease,
	};
}
```

- [ ] **Step 9: Update create/reuse expiry behavior**

Inside `createLease`, before `assertCompatibleAgentLeaseRequest(existingLease, leaseOptions);`, add:

```ts
if (isLeaseExpired(existingLease)) {
	await evictLease(existingLease);
} else {
	assertCompatibleAgentLeaseRequest(existingLease, leaseOptions);
	if (await isLeaseVmLive(existingLease)) {
		return touchLease(existingLease);
	}
	await evictLease(existingLease);
}
```

Then remove the old `if (existingLease) { ... }` body.

- [ ] **Step 10: Update active-use operations to reject expired leases**

At the start of `startActiveUse`, after lease lookup:

```ts
if (isLeaseExpired(lease)) {
	return undefined;
}
```

At the start of `heartbeatActiveUse`, after lease/use lookup:

```ts
if (isLeaseExpired(lease)) {
	return undefined;
}
```

Keep active-use as an operation guard only. Do not add VM liveness checks to heartbeat. Do not start background eviction from these synchronous methods; `renewLease`, `createLease`, and `reapDeadIdleLeases` own awaited cleanup.

- [ ] **Step 11: Remove `scopeKey` from idle reaper**

In `packages/agent-vm/src/controller/leases/idle-reaper.ts`, remove `scopeKey` from `getLeases()` return type:

```ts
readonly getLeases: () => {
	readonly activeUseCount: number;
	readonly effectiveIdleTtlMs: number;
	readonly id: string;
	readonly lastUsedAt: number;
}[];
```

- [ ] **Step 12: Run lease manager and idle reaper tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-manager.test.ts packages/agent-vm/src/controller/leases/idle-reaper.test.ts
```

Expected: PASS after updating existing fixtures to remove `scopeKey` and await async `renewLease`.

- [ ] **Step 13: Commit**

```bash
git add packages/agent-vm/src/controller/leases/lease-manager.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts packages/agent-vm/src/controller/leases/idle-reaper.ts packages/agent-vm/src/controller/leases/idle-reaper.test.ts
git commit -m "feat: enforce agent lease validity on renew"
```

---

### Task 4: Controller Routes Use Agent Lease Validity

**Files:**
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts`

- [ ] **Step 1: Write failing renew route expired/dead tests**

In `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`, add:

```ts
it('returns a refreshable 404 when renew finds an expired lease', async () => {
	const renewLease = vi.fn(async () => ({ kind: 'not-found' as const, reason: 'expired' as const }));
	const app = createControllerAppForTest({
		leaseManager: {
			createLease: vi.fn(),
			listLeases: vi.fn(() => []),
			peekLease: vi.fn(),
			releaseLease: vi.fn(async () => {}),
			renewLease,
		},
	});

	const response = await app.request('/lease/01890f00-0000-7000-8000-000000000000/renew', {
		method: 'POST',
	});

	expect(response.status).toBe(404);
	await expect(response.json()).resolves.toEqual({
		error: 'Lease not found',
		reason: 'expired',
		refreshable: true,
	});
});

it('returns a refreshable 404 when renew finds a dead lease', async () => {
	const renewLease = vi.fn(async () => ({ kind: 'not-found' as const, reason: 'dead' as const }));
	const app = createControllerAppForTest({
		leaseManager: {
			createLease: vi.fn(),
			listLeases: vi.fn(() => []),
			peekLease: vi.fn(),
			releaseLease: vi.fn(async () => {}),
			renewLease,
		},
	});

	const response = await app.request('/lease/01890f00-0000-7000-8000-000000000000/renew', {
		method: 'POST',
	});

	expect(response.status).toBe(404);
	await expect(response.json()).resolves.toEqual({
		error: 'Lease not found',
		reason: 'dead',
		refreshable: true,
	});
});
```

- [ ] **Step 2: Run route renew tests to verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts -t "refreshable 404"
```

Expected: FAIL because route currently treats missing as only `undefined` and `renewLease` is sync.

- [ ] **Step 3: Update `ControllerLeaseManager` type**

In `packages/agent-vm/src/controller/http/controller-http-route-support.ts`, update the picked `renewLease` method type by importing the changed `LeaseManager`; no custom sync assumption should remain. Existing `Pick<LeaseManager, ...>` will compile after route awaits `renewLease`.

- [ ] **Step 4: Await renewLease and return structured refreshable errors**

In `packages/agent-vm/src/controller/http/controller-http-routes.ts`, replace:

```ts
const leaseRenewal = options.leaseManager.renewLease(context.req.param('leaseId'));
if (!leaseRenewal) {
	return context.json({ error: 'Lease not found' }, 404);
}
```

with:

```ts
const leaseRenewal = await options.leaseManager.renewLease(context.req.param('leaseId'));
if (leaseRenewal.kind === 'not-found') {
	return context.json(
		{
			error: 'Lease not found',
			reason: leaseRenewal.reason,
			refreshable: true,
		},
		404,
	);
}
```

- [ ] **Step 5: Remove sandbox contract validation from route**

Delete `validateOpenClawGondolinLeaseContract`, `LeaseContractErrorBody`, `LeaseContractReceivedFields`, and `leaseContractErrorBody` from `controller-http-routes.ts`.

Keep session/agent consistency with:

```ts
const sessionAgentId = resolveOpenClawAgentIdFromSessionKey(payload.sessionKey);
if (sessionAgentId !== payload.agentId) {
	return context.json(
		{
			error: 'tool-vm-lease-agent-mismatch',
			message: `Lease agentId '${payload.agentId}' does not match sessionKey agent '${sessionAgentId}'.`,
			guidance:
				'The OpenClaw plugin must resolve agentId from sessionKey and send both values unchanged to the controller.',
			received: {
				agentId: payload.agentId,
				sessionAgentId,
				sessionKey: payload.sessionKey,
			},
		},
		400,
	);
}
const agentId = payload.agentId;
```

- [ ] **Step 6: Remove `scopeKey` from route request context and logs**

Change `LeaseRequestLogContext` to:

```ts
interface LeaseRequestLogContext {
	readonly agentId: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}
```

Change lease failure log to:

```ts
`[ERROR] lease creation failed diagnosticId='${options.diagnosticId}' status='${String(options.status)}' zone='${options.requestContext?.zoneId ?? '(unknown)'}' agent='${options.requestContext?.agentId ?? '(unknown)'}' workMountDir='${options.requestContext?.workMountDir ?? '(unknown)'}': ${formatUnknownError(options.error)}`
```

Change non-agent-shaped session warning to remove scope:

```ts
`[WARN] OpenClaw lease sessionKey '${payload.sessionKey}' is not agent-shaped; defaulting agentId=main zone='${payload.zoneId}'`
```

- [ ] **Step 7: Pass no scopeKey into lease creation**

Replace `createLease` call object with:

```ts
const lease = await options.leaseManager.createLease({
	agentId,
	agentWorkspaceDir: payload.agentWorkspaceDir,
	effectiveIdleTtlMs: effectiveIdleTtl.value,
	profile: defaultToolVmProfile,
	profileId: resolvedProfileId,
	guestWorkdir: resolvedWorkMount.guestWorkdir,
	hostWorkMountDir: resolvedWorkMount.hostWorkMountDir,
	...(resolvedWorkMount.zoneGitMount ? { zoneGitMount: resolvedWorkMount.zoneGitMount } : {}),
	zoneId: payload.zoneId,
});
```

- [ ] **Step 8: Run controller route tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: PASS after fixture updates remove `scopeKey` and `sandbox`.

- [ ] **Step 9: Commit**

```bash
git add packages/agent-vm/src/controller/http/controller-http-routes.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/agent-vm/src/controller/http/controller-http-route-support.ts
git commit -m "feat: return refreshable lease renewal failures"
```

---

### Task 5: Plugin Request Contract And Cache Refresh

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts`

- [ ] **Step 1: Write failing client request-body test**

In `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`, update the request test to assert:

```ts
expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
	agentId: 'main',
	agentWorkspaceDir: '/home/openclaw/work',
	profileId: 'standard',
	sessionKey: 'agent:main:session-abc',
	workMountDir: '/home/openclaw/work',
	zoneId: 'shravan',
});
```

Also add:

```ts
expect(JSON.parse(String(requests[0]?.init?.body))).not.toHaveProperty('scopeKey');
expect(JSON.parse(String(requests[0]?.init?.body))).not.toHaveProperty('sandbox');
```

- [ ] **Step 2: Run client test to verify failure**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts -t "requests, renews, peeks, and releases"
```

Expected: FAIL because current request includes `scopeKey` and `sandbox`.

- [ ] **Step 3: Remove scope/sandbox from client request type**

In `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`, change lease request interface to:

```ts
export interface LeaseRequest {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly idleTtlMs?: number;
	readonly profileId: string;
	readonly sessionKey: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}
```

Change request body construction to:

```ts
body: JSON.stringify({
	agentId: request.agentId,
	agentWorkspaceDir: request.agentWorkspaceDir,
	...(request.idleTtlMs !== undefined ? { idleTtlMs: request.idleTtlMs } : {}),
	profileId: request.profileId,
	sessionKey: request.sessionKey,
	workMountDir: request.workMountDir,
	zoneId: request.zoneId,
}),
```

- [ ] **Step 4: Refresh cache on 404 and 410**

In `sandbox-backend-handle-factory.ts`, replace:

```ts
function shouldRefreshCachedLease(error: unknown): boolean {
	return error instanceof ControllerLeaseRequestError && error.status === 404;
}
```

with:

```ts
function shouldRefreshCachedLease(error: unknown): boolean {
	return error instanceof ControllerLeaseRequestError && (error.status === 404 || error.status === 410);
}
```

- [ ] **Step 5: Remove scope from plugin request and logs**

In `createGondolinSandboxBackendFactory`, keep `params.scopeKey` only as SDK input. Replace the `requestLease` call with:

```ts
const leaseResponse = await leaseClient.requestLease({
	agentId,
	agentWorkspaceDir: params.agentWorkspaceDir,
	profileId,
	sessionKey: params.sessionKey,
	workMountDir: params.workspaceDir,
	zoneId: options.zoneId,
});
```

Replace renew failure log with:

```ts
`lease renew failed for zone '${options.zoneId}' agent '${agentId}' lease '${cachedEntry.lease.leaseId}': ${formatUnknownError(error)}`
```

- [ ] **Step 6: Keep plugin-side managed tuple assertion**

Keep `assertPluginLeaseContract` checking `cfg`. Remove `scopeKey` from its params:

```ts
function assertPluginLeaseContract(params: {
	readonly cfg: OpenClawGondolinSandboxSnapshot;
}): void {
	const mismatch = findOpenClawGondolinSandboxMismatch(params.cfg);
	if (mismatch) {
		throw new Error(
			`OpenClaw Gondolin sandbox requires ${mismatch.key}=${mismatch.expectedValue}; received ${String(params.cfg[mismatch.key])}.`,
		);
	}
}
```

Call it as:

```ts
assertPluginLeaseContract({ cfg: params.cfg });
```

- [ ] **Step 7: Write plugin cache refresh integration test**

In `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`, add:

```ts
it('refreshes the cached handle when renew reports an expired lease', async () => {
	let leaseCounter = 0;
	const renewLease = vi.fn(async () => {
		throw createControllerLeaseError(404, {
			error: 'Lease not found',
			reason: 'expired',
			refreshable: true,
		});
	});
	const requestLease = vi.fn(async () => {
		leaseCounter += 1;
		return createLeaseResponse(`01890f00-0000-7000-8000-00000000000${leaseCounter}`);
	});
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			buildExecSpec: vi.fn(async () => ({
				argv: ['ssh'],
				env: {},
				stdinMode: 'pipe-open' as const,
			})),
			createLeaseClient: () => ({
				...createActiveUseLeaseClientMethods(),
				renewLease,
				peekLease: async () => createLeasePeekResponse(),
				releaseLease: async () => {},
				requestLease,
			}),
			runRemoteShellScript: vi.fn(),
		},
	);

	const firstHandle = await factory({
		agentWorkspaceDir: '/zone/agents/main',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:main:discord:channel:123',
		sessionKey: 'agent:main:discord:channel:123',
		workspaceDir: '/zone/agents/main',
	});
	const secondHandle = await factory({
		agentWorkspaceDir: '/zone/agents/main',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:main:discord:channel:999',
		sessionKey: 'agent:main:discord:channel:999',
		workspaceDir: '/zone/agents/main',
	});

	expect(firstHandle).not.toBe(secondHandle);
	expect(requestLease).toHaveBeenCalledTimes(2);
	expect(renewLease).toHaveBeenCalledWith('01890f00-0000-7000-8000-000000000001');
});
```

- [ ] **Step 8: Update same-agent scope permutation test**

In `sandbox-backend-factory.test.ts`, keep a test where first and second calls have different `scopeKey`, but assert the controller request does not include scope:

```ts
expect(requestLease).toHaveBeenCalledWith({
	agentId: 'beta',
	agentWorkspaceDir: '/zone/agents/beta',
	profileId: 'standard',
	sessionKey: 'agent:beta:discord:channel:123',
	workMountDir: '/zone/agents/beta',
	zoneId: 'shravan',
});
```

- [ ] **Step 9: Run plugin tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts
```

Expected: PASS after fixture updates remove `scopeKey` from controller request/response bodies.

- [ ] **Step 10: Commit**

```bash
git add packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts
git commit -m "feat: refresh agent vm plugin leases by agent"
```

---

### Task 6: Workspace Mapping And Subagent Permutations

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`

- [ ] **Step 1: Add controller negative test for `/workspace` as request input**

In `controller-http-routes.test.ts`, add:

```ts
it('rejects Tool VM guest /workspace when it leaks back as lease request input', async () => {
	const createLease = vi.fn(async () => createLeaseStub('01890f00-0000-7000-8000-000000000000', 0));
	const app = createControllerAppForTest({
		leaseManager: {
			createLease,
			listLeases: vi.fn(() => []),
			peekLease: vi.fn(),
			releaseLease: vi.fn(async () => {}),
			renewLease: vi.fn(),
		},
	});

	const response = await app.request('/lease', {
		body: JSON.stringify({
			agentId: 'main',
			agentWorkspaceDir: '/zone/agents/main',
			profileId: 'standard',
			sessionKey: 'agent:main:manual',
			workMountDir: '/workspace',
			zoneId: 'shravan',
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});

	expect(response.status).toBe(400);
	await expect(response.json()).resolves.toMatchObject({
		kind: 'outside-allowed-roots',
	});
	expect(createLease).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Add same-agent subagent permutation test**

In `packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts`, add:

```ts
it('reuses one controller lease for same-agent subagent scopes while sending no scopeKey', async () => {
	const requestBodies: unknown[] = [];
	const leaseClient = createLeaseClient({
		controllerUrl: 'http://controller.vm.host:18800',
		fetchImpl: async (_input, init) => {
			if (init?.body) {
				requestBodies.push(JSON.parse(String(init.body)));
			}
			return new Response(
				JSON.stringify(createLeaseResponse('01890f00-0000-7000-8000-000000000000')),
				{ status: 200 },
			);
		},
	});
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			buildExecSpec: async () => ({ argv: ['ssh'], env: {}, stdinMode: 'pipe-open' }),
			createLeaseClient: () => leaseClient,
			runRemoteShellScript: vi.fn(),
		},
	);

	const firstHandle = await factory({
		agentWorkspaceDir: '/zone/agents/beta',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:discord:channel:123',
		sessionKey: 'agent:beta:discord:channel:123',
		workspaceDir: '/zone/agents/beta',
	});
	const secondHandle = await factory({
		agentWorkspaceDir: '/zone/agents/beta',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:subagent:child',
		sessionKey: 'agent:beta:subagent:child',
		workspaceDir: '/zone/agents/beta',
	});

	expect(secondHandle).toBe(firstHandle);
	expect(requestBodies).toHaveLength(1);
	expect(requestBodies[0]).toEqual({
		agentId: 'beta',
		agentWorkspaceDir: '/zone/agents/beta',
		profileId: 'standard',
		sessionKey: 'agent:beta:discord:channel:123',
		workMountDir: '/zone/agents/beta',
		zoneId: 'shravan',
	});
});
```

- [ ] **Step 3: Add cross-agent permutation test**

In `sandbox-backend-factory.test.ts`, add:

```ts
it('creates separate cached handles for different agent ids even when workspaces are shaped the same', async () => {
	const requestLease = vi
		.fn()
		.mockResolvedValueOnce(createLeaseResponse('01890f00-0000-7000-8000-000000000001', { agentId: 'beta' }))
		.mockResolvedValueOnce(createLeaseResponse('01890f00-0000-7000-8000-000000000002', { agentId: 'alpha' }));
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			buildExecSpec: vi.fn(async () => ({
				argv: ['ssh'],
				env: {},
				stdinMode: 'pipe-open' as const,
			})),
			createLeaseClient: () => ({
				...createActiveUseLeaseClientMethods(),
				renewLease: async (leaseId: string) => createLeaseResponse(leaseId),
				peekLease: async () => createLeasePeekResponse(),
				releaseLease: async () => {},
				requestLease,
			}),
			runRemoteShellScript: vi.fn(),
		},
	);

	const betaHandle = await factory({
		agentWorkspaceDir: '/zone/agents/beta',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:subagent:one',
		sessionKey: 'agent:beta:subagent:one',
		workspaceDir: '/zone/agents/beta',
	});
	const alphaHandle = await factory({
		agentWorkspaceDir: '/zone/agents/alpha',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:alpha:subagent:one',
		sessionKey: 'agent:alpha:subagent:one',
		workspaceDir: '/zone/agents/alpha',
	});

	expect(alphaHandle).not.toBe(betaHandle);
	expect(requestLease).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 4: Run workspace permutation tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts
git commit -m "test: prove agent scoped subagent lease permutations"
```

---

### Task 7: Single Lease TTL Policy Without Scope

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/lease-idle-policy.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-idle-policy.test.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `docs/reference/configuration/system-json.md`

- [ ] **Step 1: Write failing default TTL test**

Replace scope-prefix tests in `lease-idle-policy.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';

import {
	defaultToolVmLeaseIdleTtlMs,
	resolveToolVmLeaseIdleTtlMs,
	type ToolVmLeaseIdleTtlPolicy,
} from './lease-idle-policy.js';

describe('Tool VM lease idle policy', () => {
	it('uses the single default lease TTL when no request override is provided', () => {
		const policy = {
			defaultMs: defaultToolVmLeaseIdleTtlMs,
			maxRequestedMs: 24 * 60 * 60 * 1000,
			minRequestedMs: 1_000,
		} satisfies ToolVmLeaseIdleTtlPolicy;

		expect(resolveToolVmLeaseIdleTtlMs({ policy })).toEqual({
			kind: 'ok',
			value: 100 * 60 * 1000,
		});
	});

	it('accepts requested TTL inside configured bounds', () => {
		const policy = {
			defaultMs: defaultToolVmLeaseIdleTtlMs,
			maxRequestedMs: 24 * 60 * 60 * 1000,
			minRequestedMs: 1_000,
		} satisfies ToolVmLeaseIdleTtlPolicy;

		expect(resolveToolVmLeaseIdleTtlMs({ policy, requestedIdleTtlMs: 5_000 })).toEqual({
			kind: 'ok',
			value: 5_000,
		});
	});
});
```

- [ ] **Step 2: Run TTL tests to verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-idle-policy.test.ts
```

Expected: FAIL because current policy is scope-key based.

- [ ] **Step 3: Replace TTL policy implementation**

Replace `packages/agent-vm/src/controller/leases/lease-idle-policy.ts` with:

```ts
export const defaultToolVmLeaseIdleTtlMs = 100 * 60 * 1000;

export interface ToolVmLeaseIdleTtlPolicy {
	readonly defaultMs: number;
	readonly maxRequestedMs: number;
	readonly minRequestedMs: number;
}

export type ResolveToolVmLeaseIdleTtlResult =
	| { readonly kind: 'ok'; readonly value: number }
	| { readonly kind: 'invalid'; readonly message: string };

export function resolveToolVmLeaseIdleTtlMs(options: {
	readonly policy: ToolVmLeaseIdleTtlPolicy;
	readonly requestedIdleTtlMs?: number;
}): ResolveToolVmLeaseIdleTtlResult {
	if (options.requestedIdleTtlMs === undefined) {
		return { kind: 'ok', value: options.policy.defaultMs };
	}
	if (options.requestedIdleTtlMs < options.policy.minRequestedMs) {
		return {
			kind: 'invalid',
			message: `Requested idleTtlMs must be at least ${String(options.policy.minRequestedMs)}ms.`,
		};
	}
	if (options.requestedIdleTtlMs > options.policy.maxRequestedMs) {
		return {
			kind: 'invalid',
			message: `Requested idleTtlMs must be at most ${String(options.policy.maxRequestedMs)}ms.`,
		};
	}
	return { kind: 'ok', value: options.requestedIdleTtlMs };
}
```

- [ ] **Step 4: Update runtime and route imports**

Replace imports of `ttlForLeaseScope` and `LeaseIdleTtlPolicy` with:

```ts
import {
	defaultToolVmLeaseIdleTtlMs,
	resolveToolVmLeaseIdleTtlMs,
	type ToolVmLeaseIdleTtlPolicy,
} from '../leases/lease-idle-policy.js';
```

Use relative path `./leases/lease-idle-policy.js` in `controller-runtime.ts`.

- [ ] **Step 5: Update default policies**

Use:

```ts
const defaultLeaseIdleTtlPolicy = {
	defaultMs: defaultToolVmLeaseIdleTtlMs,
	maxRequestedMs: 24 * 60 * 60 * 1000,
	minRequestedMs: 1_000,
} satisfies ToolVmLeaseIdleTtlPolicy;
```

In route TTL resolution, replace `resolveEffectiveIdleTtlMs` with direct use of `resolveToolVmLeaseIdleTtlMs`.

- [ ] **Step 6: Update system config schema**

In `packages/agent-vm/src/config/system-config.ts`, change lease idle TTL schema to remove `byScopeKind` and `byScopePrefix`. The schema shape must be:

```ts
leaseIdleTtl: z
	.object({
		defaultMs: z.number().int().positive().optional(),
		maxRequestedMs: z.number().int().positive().optional(),
		minRequestedMs: z.number().int().positive().optional(),
	})
	.strict()
	.optional(),
```

When materializing defaults, use:

```ts
leaseIdleTtl: {
	defaultMs: raw.leaseIdleTtl?.defaultMs ?? defaultToolVmLeaseIdleTtlMs,
	maxRequestedMs: raw.leaseIdleTtl?.maxRequestedMs ?? 24 * 60 * 60 * 1000,
	minRequestedMs: raw.leaseIdleTtl?.minRequestedMs ?? 1_000,
},
```

- [ ] **Step 7: Run TTL/config tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-idle-policy.test.ts packages/agent-vm/src/config/system-config.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: PASS after updating config fixtures to remove scope TTL entries.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-vm/src/controller/leases/lease-idle-policy.ts packages/agent-vm/src/controller/leases/lease-idle-policy.test.ts packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/http/controller-http-routes.ts packages/agent-vm/src/config/system-config.ts packages/agent-vm/src/config/system-config.test.ts docs/reference/configuration/system-json.md
git commit -m "feat: use one tool vm lease ttl policy"
```

---

### Task 8: Dead Idle Lease Reaping And Operation Guard Semantics

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.test.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts`
- Modify: `packages/gateway-interface/src/tool-vm-active-use.ts`
- Modify: `packages/gateway-interface/src/tool-vm-active-use.test.ts`

- [ ] **Step 1: Add lease manager dead idle reaper test**

In `lease-manager.test.ts`, add:

```ts
it('reaps dead idle leases without treating active-use heartbeat as liveness', async () => {
	const closeMock = vi.fn(async () => {});
	const leaseManager = createLeaseManager({
		...defaultRuntimeRecordOptions,
		createLeaseId: () => '01890f00-0000-7000-8000-000000000003',
		createManagedVm: vi.fn(async () => ({
			...createManagedVmStub(),
			close: closeMock,
			exec: vi.fn(() => createFakeExecProcess({ exitCode: 1, stdout: '', stderr: 'dead' })),
		})),
		now: () => 1_000,
		tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
	});
	const lease = await leaseManager.createLease(createAgentLeaseOptions());

	await leaseManager.reapDeadIdleLeases();

	expect(closeMock).toHaveBeenCalledOnce();
	expect(leaseManager.peekLease(lease.id)).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-manager.test.ts -t "reaps dead idle leases"
```

Expected: FAIL because `reapDeadIdleLeases` does not exist.

- [ ] **Step 3: Add LeaseManager method**

Add to `LeaseManager` interface:

```ts
reapDeadIdleLeases(): Promise<void>;
```

Implement:

```ts
async reapDeadIdleLeases(): Promise<void> {
	const deadLeases: Lease[] = [];
	for (const lease of leases.values()) {
		if (this.getActiveUseCount(lease.id) > 0) {
			continue;
		}
		if (!(await isLeaseVmLive(lease))) {
			deadLeases.push(lease);
		}
	}
	for (const lease of deadLeases) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- evictions mutate TCP pool and lease indexes
		await evictLease(lease);
	}
}
```

If `this.getActiveUseCount` is not available inside the returned object literal, extract a local helper:

```ts
function activeUseCountForLease(leaseId: string): number {
	let count = 0;
	for (const activeUse of activeUses.values()) {
		if (activeUse.leaseId === leaseId) {
			count += 1;
		}
	}
	return count;
}
```

Use `activeUseCountForLease` in both `getActiveUseCount` and `reapDeadIdleLeases`.

- [ ] **Step 4: Call dead reaper in controller runtime**

In `controller-runtime.ts`, update:

```ts
const reapToolVmLeases = async (): Promise<void> => {
	leaseManager.reapExpiredActiveUses();
	await leaseManager.reapDeadIdleLeases();
	await idleReaper.reapExpiredLeases();
};
```

- [ ] **Step 5: Document operation guard semantics in active-use tests**

In `packages/gateway-interface/src/tool-vm-active-use.test.ts`, add:

```ts
it('continues retrying heartbeat failures because active-use is an operation guard, not a VM health check', async () => {
	const timers: (() => void)[] = [];
	const heartbeatActiveUse = vi.fn(async () => {
		throw new Error('controller temporarily unavailable');
	});
	const handle = await createToolVmActiveUseHandle({
		endActiveUse: vi.fn(async () => {}),
		heartbeatActiveUse,
		startActiveUse: vi.fn(async () => ({
			expiresAt: 10_000,
			heartbeatAfterMs: 1_000,
			useId: '01890f00-0000-7000-8000-000000000000',
		})),
		setTimeoutImpl: ((callback: () => void) => {
			timers.push(callback);
			return timers.length as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout,
		clearTimeoutImpl: vi.fn() as unknown as typeof clearTimeout,
	});

	timers[0]?.();
	await Promise.resolve();

	expect(heartbeatActiveUse).toHaveBeenCalledOnce();
	await handle.dispose('completed');
});
```

- [ ] **Step 6: Run active-use/runtime tests**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/tool-vm-active-use.test.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts packages/agent-vm/src/controller/controller-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway-interface/src/tool-vm-active-use.ts packages/gateway-interface/src/tool-vm-active-use.test.ts packages/agent-vm/src/controller/leases/lease-manager.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime.test.ts
git commit -m "feat: reap dead idle tool vm leases"
```

---

### Task 8A: Plugin SSH Operation Guard And Failure Reporting

**Files:**
- Modify: `packages/gateway-interface/src/tool-vm-active-use.ts`
- Modify: `packages/gateway-interface/src/tool-vm-active-use.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-request-schemas.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.test.ts`
- Create: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.ts`
- Create: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`

**Design intent:**

This task does not make active-use heartbeat a VM liveness proof. It adds a plugin-observed SSH operation report path:

```text
plugin observes SSH probe/command/finalize result
plugin sends bounded latest report to controller
plugin marks cached handle stale on SSH failure/timeout
controller stores diagnostic latest report and owns eviction/renewal truth
```

If the plugin can run `true` in the Tool VM over SSH and receive a clean exit, the SSH path succeeded at that time. That success is enough to reuse the cached handle for the next operation; it is not a promise that every future command will finish.

- [ ] **Step 1: Write failing active-use report and jitter tests**

In `packages/gateway-interface/src/tool-vm-active-use.test.ts`, add:

```ts
it('sends only the latest active-use operation report on heartbeat', async () => {
	const timers: (() => void)[] = [];
	const heartbeatActiveUse = vi.fn(async () => ({
		expiresAt: 10_000,
		heartbeatAfterMs: 1_000,
	}));
	const handle = await createToolVmActiveUseHandle({
		clearTimeoutImpl: vi.fn() as unknown as typeof clearTimeout,
		endActiveUse: vi.fn(async () => {}),
		heartbeatActiveUse,
		setTimeoutImpl: ((callback: () => void) => {
			timers.push(callback);
			return timers.length as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout,
		startActiveUse: vi.fn(async () => ({
			expiresAt: 10_000,
			heartbeatAfterMs: 1_000,
			useId: '01890f00-0000-7000-8000-000000000000',
		})),
	});

	handle.report({
		observedAtMs: 1_000,
		phase: 'starting',
	});
	handle.report({
		observedAtMs: 1_001,
		phase: 'probe-succeeded',
		ssh: { probeSucceeded: true },
	});

	timers[0]?.();
	await Promise.resolve();

	expect(heartbeatActiveUse).toHaveBeenCalledWith('01890f00-0000-7000-8000-000000000000', {
		report: {
			observedAtMs: 1_001,
			phase: 'probe-succeeded',
			ssh: { probeSucceeded: true },
		},
	});
	await handle.dispose('completed');
});

it('applies deterministic heartbeat jitter and clears timers on dispose', async () => {
	const clearTimeoutImpl = vi.fn() as unknown as typeof clearTimeout;
	const setTimeoutImpl = vi.fn((callback: () => void, delayMs?: number) => {
		void callback;
		void delayMs;
		return 42 as unknown as ReturnType<typeof setTimeout>;
	}) as unknown as typeof setTimeout;
	const handle = await createToolVmActiveUseHandle({
		clearTimeoutImpl,
		endActiveUse: vi.fn(async () => {}),
		heartbeatActiveUse: vi.fn(async () => ({ expiresAt: 10_000, heartbeatAfterMs: 1_000 })),
		heartbeatJitterRatio: 0.2,
		randomImpl: () => 1,
		setTimeoutImpl,
		startActiveUse: vi.fn(async () => ({
			expiresAt: 10_000,
			heartbeatAfterMs: 1_000,
			useId: '01890f00-0000-7000-8000-000000000000',
		})),
	});

	expect(setTimeoutImpl).toHaveBeenCalledWith(expect.any(Function), 1_200);

	await handle.dispose('completed');

	expect(clearTimeoutImpl).toHaveBeenCalledWith(42);
});

it('stops heartbeat scheduling after a refreshable heartbeat failure', async () => {
	const timers: (() => void)[] = [];
	const clearTimeoutImpl = vi.fn() as unknown as typeof clearTimeout;
	const refreshableError = new Error('lease expired');
	const onRefreshableHeartbeatFailure = vi.fn(async () => {});
	const handle = await createToolVmActiveUseHandle({
		clearTimeoutImpl,
		endActiveUse: vi.fn(async () => {}),
		heartbeatActiveUse: vi.fn(async () => {
			throw refreshableError;
		}),
		isHeartbeatErrorRefreshable: () => true,
		onRefreshableHeartbeatFailure,
		setTimeoutImpl: ((callback: () => void) => {
			timers.push(callback);
			return timers.length as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout,
		startActiveUse: vi.fn(async () => ({
			expiresAt: 10_000,
			heartbeatAfterMs: 1_000,
			useId: '01890f00-0000-7000-8000-000000000000',
		})),
	});

	timers[0]?.();
	await Promise.resolve();
	await Promise.resolve();

	expect(onRefreshableHeartbeatFailure).toHaveBeenCalledWith(refreshableError);
	expect(timers).toHaveLength(1);

	await handle.dispose('failed');
});
```

- [ ] **Step 2: Run active-use tests to verify failure**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/tool-vm-active-use.test.ts -t "operation report|jitter"
```

Expected: FAIL because the handle has no `report` method, heartbeat request has no body, and jitter options do not exist.

- [ ] **Step 3: Add typed operation reports to active-use**

In `packages/gateway-interface/src/tool-vm-active-use.ts`, add:

```ts
export type ToolVmSshOperationPhase =
	| 'starting'
	| 'probe-succeeded'
	| 'running'
	| 'completed'
	| 'failed';

export type ToolVmSshFailureKind =
	| 'active-use-refreshable-failure'
	| 'ssh-command-failed'
	| 'ssh-command-timed-out'
	| 'ssh-probe-failed'
	| 'unknown';

export interface ToolVmSshFailureReport {
	readonly kind: ToolVmSshFailureKind;
	readonly message: string;
}

export interface ToolVmSshOperationReport {
	readonly failure?: ToolVmSshFailureReport;
	readonly probeSucceeded?: boolean;
}

export interface ToolVmActiveUseOperationReport {
	readonly observedAtMs: number;
	readonly phase: ToolVmSshOperationPhase;
	readonly ssh?: ToolVmSshOperationReport;
}

export interface HeartbeatToolVmActiveUseRequest {
	readonly report?: ToolVmActiveUseOperationReport;
}
```

Update request types:

```ts
export interface StartToolVmActiveUseRequest {
	readonly correlation?: ToolVmActiveUseCorrelation;
	readonly report?: ToolVmActiveUseOperationReport;
	readonly useId: string;
}

export interface EndToolVmActiveUseRequest {
	readonly outcome: ToolVmActiveUseOutcome;
	readonly report?: ToolVmActiveUseOperationReport;
}
```

Update handle/options:

```ts
export interface ToolVmActiveUseHandle {
	readonly useId: string;
	dispose(outcome?: ToolVmActiveUseOutcome): Promise<void>;
	end(outcome?: ToolVmActiveUseOutcome): Promise<void>;
	report(report: ToolVmActiveUseOperationReport): void;
}

export interface CreateToolVmActiveUseHandleOptions {
	readonly correlation?: ToolVmActiveUseCorrelation;
	readonly endActiveUse: (useId: string, request: EndToolVmActiveUseRequest) => Promise<void>;
	readonly heartbeatActiveUse: (
		useId: string,
		request: HeartbeatToolVmActiveUseRequest,
	) => Promise<HeartbeatToolVmActiveUseResponse>;
	readonly heartbeatJitterRatio?: number;
	readonly isEndErrorTolerable?: (error: unknown) => boolean;
	readonly isHeartbeatErrorRefreshable?: (error: unknown) => boolean;
	readonly logEndFailure?: (error: unknown) => void;
	readonly logHeartbeatFailure?: (error: unknown) => void;
	readonly maxHeartbeatDurationMs?: number;
	readonly nowImpl?: () => number;
	readonly onRefreshableHeartbeatFailure?: (error: unknown) => Promise<void>;
	readonly randomImpl?: () => number;
	readonly startActiveUse: (
		request: StartToolVmActiveUseRequest,
	) => Promise<StartToolVmActiveUseResponse>;
	readonly setTimeoutImpl?: typeof setTimeout;
	readonly clearTimeoutImpl?: typeof clearTimeout;
}
```

Add deterministic jitter:

```ts
function jitterDelayMs(params: {
	readonly delayMs: number;
	readonly jitterRatio: number;
	readonly random: () => number;
}): number {
	if (params.jitterRatio <= 0) {
		return params.delayMs;
	}
	const spreadMs = params.delayMs * params.jitterRatio;
	const minMs = params.delayMs - spreadMs;
	const jitteredMs = minMs + params.random() * spreadMs * 2;
	return Math.max(1, Math.round(jitteredMs));
}
```

Inside `createToolVmActiveUseHandle`, keep only the latest report:

```ts
const heartbeatJitterRatio = options.heartbeatJitterRatio ?? 0.1;
const random = options.randomImpl ?? Math.random;
let latestReport: ToolVmActiveUseOperationReport | undefined;

const heartbeatRequest = (): HeartbeatToolVmActiveUseRequest =>
	latestReport === undefined ? {} : { report: latestReport };
```

Send report on heartbeat:

```ts
void options
	.heartbeatActiveUse(startedUse.useId, heartbeatRequest())
```

Update heartbeat failure handling so refreshable failures can stop the handle and mark it stale:

```ts
.catch((error: unknown) => {
	options.logHeartbeatFailure?.(error);
	if (
		options.isHeartbeatErrorRefreshable?.(error) === true &&
		options.onRefreshableHeartbeatFailure
	) {
		ended = true;
		clearHeartbeatTimer();
		void options.onRefreshableHeartbeatFailure(error).catch((staleError: unknown) => {
			options.logHeartbeatFailure?.(staleError);
		});
		return;
	}
	if (!ended) {
		scheduleHeartbeat(startedUse.heartbeatAfterMs);
	}
});
```

When constructing the handle in the plugin, pass `isHeartbeatErrorRefreshable: isRefreshableLeaseError`. Transient controller/network errors keep retrying. Do not call `onRefreshableHeartbeatFailure` for generic network blips.

Change the existing `setTimeoutImpl` delay argument from `delayMs` to:

```ts
jitterDelayMs({ delayMs, jitterRatio: heartbeatJitterRatio, random })
```

Send final report on dispose:

```ts
await options.endActiveUse(startedUse.useId, {
	outcome,
	...(latestReport === undefined ? {} : { report: latestReport }),
});
```

Return:

```ts
return {
	useId: startedUse.useId,
	dispose: end,
	end,
	report: (report): void => {
		latestReport = report;
	},
};
```

- [ ] **Step 4: Update controller client heartbeat request body**

In `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`, import `HeartbeatToolVmActiveUseRequest` and change the client interface:

```ts
heartbeatActiveUse(
	leaseId: string,
	useId: string,
	request: HeartbeatToolVmActiveUseRequest,
): Promise<HeartbeatToolVmActiveUseResponse>;
```

Change fetch construction:

```ts
const response = await fetchImpl(
	`${baseUrl}/lease/${encodeURIComponent(leaseId)}/uses/${encodeURIComponent(useId)}/heartbeat`,
	{
		body: JSON.stringify(request),
		headers: {
			'content-type': 'application/json',
		},
		method: 'POST',
	},
);
```

Add a client test in `controller-lease-client.test.ts`:

```ts
it('sends active-use heartbeat operation reports to the controller', async () => {
	const requests: { readonly init?: RequestInit }[] = [];
	const client = createLeaseClient({
		controllerUrl: 'http://controller.vm.host:18800',
		fetchImpl: async (_input, init) => {
			requests.push({ init });
			return new Response(JSON.stringify({ expiresAt: 10_000, heartbeatAfterMs: 1_000 }), {
				status: 200,
			});
		},
	});

	await client.heartbeatActiveUse('01890f00-0000-7000-8000-000000000000', 'use-1', {
		report: {
			observedAtMs: 1_000,
			phase: 'failed',
			ssh: {
				failure: {
					kind: 'ssh-command-timed-out',
					message: 'SSH command exceeded 30000ms.',
				},
			},
		},
	});

	expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
		report: {
			observedAtMs: 1_000,
			phase: 'failed',
			ssh: {
				failure: {
					kind: 'ssh-command-timed-out',
					message: 'SSH command exceeded 30000ms.',
				},
			},
		},
	});
});
```

- [ ] **Step 5: Add Zod schemas and store latest report in controller**

In `controller-request-schemas.ts`, add:

```ts
export const controllerToolVmSshFailureKindSchema = z.enum([
	'active-use-refreshable-failure',
	'ssh-command-failed',
	'ssh-command-timed-out',
	'ssh-probe-failed',
	'unknown',
]);

export const controllerToolVmActiveUseOperationReportSchema = z.strictObject({
	observedAtMs: z.number().int().nonnegative(),
	phase: z.enum(['starting', 'probe-succeeded', 'running', 'completed', 'failed']),
	ssh: z
		.strictObject({
			failure: z
				.strictObject({
					kind: controllerToolVmSshFailureKindSchema,
					message: z.string().trim().min(1).max(500),
				})
				.optional(),
			probeSucceeded: z.boolean().optional(),
		})
		.optional(),
});

export const controllerHeartbeatToolVmActiveUseRequestSchema = z.strictObject({
	report: controllerToolVmActiveUseOperationReportSchema.optional(),
});
```

In `lease-manager.ts`, add the report to the active-use record type:

```ts
interface ToolVmActiveUse {
	readonly correlation?: ToolVmActiveUseCorrelation;
	readonly expiresAt: number;
	readonly latestReport?: ToolVmActiveUseOperationReport;
	readonly leaseId: string;
	readonly startedAt: number;
	readonly useId: string;
}
```

Update `startActiveUse`, `heartbeatActiveUse`, and `endActiveUse` signatures to accept request bodies with optional reports. `heartbeatActiveUse` must replace the latest report, not append:

```ts
const updatedUse = {
	...activeUse,
	...(request.report === undefined ? {} : { latestReport: request.report }),
	expiresAt: now + toolVmUsePolicy.heartbeatStaleMs,
};
```

Add `lease-manager.test.ts`:

```ts
it('replaces active-use operation reports instead of accumulating report history', async () => {
	const leaseManager = createLeaseManager({
		...defaultRuntimeRecordOptions,
		createLeaseId: () => '01890f00-0000-7000-8000-000000000004',
		createManagedVm: vi.fn(async () => createManagedVmStub()),
		now: () => 1_000,
		tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
	});
	const lease = await leaseManager.createLease(createAgentLeaseOptions());
	leaseManager.startActiveUse(lease.id, {
		report: { observedAtMs: 1_000, phase: 'starting' },
		useId: '01890f00-0000-7000-8000-000000000000',
	});

	leaseManager.heartbeatActiveUse(lease.id, '01890f00-0000-7000-8000-000000000000', {
		report: {
			observedAtMs: 1_001,
			phase: 'failed',
			ssh: {
				failure: {
					kind: 'ssh-command-timed-out',
					message: 'SSH command exceeded 30000ms.',
				},
			},
		},
	});

	expect(leaseManager.getActiveUses(lease.id)).toEqual([
		expect.objectContaining({
			latestReport: {
				observedAtMs: 1_001,
				phase: 'failed',
				ssh: {
					failure: {
						kind: 'ssh-command-timed-out',
						message: 'SSH command exceeded 30000ms.',
					},
				},
			},
		}),
	]);
});
```

- [ ] **Step 6: Update active-use routes to parse request bodies**

In `controller-http-routes.ts`, parse heartbeat body with the new schema. Empty body should behave as `{}`:

```ts
const heartbeatPayload = await parseOptionalJsonBody(
	context,
	controllerHeartbeatToolVmActiveUseRequestSchema,
	{},
);
if (!heartbeatPayload.ok) {
	return heartbeatPayload.response;
}
const heartbeat = options.leaseManager.heartbeatActiveUse(
	context.req.param('leaseId'),
	context.req.param('useId'),
	heartbeatPayload.value,
);
```

Add this route-local helper if the file does not already have an equivalent. Keep the helper generic and do not use `any`:

```ts
import type { Context as ControllerRouteContext } from 'hono';

interface ParsedOptionalJsonBody<TValue> {
	readonly ok: true;
	readonly value: TValue;
}

interface FailedOptionalJsonBody {
	readonly ok: false;
	readonly response: Response;
}

async function parseOptionalJsonBody<TValue>(
	context: ControllerRouteContext,
	schema: {
		safeParse(value: unknown):
			| { readonly success: true; readonly data: TValue }
			| { readonly success: false; readonly error: { readonly issues: unknown } };
	},
	emptyValue: TValue,
): Promise<ParsedOptionalJsonBody<TValue> | FailedOptionalJsonBody> {
	const bodyText = await context.req.text();
	if (bodyText.trim() === '') {
		return { ok: true, value: emptyValue };
	}
	let parsedBody: unknown;
	try {
		parsedBody = JSON.parse(bodyText);
	} catch {
		return {
			ok: false,
			response: context.json({ error: 'Invalid JSON body' }, 400),
		};
	}
	const parsedPayload = schema.safeParse(parsedBody);
	if (!parsedPayload.success) {
		return {
			ok: false,
			response: context.json(
				{ error: 'Invalid request body', issues: parsedPayload.error.issues },
				400,
			),
		};
	}
	return { ok: true, value: parsedPayload.data };
}
```

If the existing route context type has a different local name, use that concrete local type. Do not fall back to `any`.

In `controller-http-routes.test.ts`, add:

```ts
it('accepts bounded active-use heartbeat operation reports', async () => {
	const heartbeatActiveUse = vi.fn(() => ({
		expiresAt: 10_000,
		heartbeatAfterMs: 1_000,
	}));
	const app = createControllerAppForTest({
		leaseManager: {
			createLease: vi.fn(),
			endActiveUse: vi.fn(),
			getActiveUseCount: vi.fn(() => 1),
			heartbeatActiveUse,
			listLeases: vi.fn(() => []),
			peekLease: vi.fn(),
			releaseLease: vi.fn(async () => {}),
			renewLease: vi.fn(),
			startActiveUse: vi.fn(),
		},
	});

	const response = await app.request(
		'/lease/01890f00-0000-7000-8000-000000000000/uses/01890f00-0000-7000-8000-000000000001/heartbeat',
		{
			body: JSON.stringify({
				report: {
					observedAtMs: 1_000,
					phase: 'failed',
					ssh: {
						failure: {
							kind: 'ssh-command-timed-out',
							message: 'runShellCommand exceeded 30000ms.',
						},
					},
				},
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		},
	);

	expect(response.status).toBe(200);
	expect(heartbeatActiveUse).toHaveBeenCalledWith(
		'01890f00-0000-7000-8000-000000000000',
		'01890f00-0000-7000-8000-000000000001',
		{
			report: {
				observedAtMs: 1_000,
				phase: 'failed',
				ssh: {
					failure: {
						kind: 'ssh-command-timed-out',
						message: 'runShellCommand exceeded 30000ms.',
					},
				},
			},
		},
	);
});
```

- [ ] **Step 7: Write failing SSH operation guard unit tests**

Create `packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import {
	ToolVmSshOperationStaleError,
	runToolVmSshOperationWithGuard,
} from './tool-vm-ssh-operation-guard.js';

describe('runToolVmSshOperationWithGuard', () => {
	it('reports probe success and returns operation result', async () => {
		const report = vi.fn();

		await expect(
			runToolVmSshOperationWithGuard({
				now: () => 1_000,
				operation: async () => 'ok',
				operationName: 'probe',
				report,
				timeoutMs: 30_000,
			}),
		).resolves.toBe('ok');

		expect(report).toHaveBeenCalledWith({
			observedAtMs: 1_000,
			phase: 'running',
		});
		expect(report).toHaveBeenCalledWith({
			observedAtMs: 1_000,
			phase: 'completed',
			ssh: { probeSucceeded: true },
		});
	});

	it('converts timeout into a stale-handle error and reports failure', async () => {
		const clearTimeoutImpl = vi.fn() as unknown as typeof clearTimeout;
		const setTimeoutImpl = ((callback: () => void) => {
			callback();
			return 1 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		const report = vi.fn();

		await expect(
			runToolVmSshOperationWithGuard({
				clearTimeoutImpl,
				now: () => 1_000,
				operation: async () => new Promise<string>(() => {}),
				operationName: 'runShellCommand',
				report,
				setTimeoutImpl,
				timeoutMs: 30_000,
			}),
		).rejects.toMatchObject({
			reason: 'ssh-command-timed-out',
		});

		expect(report).toHaveBeenCalledWith({
			observedAtMs: 1_000,
			phase: 'failed',
			ssh: {
				failure: {
					kind: 'ssh-command-timed-out',
					message: 'runShellCommand exceeded 30000ms.',
				},
			},
		});
		expect(clearTimeoutImpl).toHaveBeenCalled();
	});

	it('classifies rejected SSH operations as stale-handle failures', async () => {
		await expect(
			runToolVmSshOperationWithGuard({
				now: () => 1_000,
				operation: async () => {
					throw new Error('kex reset');
				},
				operationName: 'fs-bridge',
				report: vi.fn(),
				timeoutMs: 30_000,
			}),
		).rejects.toBeInstanceOf(ToolVmSshOperationStaleError);
	});
});
```

- [ ] **Step 8: Implement SSH operation guard**

Create `packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.ts`:

```ts
import type {
	ToolVmActiveUseOperationReport,
	ToolVmSshFailureKind,
} from '@agent-vm/gateway-interface';

export class ToolVmSshOperationStaleError extends Error {
	readonly cause: unknown;
	readonly reason: ToolVmSshFailureKind;

	constructor(options: {
		readonly cause: unknown;
		readonly message: string;
		readonly reason: ToolVmSshFailureKind;
	}) {
		super(options.message);
		this.cause = options.cause;
		this.reason = options.reason;
	}
}

export interface ToolVmSshOperationGuardOptions<TResult> {
	readonly clearTimeoutImpl?: typeof clearTimeout;
	readonly now?: () => number;
	readonly operation: (signal: AbortSignal) => Promise<TResult>;
	readonly operationName: string;
	readonly report: (report: ToolVmActiveUseOperationReport) => void;
	readonly setTimeoutImpl?: typeof setTimeout;
	readonly timeoutMs: number;
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runToolVmSshOperationWithGuard<TResult>(
	options: ToolVmSshOperationGuardOptions<TResult>,
): Promise<TResult> {
	const now = options.now ?? Date.now;
	const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
	const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
	const abortController = new AbortController();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	options.report({
		observedAtMs: now(),
		phase: 'running',
	});

	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeoutHandle = setTimeoutImpl(() => {
			abortController.abort();
			reject(
				new ToolVmSshOperationStaleError({
					cause: undefined,
					message: `${options.operationName} exceeded ${String(options.timeoutMs)}ms.`,
					reason: 'ssh-command-timed-out',
				}),
			);
		}, options.timeoutMs);
	});

	try {
		const result = await Promise.race([options.operation(abortController.signal), timeoutPromise]);
		options.report({
			observedAtMs: now(),
			phase: 'completed',
			ssh: { probeSucceeded: true },
		});
		return result;
	} catch (error) {
		const staleError =
			error instanceof ToolVmSshOperationStaleError
				? error
				: new ToolVmSshOperationStaleError({
						cause: error,
						message: formatUnknownError(error),
						reason: 'ssh-command-failed',
					});
		options.report({
			observedAtMs: now(),
			phase: 'failed',
			ssh: {
				failure: {
					kind: staleError.reason,
					message: staleError.message,
				},
			},
		});
		throw staleError;
	} finally {
		if (timeoutHandle !== undefined) {
			clearTimeoutImpl(timeoutHandle);
		}
	}
}
```

- [ ] **Step 9: Wire plugin stale-handle invalidation**

In `sandbox-backend-handle-factory.ts`, add a stale callback to `createSandboxBackendHandle`:

```ts
const markCachedLeaseStale = async (reason: string, error: unknown): Promise<void> => {
	scopeCache.delete(cacheKey);
	writeSandboxBackendLog(
		`lease marked stale for zone '${options.zoneId}' agent '${agentId}' lease '${lease.leaseId}' reason '${reason}': ${formatUnknownError(error)}`,
	);
	await leaseClient.releaseLease(lease.leaseId, { force: true }).catch((releaseError: unknown) => {
		writeSandboxBackendLog(
			`best-effort stale lease release failed for zone '${options.zoneId}' agent '${agentId}' lease '${lease.leaseId}': ${formatUnknownError(releaseError)}`,
		);
	});
};
```

Pass it into the handle:

```ts
const handle = createSandboxBackendHandle({
	buildExecSpec: dependencies.buildExecSpec,
	cfg: params.cfg,
	controllerUrl: options.controllerUrl,
	createFsBridgeBuilder: dependencies.createFsBridgeBuilder,
	lease,
	leaseClient,
	markCachedLeaseStale,
	runRemoteShellScript: dependencies.runRemoteShellScript,
	sessionKey: params.sessionKey,
	zoneId: options.zoneId,
});
```

Before returning a cached handle after `renewLease` succeeds, run a short plugin-side SSH probe:

```ts
await dependencies.runRemoteShellScript({
	allowFailure: false,
	script: 'true',
	ssh: cachedEntry.lease.ssh,
});
```

If the probe fails, delete the cache entry, best-effort release the old lease with `force: true`, and create a fresh lease. This probe proves only “SSH worked at this point in time.” It is not a future command guarantee. The probe must be wrapped in `runToolVmSshOperationWithGuard` and pass its `AbortSignal` into `runRemoteShellScript`, because the no-leak property depends on aborting the underlying SSH request when the timeout fires.

Wrap `runShellCommand` and fs-bridge `runRemoteShellScript` with `runToolVmSshOperationWithGuard`. On `ToolVmSshOperationStaleError`, call `markCachedLeaseStale(error.reason, error)` before rethrowing. In `finalizeExec`, if `finalizeParams.timedOut === true` or `finalizeParams.status === 'failed'`, call:

```ts
await markCachedLeaseStale(
	finalizeParams.timedOut ? 'ssh-command-timed-out' : 'ssh-command-failed',
	undefined,
);
```

after ending active-use.

Also wire active-use refreshable failures to the same stale path. Add:

```ts
function isRefreshableLeaseError(error: unknown): boolean {
	return error instanceof ControllerLeaseRequestError && (error.status === 404 || error.status === 410);
}
```

Use `isRefreshableLeaseError` from both `shouldRefreshCachedLease` and active-use handling. If `startActiveUse` fails with a refreshable error, call:

```ts
await markCachedLeaseStale('active-use-refreshable-failure', error);
```

then rethrow. If a heartbeat fails with a refreshable error, `createToolVmActiveUseHandle` should call an `onRefreshableHeartbeatFailure` callback that marks the lease stale and stops scheduling further heartbeats for that handle. Transient heartbeat failures keep the existing jittered retry behavior.

- [ ] **Step 10: Add plugin cache tests for SSH stale behavior**

In `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`, add:

```ts
const createFactoryParamsForAgent = (agentId: string) => ({
	agentWorkspaceDir: `/zone/agents/${agentId}`,
	cfg: gondolinSandboxConfig(),
	scopeKey: `agent:${agentId}:discord:channel:123`,
	sessionKey: `agent:${agentId}:discord:channel:123`,
	workspaceDir: `/zone/agents/${agentId}`,
});

it('drops a cached handle when the cached SSH probe fails before reuse', async () => {
	let leaseCounter = 0;
	const requestLease = vi.fn(async () => {
		leaseCounter += 1;
		return createLeaseResponse(`01890f00-0000-7000-8000-00000000000${leaseCounter}`);
	});
	const runRemoteShellScript = vi
		.fn()
		.mockRejectedValueOnce(new Error('kex reset'))
		.mockResolvedValue({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) });
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			buildExecSpec: vi.fn(async () => ({ argv: ['ssh'], env: {}, stdinMode: 'pipe-open' })),
			createLeaseClient: () => ({
				...createActiveUseLeaseClientMethods(),
				peekLease: async () => createLeasePeekResponse(),
				releaseLease: async () => {},
				renewLease: async (leaseId: string) => createLeaseResponse(leaseId),
				requestLease,
			}),
			runRemoteShellScript,
		},
	);

	const firstHandle = await factory(createFactoryParamsForAgent('beta'));
	const secondHandle = await factory(createFactoryParamsForAgent('beta'));

	expect(secondHandle).not.toBe(firstHandle);
	expect(requestLease).toHaveBeenCalledTimes(2);
});
```

Add a second test:

```ts
it('drops a cached handle after an SSH command failure inside an operation', async () => {
	const requestLease = vi
		.fn()
		.mockResolvedValueOnce(createLeaseResponse('01890f00-0000-7000-8000-000000000001'))
		.mockResolvedValueOnce(createLeaseResponse('01890f00-0000-7000-8000-000000000002'));
	const releaseLease = vi.fn(async () => {});
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			buildExecSpec: vi.fn(async () => ({ argv: ['ssh'], env: {}, stdinMode: 'pipe-open' })),
			createLeaseClient: () => ({
				...createActiveUseLeaseClientMethods(),
				peekLease: async () => createLeasePeekResponse(),
				releaseLease,
				renewLease: async (leaseId: string) => createLeaseResponse(leaseId),
				requestLease,
			}),
			runRemoteShellScript: vi.fn(async () => {
				throw new Error('ssh hung');
			}),
		},
	);

	const handle = await factory(createFactoryParamsForAgent('beta'));
	await expect(handle.runShellCommand({ script: 'pwd' })).rejects.toThrow(/ssh hung/u);
	await factory(createFactoryParamsForAgent('beta'));

	expect(releaseLease).toHaveBeenCalledWith('01890f00-0000-7000-8000-000000000001', {
		force: true,
	});
	expect(requestLease).toHaveBeenCalledTimes(2);
});
```

If the file already has an equivalent typed fixture helper, use it and delete the local `createFactoryParamsForAgent` helper from this snippet. Do not add throwaway local fixtures with loose `unknown` or `any`.

- [ ] **Step 11: Run SSH operation guard tests**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/tool-vm-active-use.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.test.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/gateway-interface/src/tool-vm-active-use.ts packages/gateway-interface/src/tool-vm-active-use.test.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/agent-vm/src/controller/http/controller-request-schemas.ts packages/agent-vm/src/controller/http/controller-http-routes.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/agent-vm/src/controller/leases/lease-manager.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts
git commit -m "feat: invalidate tool vm leases on ssh failures"
```

---

### Task 9: Remove Scope From Seeding, Logs, Runtime Records, And Tests

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts`
- Modify: `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts`
- Modify: `packages/agent-vm/src/controller/leases/tool-vm-runtime-record.ts`
- Modify: `packages/agent-vm/src/controller/leases/tool-vm-runtime-record.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-gondolin-contract.ts`

- [ ] **Step 1: Run scopeKey production sweep**

Run:

```bash
rg -n "scopeKey" packages/agent-vm/src packages/gateway-interface/src packages/openclaw-agent-vm-plugin/src
```

Expected before this task: hits remain in tests and implementation.

- [ ] **Step 2: Remove scope from seeding result types**

In `agent-sandbox-seeding.ts`, remove `scopeKey` from every result variant and options interface. Log context should use `zoneId`, `agentId`, and `hostWorkMountDir`.

Use this options shape:

```ts
export async function seedAgentSandboxWorkspace(options: {
	readonly agentId: string;
	readonly hostWorkMountDir: string;
	readonly secretResolver: SecretResolver;
	readonly zone: SystemConfig['zones'][number];
}): Promise<AgentSandboxSeedResult> {
```

- [ ] **Step 3: Update controller route seeding call**

In `controller-http-routes.ts`, replace:

```ts
const seedResult = await seedAgentSandboxWorkspace({
	agentId,
	scopeKey,
	secretResolver: options.secretResolver,
	hostWorkMountDir: resolvedWorkMount.hostWorkMountDir,
	zone,
});
```

with:

```ts
const seedResult = await seedAgentSandboxWorkspace({
	agentId,
	secretResolver: options.secretResolver,
	hostWorkMountDir: resolvedWorkMount.hostWorkMountDir,
	zone,
});
```

- [ ] **Step 4: Remove stale openclaw contract guidance**

In `packages/openclaw-agent-vm-plugin/src/openclaw-gondolin-contract.ts`, replace:

```ts
export const OPENCLAW_GONDOLIN_LEASE_SCOPE_GUIDANCE =
	'Managed OpenClaw/Gondolin requires an explicit agentId. scopeKey is OpenClaw scope provenance and may include channel, session, thread, or subagent segments under that agent.';
```

with:

```ts
export const OPENCLAW_GONDOLIN_LEASE_SCOPE_GUIDANCE =
	'Managed OpenClaw/Gondolin leases are agent-scoped. The plugin derives agentId from sessionKey and does not send OpenClaw scopeKey to the controller.';
```

- [ ] **Step 5: Strengthen runtime record test**

In `tool-vm-runtime-record.test.ts`, keep:

```ts
expect(record).not.toHaveProperty('scopeKey');
```

Add:

```ts
expect(record).toMatchObject({
	agentId: 'beta',
	leaseId: '01890f00-0000-7000-8000-000000000000',
	recordId: '01890f00-0000-7000-8000-000000000111',
	tcpSlot: 0,
});
```

- [ ] **Step 6: Run scopeKey sweep until production clean**

Run:

```bash
rg -n "scopeKey" packages/agent-vm/src packages/gateway-interface/src -g '!*.test.ts'
```

Expected after implementation: no output.

Run:

```bash
rg -n "scopeKey" packages/openclaw-agent-vm-plugin/src -g '!*.test.ts'
```

Expected after implementation: hits are limited to the OpenClaw SDK boundary where `params.scopeKey` is accepted and discarded before controller I/O. There must be no plugin controller request body, controller response parser, cache key, or lease log that includes `scopeKey`.

Run:

```bash
rg -n "scopeKey" packages/agent-vm/src packages/gateway-interface/src packages/openclaw-agent-vm-plugin/src
```

Expected after implementation: any remaining test hits must be negative assertions or plugin-boundary fixtures proving `scopeKey` is discarded. No controller, gateway-interface lease type, runtime record, response, generated manual, or docs source should require it.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts packages/agent-vm/src/controller/leases/tool-vm-runtime-record.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts packages/agent-vm/src/controller/leases/tool-vm-runtime-record.ts packages/agent-vm/src/controller/leases/tool-vm-runtime-record.test.ts packages/agent-vm/src/controller/http/controller-http-routes.ts packages/agent-vm/src/controller/controller-runtime.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-gondolin-contract.ts
git commit -m "refactor: remove scope from tool vm lease internals"
```

---

### Task 10: Docs And Generated Manual Hard Cutover

**Files:**
- Modify: `docs/architecture/storage-model.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`
- Modify: `packages/agent-vm/src/integration-tests/manual-cli.smoke.test.ts`

- [ ] **Step 1: Write failing manual template assertions**

In `manual-templates.test.ts`, add assertions that generated runtime path/lease text contains:

```ts
expect(rendered).toContain('Tool VM leases are keyed by zone and agent.');
expect(rendered).toContain('OpenClaw scope keys are not part of the agent-vm lease contract.');
expect(rendered).toContain('/workspace is the normal Tool VM guest workdir returned by the controller.');
```

And does not contain:

```ts
expect(rendered).not.toContain('scopeKey');
expect(rendered).not.toContain('scope key');
```

- [ ] **Step 2: Run manual tests to verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: FAIL until manual text is updated.

- [ ] **Step 3: Update docs with exact contract text**

In `docs/architecture/storage-model.md`, add:

```md
### OpenClaw Tool VM Lease Identity

Managed OpenClaw/Gondolin Tool VM leases are keyed by `zoneId + agentId`.
The HTTP `leaseId` is an opaque UUIDv7 API handle. It does not encode the
zone, agent, creation time, OpenClaw scope key, channel, thread, or cwd.

OpenClaw `scopeKey` is not part of the agent-vm lease contract. The plugin
receives it from OpenClaw core as SDK context and discards it before calling
the controller.
```

In `docs/architecture/openclaw-gateway.md`, add:

```md
For managed `backend="gondolin"` leases, agent-vm supports only
`mode="all"`, `scope="agent"`, and `workspaceAccess="rw"`. Those values are
asserted in the plugin. They are not sent to the controller `/lease` API.
```

In `docs/reference/configuration/system-json.md`, replace scope TTL examples with:

```md
`leaseIdleTtl` controls the idle lifetime of OpenClaw Tool VM leases. It is
not keyed by OpenClaw scope. The default is 100 minutes.
```

- [ ] **Step 4: Update manual templates**

In `manual-templates.ts`, add concise generated text:

```text
OpenClaw Tool VM leases are keyed by zone and agent. OpenClaw scope keys
are not part of the agent-vm lease contract. /workspace is the normal Tool
VM guest workdir returned by the controller; lease requests must use
OpenClaw gateway RealFS paths such as /zone/... or the OpenClaw sandbox
state path, never /workspace.
```

- [ ] **Step 5: Run docs/manual tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts packages/agent-vm/src/integration-tests/manual-cli.smoke.test.ts
```

Expected: PASS. Smoke tests may skip if built CLI is unavailable; record the skip count in the final task summary.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/storage-model.md docs/architecture/openclaw-gateway.md docs/reference/configuration/system-json.md packages/agent-vm/src/cli/manual-templates.ts packages/agent-vm/src/cli/manual-templates.test.ts packages/agent-vm/src/integration-tests/manual-cli.smoke.test.ts
git commit -m "docs: document agent scoped tool vm leases"
```

---

### Task 11: Integration And Full Verification

**Files:**
- Modify fixtures across:
  - `packages/agent-vm/src/controller/**/*.test.ts`
  - `packages/openclaw-agent-vm-plugin/src/**/*.test.ts`
  - `packages/gateway-interface/src/**/*.test.ts`

- [ ] **Step 1: Run targeted no-scope sweep**

Run:

```bash
rg -n "scopeKey" packages/agent-vm/src packages/gateway-interface/src -g '!*.test.ts'
```

Expected:

```text
```

Run:

```bash
rg -n "scopeKey" packages/openclaw-agent-vm-plugin/src -g '!*.test.ts'
```

Expected: only SDK boundary input handling remains. If OpenClaw SDK boundary tests use `scopeKey` as input to `createGondolinSandboxBackendFactory`, each hit must be a test name or fixture proving the plugin discards it. There must be zero `scopeKey` hits in controller request/response types, Lease, runtime records, generated manuals, or gateway-interface lease types.

- [ ] **Step 2: Run focused package tests**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/tool-vm-lease-id.test.ts packages/gateway-interface/src/tool-vm-lease.test.ts packages/gateway-interface/src/tool-vm-active-use.test.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full quality gate**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 4: Run full unit suite**

Run:

```bash
pnpm test:unit
```

Expected: PASS. If MCP Portal fails here, rerun the focused MCP Portal command from Execution Preflight Step 2 and report the current failing test name before deciding whether it is in scope.

- [ ] **Step 5: Run integration suite**

Run:

```bash
pnpm test:integration
```

Expected: PASS or expected environment-gated skips. Report exact pass/skip/fail counts.

- [ ] **Step 6: Run smoke suite**

Run:

```bash
mise exec -- pnpm test:smoke
```

Expected: PASS or expected environment-gated skips. Report exact pass/skip/fail counts.

- [ ] **Step 7: Beta-style manual API proof without secrets**

Against a locally running controller test instance, create a lease with no `scopeKey` and no `sandbox`:

```bash
curl -sS -X POST http://127.0.0.1:18800/lease \
  -H 'content-type: application/json' \
  --data '{"agentId":"beta","sessionKey":"agent:beta:manual","zoneId":"beta","profileId":"standard","agentWorkspaceDir":"/zone/agents/beta","workMountDir":"/zone/agents/beta"}' \
  | jq '{leaseId, agentId, workdir, hasScopeKey: has("scopeKey")}'
```

Expected:

```json
{
  "agentId": "beta",
  "workdir": "/workspace",
  "hasScopeKey": false
}
```

The `leaseId` value must be a UUIDv7 string and must not contain `beta`, `agent`, `scope`, or a timestamp.

- [ ] **Step 8: Commit verification-only fixture cleanup**

If test fixture updates were required after broad runs:

```bash
git add packages
git commit -m "test: update tool vm lease hard cutover fixtures"
```

Skip this commit if no files changed after verification.

---

## Self-Review

### Spec Coverage

- `scopeKey` removed from lease model: Tasks 1, 2, 5, 9, 11.
- `createdAt` removed from ids: Tasks 1 and 3.
- Expired leases cannot resurrect: Tasks 3, 4, 5.
- Dead VM renewal cannot lie: Tasks 3, 4, 5, 8.
- TTL defaults fixed: Task 7.
- Active-use semantics clarified: Task 8.
- Plugin-observed SSH probe, heartbeat report, timeout, and stale-handle invalidation covered: Task 8A.
- Plugin/controller request-response hard cutover: Tasks 2, 4, 5.
- Workspace RW and `/workspace` output-only path: Tasks 6 and 10.
- Subagent permutation coverage: Task 6.
- Integration tests included before full verification: Tasks 2, 5, 6, 8A, 11.

### Placeholder Scan

The plan intentionally avoids gradual migration, dual contracts, and old-record parsing. All code snippets define concrete names and shapes used by later tasks.

### Type Consistency

The plan consistently uses:

```text
createToolVmLeaseId
isToolVmLeaseId
ToolVmLeaseIdleTtlPolicy
resolveToolVmLeaseIdleTtlMs
LeaseRenewal.kind = 'renewed' | 'not-found'
LeaseRenewal.reason = 'missing' | 'expired' | 'dead'
ToolVmSshFailureKind = 'active-use-refreshable-failure' | 'ssh-command-failed' | 'ssh-command-timed-out' | 'ssh-probe-failed' | 'unknown'
```

No task introduces `scopeKey` into the controller or gateway-interface lease contract.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-tool-vm-agent-lease-hard-cutover.md`.

Two execution options:

1. Subagent-Driven (recommended): dispatch a fresh subagent per task, review each task before moving on, and keep the TDD red/green evidence attached to each commit.
2. Inline Execution: execute tasks in this session with `superpowers:executing-plans`, batching small related steps but stopping at review checkpoints when the model shifts.
