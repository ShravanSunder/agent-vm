# Gondolin Adapter Widening and Tool VM SSH Lease Cleanup Implementation Plan

Status: current / valid executable plan. This is the next prerequisite plan for both the existing OpenClaw Tool VM SSH cleanup and future controller-owned credentialed runner work.

Compaction-proof instruction: if an agent is resuming with limited context, this
is the canonical current Tool VM revamp plan. Do not switch back to
`2026-05-21-tool-vm-active-use-lifecycle.md` as the implementation plan; that
file is an already-implemented supporting slice from before this architecture was
clarified.

Use this for:
- Exposing Gondolin `ExecOptions`, `ExecProcess`, `ExecResult`, and `VmFs` through `@agent-vm/gondolin-adapter` by composing Gondolin's public types.
- Adding the small generic VM capability lease base and SSH endpoint primitives used by VM-to-VM SSH.
- Naming the current OpenClaw Tool VM lease as an SSH capability.
- Keeping OpenClaw's FS bridge plugin-owned rather than inventing generic SSH filesystem RPC.

Do not use this for:
- Implementing credentialed runner v1.
- Implementing non-SSH transports such as credentialed `gondolin-rpc` leases or macOS bridge leases.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen the Gondolin adapter to expose native exec/fs primitives, add the small generic VM capability/SSH type layer, then clean up the existing OpenClaw Tool VM SSH lease path so it is explicitly an SSH capability with no generic FS API.

**Architecture:** This plan builds only the generic pieces that are needed now: a transport-tagged VM capability lease base and reusable SSH endpoint/lease types. The current Tool VM lease specializes those primitives as `ssh-sandbox`. Credentialed runner and macOS bridge transports can later reuse the base shape, but their execution backends and APIs remain follow-up plans.

**Tech Stack:** TypeScript, pnpm, Vitest, OXC, `@earendil-works/gondolin`, `@agent-vm/gateway-interface`, `@agent-vm/gondolin-adapter`, `@agent-vm/openclaw-agent-vm-plugin`, `mise` for Zig-backed Gondolin/live lanes.

---

## Design Decision

The reusable VM capability type is deliberately small. It names a leased capability and its transport; it does not define command execution or filesystem operations:

```ts
export interface VmCapabilityLease<TTransport extends string> {
	readonly leaseId: string;
	readonly transport: TTransport;
}
```

The reusable VM-to-VM SSH type is also deliberately small. It is an SSH endpoint plus a transport-tagged lease:

```ts
export interface VmSshEndpoint {
	readonly host: string;
	readonly identityPem: string;
	readonly knownHostsLine: string;
	readonly port: number;
	readonly user: string;
}

export interface VmSshLease<TTransport extends string> extends VmCapabilityLease<TTransport> {
	readonly ssh: VmSshEndpoint;
}
```

The Tool VM type is the current specialization:


```ts
export interface ToolVmSshLease extends VmSshLease<'ssh-sandbox'> {
	readonly tcpSlot: number;
	readonly workdir: string;
}
```

OpenClaw can implement its required FS bridge using this SSH capability. That bridge stays OpenClaw-specific because it is an OpenClaw remote-shell filesystem protocol over SSH, not Gondolin `vm.fs`.

That base shape can cover future credentialed runner leases and macOS bridge controller leases without forcing this Tool VM SSH cleanup plan to invent unused `gondolin-rpc` or `ingress-service` variants today.

Controller-owned controlled workloads, including credentialed CLI runner v1, should use Gondolin's native RPC after the adapter widening in this plan:

```ts
vm.exec(['/usr/local/bin/gog', 'calendar', 'list', '--json'], {
	stdout: 'pipe',
	stderr: 'pipe',
	buffer: false,
});

const artifactStream = await vm.fs.readFileStream('/run-out/run-id/events.json');
```

Do not invent runner HTTP, SSH file RPC, or a new artifact protocol before exposing the Gondolin primitives that already exist.

## Grounding

Gondolin exports the types we need from its public package entry:

```ts
export {
	VM,
	type VMOptions,
	type VmFs,
	type VmFsReadFileStreamOptions,
	type VmFsWriteFileInput,
} from './vm/core.js';

export {
	type ExecOptions,
	type ExecResult,
	type ExecProcess,
} from './exec.js';
```

Local installed evidence:

- `node_modules/.pnpm/@earendil-works+gondolin@0.9.1*/node_modules/@earendil-works/gondolin/dist/src/index.d.ts`
- `node_modules/.pnpm/@earendil-works+gondolin@0.9.1*/node_modules/@earendil-works/gondolin/dist/src/vm/core.d.ts`
- `node_modules/.pnpm/@earendil-works+gondolin@0.9.1*/node_modules/@earendil-works/gondolin/dist/src/vm/fs.d.ts`
- `node_modules/.pnpm/@earendil-works+gondolin@0.9.1*/node_modules/@earendil-works/gondolin/dist/src/exec.d.ts`

Current adapter problem:

```ts
export interface ManagedVm {
	readonly id: string;
	exec(command: string): Promise<ExecResult>;
	enableSsh(options?: EnableSshOptions): Promise<SshAccess>;
	enableIngress(options?: EnableIngressOptions): Promise<IngressAccess>;
	getVmInstance(): ManagedVmInstance;
	setIngressRoutes(routes: readonly IngressRoute[]): void;
	close(): Promise<void>;
}
```

This strips away:

- array-form `vm.exec([absoluteCommand, ...argv], options)`
- streaming stdout/stderr
- stdin streams
- pty options
- `vm.fs`
- file streaming

## Scope Boundary

```text
this plan
  Gondolin adapter exposes vm.exec options, ExecProcess, and vm.fs
  gateway-interface defines VmCapabilityLease and VM SSH endpoint primitives
  Tool VM lease responses are named as SSH capabilities
  OpenClaw FS bridge is renamed as OpenClaw-specific adapter behavior
  cross-VM SSH over tcp.hosts remains the live quality gate

follow-up: credentialed-runner-v1
  uses widened adapter
  uses controller-owned vm.exec / vm.fs
  defines /cred /run-in /run-out /scratch VFS layout
  defines typed tool catalog, argv builders, audit correlation, artifact policy

follow-up: macos-bridge-controller
  reuses the same future VmCapabilityLease conceptual shape
  uses a host-side daemon capability, not Gondolin

```

## Important Caveats

### Gondolin `vm.fs` has two paths

For VFS-mounted paths, `vm.fs` can hit the host-side provider directly.

For guest-rootfs paths, Gondolin's sandbox server waits for exec idle before file RPC:

```ts
async readGuestFileStream(filePath, options = {}) {
	this.assertGuestPath(filePath, "filePath");
	await this.start();
	await this.waitForExecIdle(options.signal);
	...
}
```

Do not design an ingress service that starts a forever foreground `vm.exec()` and then expects rootfs `vm.fs` calls to stay independent. If a warm ingress service is needed later, start it through image init, a fixed background boot script, or make the service the only runtime API.

Hard rule for the credentialed runner follow-up: artifact paths must live in VFS mounts such as `/run-out`, not in guest rootfs. `vm.fs` can stream VFS-backed artifacts while an exec is active; rootfs file RPC waits for exec idle and is the wrong place for long-running runner artifacts.

### Gondolin mapped TCP patch remains a tracked risk

The OpenClaw SSH path depends on Gondolin mapped TCP allowing `tool-N.vm.host:22` to map to a host-local `enableSsh()` listener. The local patch changes mapped TCP classification ordering. The plan must keep a live cross-VM SSH smoke test as the quality gate and should either upstream the patch or document the local patch as load-bearing until upstream releases the fix.

## File Structure

### `packages/gateway-interface/src/vm-capability-lease.ts`

New shared base types for leased VM capabilities and SSH endpoints. This file contains no filesystem interface and no execution interface.

Responsibilities:

- `VmCapabilityLease<TTransport>`
- `VmSshEndpoint`
- `VmSshPublicEndpoint`
- `VmSshLease<TTransport>`
- runtime guards for generic SSH endpoint validation

### `packages/gateway-interface/src/vm-capability-lease.test.ts`

New unit tests for the generic capability and SSH endpoint guards.

### `packages/gateway-interface/src/tool-vm-lease.ts`

New Tool VM specialization for the current OpenClaw SSH sandbox lease. This file contains no filesystem interface.

Responsibilities:

- `ToolVmSshLease`
- `ToolVmLeasePeek`
- runtime guards for controller/plugin Tool VM response validation

### `packages/gateway-interface/src/tool-vm-lease.test.ts`

New unit tests for the Tool VM SSH lease guards.

### `packages/gateway-interface/src/index.ts`

Exports the new generic VM capability types, Tool VM lease/capability types, and guards.

### `packages/gondolin-adapter/src/vm-adapter.ts`

Widen `ManagedVm` to expose Gondolin's exec options and `VmFs`. The adapter must compose public Gondolin types by aliasing/re-exporting them. Do not redefine `ExecProcess`, `ExecOptions`, `ExecResult`, or `VmFs` locally.

Responsibilities after this plan:

- `ManagedVm.fs`
- `ManagedVm.exec(command: string | readonly string[], options?: ManagedExecOptions)`
- preserve existing `await managedVm.exec('...')` behavior because returned exec process is promise-like
- keep `enableSsh`, `enableIngress`, `setIngressRoutes`, and `close`

### `packages/gondolin-adapter/src/vm-adapter.test.ts`

Update adapter tests to prove:

- array-form exec is forwarded as a mutable array copy
- exec options are forwarded
- the underlying `fs` object is exposed
- existing buffered `await managedVm.exec('echo hi')` behavior still works

### `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`

Replace local `GondolinLeaseResponse` naming with shared `ToolVmSshLease`. The HTTP client remains in the plugin for now; this plan does not create a new runtime package.

### `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts`

Rename the FS bridge types so they stop pretending to be generic Gondolin FS:

- `GondolinFsBridge` -> `OpenClawSandboxFsBridge`
- `FsBridgeLeaseContext` -> `OpenClawFsBridgeLeaseContext`

Do not add a generic `ToolVmSshFsBridge`.

### `packages/openclaw-agent-vm-plugin/src/openclaw-backend-dependencies.ts`

Update type imports/names. Keep using OpenClaw's `createRemoteShellSandboxFsBridge`.

### `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`

Update type imports/names and keep active-use wrapping around OpenClaw shell and FS bridge operations.

### `packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts`

Keep this as the live quality gate for SSH over mapped TCP. Clean up imports and comments so it clearly documents the local Gondolin patch dependency.

### `docs/subsystems/gondolin-vm-layer.md`

Document the three transport modes and the adapter widening.

### `docs/architecture/openclaw-gateway.md`

Document that OpenClaw FS bridge is OpenClaw-specific and rides on the SSH lease capability.

## Task 1: Generic VM Capability and Tool VM SSH Lease Types

**Files:**

- Create: `packages/gateway-interface/src/vm-capability-lease.ts`
- Create: `packages/gateway-interface/src/vm-capability-lease.test.ts`
- Create: `packages/gateway-interface/src/tool-vm-lease.ts`
- Create: `packages/gateway-interface/src/tool-vm-lease.test.ts`
- Modify: `packages/gateway-interface/src/index.ts`

- [ ] **Step 1: Write the failing generic capability tests**

Create `packages/gateway-interface/src/vm-capability-lease.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
	isVmCapabilityLease,
	isVmSshEndpoint,
	isVmSshPublicEndpoint,
} from './vm-capability-lease.js';

describe('VM capability lease primitives', () => {
	it('accepts transport-tagged capability leases and rejects wrong transports', () => {
		expect(
			isVmCapabilityLease(
				{
					leaseId: 'lease-123',
					transport: 'ssh-sandbox',
				},
				'ssh-sandbox',
			),
		).toBe(true);

		expect(
			isVmCapabilityLease(
				{
					leaseId: 'lease-123',
					transport: 'gondolin-rpc',
				},
				'ssh-sandbox',
			),
		).toBe(false);
	});

	it('accepts complete SSH endpoints and rejects partial endpoints', () => {
		expect(
			isVmSshEndpoint({
				host: 'tool-0.vm.host',
				identityPem: '-----BEGIN OPENSSH PRIVATE KEY-----',
				knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
				port: 22,
				user: 'root',
			}),
		).toBe(true);

		expect(
			isVmSshEndpoint({
				host: 'tool-0.vm.host',
				port: 22,
				user: 'root',
			}),
		).toBe(false);
	});

	it('accepts public SSH endpoints without private key material', () => {
		expect(
			isVmSshPublicEndpoint({
				host: 'tool-0.vm.host',
				port: 22,
				user: 'root',
			}),
		).toBe(true);

		expect(
			isVmSshPublicEndpoint({
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				port: 22,
				user: 'root',
			}),
		).toBe(false);
	});
});
```

- [ ] **Step 2: Write the failing Tool VM lease tests**

Create `packages/gateway-interface/src/tool-vm-lease.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
	isToolVmLeasePeek,
	isToolVmSshLease,
} from './tool-vm-lease.js';

describe('Tool VM SSH lease types', () => {
	it('accepts an SSH lease capability and does not model filesystem methods', () => {
		const lease = {
			leaseId: 'zone-scope-123',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: 'known-hosts',
				port: 22,
				user: 'root',
			},
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/work',
		};

		expect(isToolVmSshLease(lease)).toBe(true);
		expect('readFile' in lease).toBe(false);
		expect('writeFile' in lease).toBe(false);
	});

	it('accepts read-only lease peek snapshots without private key material', () => {
		expect(
			isToolVmLeasePeek({
				createdAt: 1,
				lastUsedAt: 2,
				leaseId: 'zone-scope-123',
				profileId: 'standard',
				scopeKey: 'agent-session',
				ssh: {
					host: 'tool-0.vm.host',
					port: 22,
					user: 'root',
				},
				tcpSlot: 0,
				transport: 'ssh-sandbox',
				workdir: '/work',
				zoneId: 'default',
			}),
		).toBe(true);
	});
});
```

- [ ] **Step 3: Run the failing tests**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/vm-capability-lease.test.ts packages/gateway-interface/src/tool-vm-lease.test.ts
```

Expected: fail because `vm-capability-lease.ts` and `tool-vm-lease.ts` do not exist.

- [ ] **Step 4: Implement the generic capability and SSH endpoint primitives**

Create `packages/gateway-interface/src/vm-capability-lease.ts`:

```ts
export interface VmCapabilityLease<TTransport extends string> {
	readonly leaseId: string;
	readonly transport: TTransport;
}

export interface VmSshEndpoint {
	readonly host: string;
	readonly identityPem: string;
	readonly knownHostsLine: string;
	readonly port: number;
	readonly user: string;
}

export interface VmSshPublicEndpoint {
	readonly host: string;
	readonly port: number;
	readonly user: string;
}

export interface VmSshLease<TTransport extends string>
	extends VmCapabilityLease<TTransport> {
	readonly ssh: VmSshEndpoint;
}

function objectValue(value: unknown): object | undefined {
	return typeof value === 'object' && value !== null ? value : undefined;
}

export function isVmCapabilityLease<TTransport extends string>(
	value: unknown,
	transport: TTransport,
): value is VmCapabilityLease<TTransport> {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'leaseId') === 'string' &&
		Reflect.get(record, 'transport') === transport
	);
}

export function isVmSshEndpoint(value: unknown): value is VmSshEndpoint {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'host') === 'string' &&
		typeof Reflect.get(record, 'identityPem') === 'string' &&
		typeof Reflect.get(record, 'knownHostsLine') === 'string' &&
		typeof Reflect.get(record, 'port') === 'number' &&
		typeof Reflect.get(record, 'user') === 'string'
	);
}

export function isVmSshPublicEndpoint(value: unknown): value is VmSshPublicEndpoint {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'host') === 'string' &&
		!Reflect.has(record, 'identityPem') &&
		!Reflect.has(record, 'knownHostsLine') &&
		typeof Reflect.get(record, 'port') === 'number' &&
		typeof Reflect.get(record, 'user') === 'string'
	);
}
```

- [ ] **Step 5: Implement the Tool VM SSH specialization**

Create `packages/gateway-interface/src/tool-vm-lease.ts`:

```ts
import {
	isVmCapabilityLease,
	isVmSshEndpoint,
	isVmSshPublicEndpoint,
	type VmCapabilityLease,
	type VmSshEndpoint,
	type VmSshPublicEndpoint,
} from './vm-capability-lease.js';

export interface ToolVmSshLease extends VmCapabilityLease<'ssh-sandbox'> {
	readonly ssh: VmSshEndpoint;
	readonly tcpSlot: number;
	readonly workdir: string;
}

export interface ToolVmLeasePeek extends VmCapabilityLease<'ssh-sandbox'> {
	readonly createdAt: number;
	readonly lastUsedAt: number;
	readonly profileId: string;
	readonly scopeKey: string;
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
		isVmSshEndpoint(Reflect.get(record, 'ssh')) &&
		typeof Reflect.get(record, 'tcpSlot') === 'number' &&
		typeof Reflect.get(record, 'workdir') === 'string'
	);
}

export function isToolVmLeasePeek(value: unknown): value is ToolVmLeasePeek {
	const record = objectValue(value);
	return (
		isVmCapabilityLease(record, 'ssh-sandbox') &&
		typeof Reflect.get(record, 'createdAt') === 'number' &&
		typeof Reflect.get(record, 'lastUsedAt') === 'number' &&
		typeof Reflect.get(record, 'profileId') === 'string' &&
		typeof Reflect.get(record, 'scopeKey') === 'string' &&
		isVmSshPublicEndpoint(Reflect.get(record, 'ssh')) &&
		typeof Reflect.get(record, 'tcpSlot') === 'number' &&
		typeof Reflect.get(record, 'workdir') === 'string' &&
		typeof Reflect.get(record, 'zoneId') === 'string'
	);
}
```

- [ ] **Step 6: Export the shared types**

Modify `packages/gateway-interface/src/index.ts`:

```ts
export {
	isVmCapabilityLease,
	isVmSshEndpoint,
	isVmSshPublicEndpoint,
} from './vm-capability-lease.js';
export type {
	VmCapabilityLease,
	VmSshEndpoint,
	VmSshLease,
	VmSshPublicEndpoint,
} from './vm-capability-lease.js';
export {
	isToolVmLeasePeek,
	isToolVmSshLease,
} from './tool-vm-lease.js';
export type {
	ToolVmLeasePeek,
	ToolVmSshLease,
} from './tool-vm-lease.js';
```

Place this near the existing `tool-vm-active-use.js` exports.

- [ ] **Step 7: Run the tests**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/vm-capability-lease.test.ts packages/gateway-interface/src/tool-vm-lease.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

Only commit if the human explicitly asked for git writes in the execution session.

```bash
git add packages/gateway-interface/src/vm-capability-lease.ts packages/gateway-interface/src/vm-capability-lease.test.ts packages/gateway-interface/src/tool-vm-lease.ts packages/gateway-interface/src/tool-vm-lease.test.ts packages/gateway-interface/src/index.ts
git commit \
	-m "feat: add VM capability and Tool VM SSH lease types" \
	-m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 2: Widen the Gondolin Adapter to Native Exec and FS

**Files:**

- Modify: `packages/gondolin-adapter/src/vm-adapter.ts`
- Modify: `packages/gondolin-adapter/src/vm-adapter.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Modify `packages/gondolin-adapter/src/vm-adapter.test.ts`.

Add imports:

```ts
import { Readable } from 'node:stream';
import type {
	ExecProcess as GondolinExecProcess,
	ExecResult as GondolinExecResult,
	VmFs as GondolinVmFs,
} from '@earendil-works/gondolin';
```

Add helpers near `createFakeVmInstance()`:

```ts
function createFakeExecProcess(result: {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}): GondolinExecProcess {
	const promise = Promise.resolve({
		exitCode: result.exitCode,
		stderr: result.stderr,
		stdout: result.stdout,
	} as GondolinExecResult);
	return {
		[Symbol.asyncIterator]: async function* (): AsyncIterator<string> {
			yield result.stdout;
		},
		stderr: Readable.from([result.stderr]),
		stdout: Readable.from([result.stdout]),
		then: promise.then.bind(promise),
	} as GondolinExecProcess;
}

function createFakeVmFs(): GondolinVmFs {
	return {
		access: vi.fn(async () => {}),
		deleteFile: vi.fn(async () => {}),
		listDir: vi.fn(async () => ['entry.txt']),
		mkdir: vi.fn(async () => {}),
		readFile: vi.fn(async () => Buffer.from('file-data')),
		readFileStream: vi.fn(async () => Readable.from([Buffer.from('file-data')])),
		rename: vi.fn(async () => {}),
		stat: vi.fn(async () => {
			throw new Error('stat not implemented in fake');
		}),
		writeFile: vi.fn(async () => {}),
	};
}
```

Update `createFakeVmInstance()` so it includes `fs` and returns a process-like exec result:

```ts
function createFakeVmInstance(): ManagedVmInstance {
	return {
		id: 'vm-123',
		fs: createFakeVmFs(),
		exec: vi.fn(() => createFakeExecProcess({ exitCode: 0, stdout: 'ok', stderr: '' })),
		enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
		enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
		setIngressRoutes: vi.fn(),
		close: vi.fn(async () => {}),
	};
}
```

In the existing test `translates controller options into gondolin vm options and delegates runtime methods`, set `fs` and assert forwarding:

```ts
const fakeFs = createFakeVmFs();
const execMock = vi.fn(() => createFakeExecProcess({ exitCode: 0, stdout: 'ok', stderr: '' }));
const fakeVmInstance: ManagedVmInstance = {
	id: 'vm-123',
	fs: fakeFs,
	exec: execMock,
	enableSsh: enableSshMock,
	enableIngress: enableIngressMock,
	setIngressRoutes: setIngressRoutesMock,
	close: closeMock,
};
```

Replace the existing `managedVm.exec` assertion with:

```ts
const bufferedResult = await managedVm.exec('echo hi');
expect(bufferedResult.stdout).toBe('ok');

const streamedProcess = managedVm.exec(['/bin/echo', 'hi'], {
	buffer: false,
	stdout: 'pipe',
	windowBytes: 32 * 1024,
});

expect(streamedProcess.stdout).not.toBeNull();
expect(managedVm.fs).toBe(fakeFs);
expect(execMock).toHaveBeenCalledWith(['/bin/echo', 'hi'], {
	buffer: false,
	stdout: 'pipe',
	windowBytes: 32 * 1024,
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/vm-adapter.test.ts
```

Expected: fail because `ManagedVm` and `ManagedVmInstance` do not expose `fs`, and `exec` does not accept options. Do not fix this by inventing adapter-local process or filesystem interfaces; the implementation step must alias Gondolin's exported types.

- [ ] **Step 3: Update adapter types**

Modify imports in `packages/gondolin-adapter/src/vm-adapter.ts`:

```ts
import {
	MemoryProvider,
	ReadonlyProvider,
	RealFSProvider,
	ShadowProvider,
	VM,
	createHttpHooks,
	createShadowPathPredicate,
	type CreateHttpHooksResult,
	type EnableIngressOptions,
	type EnableSshOptions,
	type ExecOptions as GondolinExecOptions,
	type ExecProcess as GondolinExecProcess,
	type ExecResult as GondolinExecResult,
	type IngressRoute as GondolinIngressRoute,
	type ShadowPredicate,
	type ShadowProviderOptions,
	type VMOptions,
	type VirtualProvider,
	type VmFs as GondolinVmFs,
} from '@earendil-works/gondolin';
```

Replace the adapter-owned exec result/process/filesystem projections with aliases to Gondolin's public types:

```ts
export type ManagedExecInput = string | readonly string[];
export type ManagedExecOptions = GondolinExecOptions;
export type ManagedExecProcess = GondolinExecProcess;
export type ManagedExecResult = GondolinExecResult;
export type ManagedVmFs = GondolinVmFs;

// Backward-compatible alias for existing imports. This is still Gondolin's
// result type, not an adapter-defined shadow interface.
export type ExecResult = ManagedExecResult;
```

Update `ManagedVmInstance`. The inner `ManagedVmInstance` mirrors Gondolin's mutable array command signature; the public `ManagedVm` wrapper below accepts `readonly string[]` and copies it before forwarding so callers cannot observe mutation:

```ts
export interface ManagedVmInstance {
	readonly fs: ManagedVmFs;
	readonly id: string;
	exec(command: string | string[], options?: ManagedExecOptions): ManagedExecProcess;
	enableSsh(options?: EnableSshOptions): Promise<SshAccess>;
	enableIngress(options?: EnableIngressOptions): Promise<IngressAccess>;
	setIngressRoutes(routes: readonly IngressRoute[]): void;
	close(): Promise<void>;
}
```

Update `ManagedVm`:

```ts
export interface ManagedVm {
	readonly fs: ManagedVmFs;
	readonly id: string;
	exec(command: ManagedExecInput, options?: ManagedExecOptions): ManagedExecProcess;
	enableSsh(options?: EnableSshOptions): Promise<SshAccess>;
	enableIngress(options?: EnableIngressOptions): Promise<IngressAccess>;
	getVmInstance(): ManagedVmInstance;
	setIngressRoutes(routes: readonly IngressRoute[]): void;
	close(): Promise<void>;
}
```

Update the returned object in `createManagedVm()`:

```ts
return {
	fs: vmInstance.fs,
	id: vmInstance.id,
	exec(command: ManagedExecInput, execOptions?: ManagedExecOptions): ManagedExecProcess {
		const normalizedCommand = typeof command === 'string' ? command : [...command];
		return vmInstance.exec(normalizedCommand, execOptions);
	},
	...
};
```

- [ ] **Step 4: Run adapter tests**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/vm-adapter.test.ts
```

Expected: pass.

- [ ] **Step 5: Run typecheck for adapter consumers**

Run:

```bash
pnpm typecheck
```

Expected: type errors in tests/mocks that construct `ManagedVmInstance` or `ManagedVm` without `fs`.

Re-run this grep at execution time before fixing mocks; the list below is only a pre-plan snapshot and may be stale:

```bash
rg -n "ManagedVmInstance|ManagedVm =|: ManagedVm|as ManagedVm|createFakeVmInstance" packages --glob '*.{ts,tsx}'
```

Pre-plan mock sites:

- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`
- `packages/agent-vm/src/gateway/gateway-runtime-record.test.ts`
- `packages/agent-vm/src/integration-tests/live-controller-restart-persistence.integration.test.ts`
- `packages/agent-vm/src/controller/leases/lease-manager.test.ts`
- `packages/agent-vm/src/controller/worker-task-runner.test.ts`
- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`
- `packages/gondolin-adapter/src/vm-adapter.test.ts`

Fix each mock by adding:

```ts
fs: createFakeVmFs(),
```

If a test file does not already have a local fake FS helper, add a minimal helper in that test file:

```ts
import { Readable } from 'node:stream';
import type { ManagedVmFs } from '@agent-vm/gondolin-adapter';

function createFakeVmFs(): ManagedVmFs {
	return {
		access: vi.fn(async () => {}),
		deleteFile: vi.fn(async () => {}),
		listDir: vi.fn(async () => []),
		mkdir: vi.fn(async () => {}),
		readFile: vi.fn(async () => Buffer.from('')),
		readFileStream: vi.fn(async () => Readable.from([])),
		rename: vi.fn(async () => {}),
		stat: vi.fn(async () => {
			throw new Error('stat not implemented in fake');
		}),
		writeFile: vi.fn(async () => {}),
	};
}
```

Use the package's existing import style and place imports at the top.

- [ ] **Step 6: Commit**

Only commit if the human explicitly asked for git writes in the execution session.

```bash
git add packages/gondolin-adapter/src/vm-adapter.ts packages/gondolin-adapter/src/vm-adapter.test.ts
git status --short
git commit \
	-m "feat: expose Gondolin exec streaming and fs through adapter" \
	-m "Co-authored-by: Codex <noreply@openai.com>"
```

If Step 5 required mock fixes in other files, add those exact files explicitly
before committing. Do not use broad paths such as `git add packages/agent-vm/src`
or `git add packages`.

## Task 3: Move Lease Response Types to Shared SSH Capability

**Files:**

- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`

- [ ] **Step 1: Write failing lease-client expectations**

In `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`, update successful lease JSON fixtures so every full lease response includes:

```ts
transport: 'ssh-sandbox',
```

Add an assertion to the request/renew tests:

```ts
expect(lease.transport).toBe('ssh-sandbox');
```

Add a rejection test for responses missing the transport discriminator:

```ts
it('rejects lease responses missing the transport discriminator', async () => {
	const fetchImpl = vi.fn(async () => new Response(
		JSON.stringify({
			leaseId: 'lease-1',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: 'known-hosts',
				port: 22,
				user: 'root',
			},
			tcpSlot: 0,
			workdir: '/work',
		}),
		{ status: 200 },
	));
	const client = createLeaseClient({
		controllerUrl: 'http://controller.vm.host:18800',
		fetchImpl,
	});

	await expect(
		client.requestLease({
			agentWorkspaceDir: '/workspace',
			profileId: 'standard',
			scopeKey: 'agent-session',
			workMountDir: '/workspace',
			zoneId: 'default',
		}),
	).rejects.toThrow('Controller lease create API returned an invalid response');
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts
```

Expected: fail because local `GondolinLeaseResponse` does not require `transport`.

- [ ] **Step 3: Replace local response types with shared types**

Modify `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`.

Change imports:

```ts
import type {
	EndToolVmActiveUseRequest,
	HeartbeatToolVmActiveUseResponse,
	StartToolVmActiveUseRequest,
	StartToolVmActiveUseResponse,
	ToolVmLeasePeek,
	ToolVmSshLease,
} from '@agent-vm/gateway-interface';
import {
	isToolVmLeasePeek,
	isToolVmSshLease,
} from '@agent-vm/gateway-interface';
```

Delete local `GondolinLeaseResponse`, `LeasePeekResponse`, `isSshResponse`, `isLeasePeekSshResponse`, `isGondolinLeaseResponse`, and `isLeasePeekResponse`.

Update the client interface:

```ts
export interface LeaseClient {
	endActiveUse(leaseId: string, useId: string, request: EndToolVmActiveUseRequest): Promise<void>;
	heartbeatActiveUse(leaseId: string, useId: string): Promise<HeartbeatToolVmActiveUseResponse>;
	peekLease(leaseId: string): Promise<ToolVmLeasePeek>;
	publishOpenClawRuntimeStatus?(report: OpenClawRuntimeStatusReport): Promise<void>;
	releaseLease(leaseId: string, options?: { readonly force?: boolean }): Promise<void>;
	renewLease(leaseId: string): Promise<ToolVmSshLease>;
	requestLease(request: {
		readonly agentWorkspaceDir: string;
		readonly profileId: string;
		readonly scopeKey: string;
		readonly workMountDir: string;
		readonly zoneId: string;
	}): Promise<ToolVmSshLease>;
	startActiveUse(
		leaseId: string,
		request: StartToolVmActiveUseRequest,
	): Promise<StartToolVmActiveUseResponse>;
}
```

Update response parsing:

```ts
return await readJsonResponse(response, 'Controller lease renew API', isToolVmSshLease);
```

```ts
return await readJsonResponse(response, 'Controller lease peek API', isToolVmLeasePeek);
```

```ts
return await readJsonResponse(response, 'Controller lease create API', isToolVmSshLease);
```

- [ ] **Step 4: Update controller serialization**

This step is required because Step 1's rejection test will fail until controller full lease and peek responses include the discriminator. Modify `packages/agent-vm/src/controller/http/controller-http-route-support.ts`:

```ts
transport: 'ssh-sandbox' as const,
```

Expected full response shape:

```ts
{
	leaseId: lease.id,
	ssh: {
		host: `tool-${lease.tcpSlot}.vm.host`,
		identityPem,
		knownHostsLine,
		port: 22,
		user: lease.sshAccess.user ?? 'root',
	},
	tcpSlot: lease.tcpSlot,
	transport: 'ssh-sandbox' as const,
	workdir: lease.guestWorkdir,
}
```

Expected peek response shape:

```ts
{
	createdAt: lease.createdAt,
	lastUsedAt: lease.lastUsedAt,
	leaseId: lease.id,
	profileId: lease.profileId,
	scopeKey: lease.scopeKey,
	ssh: {
		host: `tool-${lease.tcpSlot}.vm.host`,
		port: 22,
		user: lease.sshAccess.user ?? 'root',
	},
	tcpSlot: lease.tcpSlot,
	transport: 'ssh-sandbox' as const,
	workdir: lease.guestWorkdir,
	zoneId: lease.zoneId,
}
```

- [ ] **Step 5: Update imports in OpenClaw sandbox code**

In `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts`, replace:

```ts
import type { GondolinLeaseResponse, LeaseClient } from '../controller-lease-client.js';
```

with:

```ts
import type { ToolVmSshLease } from '@agent-vm/gateway-interface';
import type { LeaseClient } from '../controller-lease-client.js';
```

Update all `GondolinLeaseResponse` references in this file to `ToolVmSshLease`.

In `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`, use `ToolVmSshLease` for lease parameters where needed.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/tool-vm-lease.test.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

Only commit if the human explicitly asked for git writes in the execution session.

```bash
git add packages/gateway-interface/src packages/openclaw-agent-vm-plugin/src packages/agent-vm/src/controller/http
git commit \
	-m "refactor: share Tool VM SSH lease capability type" \
	-m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 4: Keep OpenClaw FS Bridge Plugin-Owned

**Files:**

- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-backend-dependencies.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`

- [ ] **Step 1: Write a test that codifies the boundary**

In `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`, add a test near the FS bridge tests:

```ts
it('keeps filesystem bridging as an OpenClaw adapter concern over the SSH lease', async () => {
	const createRemoteShellSandboxFsBridge = vi.fn(() => ({
		mkdirp: vi.fn(async () => {}),
		readFile: vi.fn(async () => Buffer.from('data')),
		remove: vi.fn(async () => {}),
		rename: vi.fn(async () => {}),
		resolvePath: vi.fn(() => ({
			containerPath: '/work/file.txt',
			relativePath: 'file.txt',
		})),
		stat: vi.fn(async () => ({
			mtimeMs: 1,
			size: 4,
			type: 'file' as const,
		})),
		writeFile: vi.fn(async () => {}),
	}));

	const backendFactory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'default',
		},
		createBackendDeps({
			buildExecRemoteCommand: vi.fn(),
			buildRemoteCommand: vi.fn(),
			buildSshSandboxArgv: vi.fn(),
			createRemoteShellSandboxFsBridge,
			createSshSandboxSessionFromSettings: vi.fn(),
			runSshSandboxCommand: vi.fn(),
			sanitizeEnvVars: vi.fn(() => ({ allowed: {}, rejected: {} })),
		}),
	);

	const handle = await backendFactory({
		agentWorkspaceDir: '/workspace',
		cfg: {},
		scopeKey: 'agent-session',
		sessionKey: 'session-1',
		workspaceDir: '/workspace',
	});

	const fsBridge = handle.createFsBridge?.({ sandbox: {} });

	expect(fsBridge).toBeDefined();
	expect(createRemoteShellSandboxFsBridge).toHaveBeenCalled();
});
```

Adjust fixture setup to match the existing test helpers in this file. The assertion must prove OpenClaw's helper is still the FS bridge implementation.

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts
```

Expected: fail if current test helpers do not include the new lease discriminator or renamed types.

- [ ] **Step 3: Rename FS bridge types**

In `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts`, rename:

```ts
export interface FsBridgeLeaseContext
```

to:

```ts
export interface OpenClawFsBridgeLeaseContext
```

Rename:

```ts
export interface GondolinFsBridge
```

to:

```ts
export interface OpenClawSandboxFsBridge
```

Update `CreateBackendDependencies`:

```ts
readonly createFsBridgeBuilder?: (
	leaseContext: OpenClawFsBridgeLeaseContext,
) => (params: { readonly sandbox: unknown }) => OpenClawSandboxFsBridge;
```

Update `GondolinSandboxBackendHandle`:

```ts
createFsBridge?: (params: { readonly sandbox: unknown }) => OpenClawSandboxFsBridge;
```

Do not create a `ToolVmSshFsBridge` type.

- [ ] **Step 4: Update OpenClaw dependency imports**

In `packages/openclaw-agent-vm-plugin/src/openclaw-backend-dependencies.ts`, replace:

```ts
	FsBridgeLeaseContext,
	GondolinFsBridge,
```

with:

```ts
	OpenClawFsBridgeLeaseContext,
	OpenClawSandboxFsBridge,
```

Update return types:

```ts
readonly createFsBridgeBuilder: (
	leaseContext: OpenClawFsBridgeLeaseContext,
) => (params: { readonly sandbox: unknown }) => OpenClawSandboxFsBridge;
```

- [ ] **Step 5: Update active-use wrapper type**

In `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`, update:

```ts
const boundRunRemoteShellScript: OpenClawFsBridgeLeaseContext['runRemoteShellScript'] = async (
	shellParams,
) => ...
```

Keep the existing active-use correlation:

```ts
{
	sessionKey: options.sessionKey,
	toolName: 'fs-bridge',
}
```

- [ ] **Step 6: Run focused plugin tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

Only commit if the human explicitly asked for git writes in the execution session.

```bash
git add packages/openclaw-agent-vm-plugin/src
git commit \
	-m "refactor: keep OpenClaw filesystem bridge adapter-local" \
	-m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 5: Document the Transport Boundary and Patch Gate

**Files:**

- Modify: `docs/subsystems/gondolin-vm-layer.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts`

- [ ] **Step 1: Update the live cross-VM SSH test comments**

Modify the top comment in `packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts`:

```ts
/**
 * Live cross-VM SSH test.
 *
 * This validates the OpenClaw Tool VM data path:
 *
 *   gateway VM ssh client
 *     -> Gondolin tcp.hosts mapped TCP
 *     -> host-local vm.enableSsh() listener
 *     -> Tool VM sshd
 *
 * The controller issues the SSH lease/capability, but command stdout/stderr do
 * not flow through controller HTTP. This test is the quality gate for the local
 * Gondolin mapped-TCP/SSH classification patch. If upstream Gondolin changes
 * mapped TCP handling, run this test with the patch removed before deleting it.
 *
 * Run: mise exec -- pnpm vitest run packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts
 * Requires: QEMU and Gondolin guest assets.
 */
```

Move all imports to the top of the file in this order:

```ts
import fs from 'node:fs/promises';

import { createManagedVm, type ManagedVm } from '@agent-vm/gondolin-adapter';
import { afterAll, describe, expect, it } from 'vitest';
```

Replace the sync file read:

```ts
const identityPem = fs.readFileSync(toolSsh.identityFile, 'utf-8');
```

with:

```ts
const identityPem = await fs.readFile(toolSsh.identityFile, 'utf-8');
```

- [ ] **Step 2: Run the live test only when the environment is ready**

Run:

```bash
mise exec -- pnpm vitest run packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts
```

Expected when QEMU/Gondolin assets are available: pass.

If it fails with a guest readiness timeout, record that exact failure in the implementation notes and do not treat it as a type or architecture failure.

- [ ] **Step 3: Document transport modes in the Gondolin VM layer doc**

Add this section to `docs/subsystems/gondolin-vm-layer.md` after the current `tcpHosts` section:

```md
### agent-vm Execution Paths

agent-vm uses different execution paths for different authority boundaries. This
plan adds the shared `VmCapabilityLease<TTransport>` base, generic SSH endpoint
types, and the current `ToolVmSshLease` specialization. Credentialed runner and
macOS bridge execution backends remain follow-up designs.

Only `ssh-sandbox` is implemented by this plan. `gondolin-rpc` and
`ingress-service` are reserved names for future capability work and should not
be treated as delivered lease transports.

`gondolin-rpc` is controller-owned execution. The controller holds the
`ManagedVm` object and calls Gondolin `vm.exec()` or `vm.fs`. This is the
preferred path for controlled, typed work such as credentialed CLI execution,
where the controller validates schema input and builds argv arrays.

`ssh-sandbox` is VM-to-VM SSH over `tcpHosts`. The controller creates or reuses
the Tool VM, calls `enableSsh()`, and returns an SSH capability to the gateway.
The gateway performs command I/O over SSH; controller HTTP is not the command
data plane. The reusable contract is the SSH lease, not a generic filesystem
API.

`ingress-service` is for warm HTTP services inside a VM. Gondolin exposes the
guest service through `enableIngress()`, but agent-vm must still start and
supervise that service deliberately. Do not use ingress to recreate generic
exec or filesystem RPC when `vm.exec()` and `vm.fs` already fit the workload.

Credentialed runner artifact paths must live in VFS mounts such as `/run-out`.
Do not write artifacts to guest rootfs: Gondolin rootfs file RPC waits for exec
idle, which makes it the wrong storage layer for long-running runner commands.
```

- [ ] **Step 4: Document OpenClaw FS bridge ownership**

Add this paragraph to `docs/architecture/openclaw-gateway.md` in the Tool VM lease / SSH section:

```md
The OpenClaw filesystem bridge is OpenClaw adapter behavior. The shared
agent-vm lease type exposes an SSH capability (`host`, `port`, `user`,
`identityPem`, `knownHostsLine`, `tcpSlot`, and `workdir`), not a generic
filesystem API. The OpenClaw plugin adapts that SSH capability to OpenClaw's
remote-shell FS bridge. Other controlled workloads should use Gondolin `vm.fs`
directly when the controller owns the VM handle.
```

- [ ] **Step 5: Commit**

Only commit if the human explicitly asked for git writes in the execution session.

```bash
git add docs/subsystems/gondolin-vm-layer.md docs/architecture/openclaw-gateway.md packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts
git commit \
	-m "docs: clarify VM transport boundaries" \
	-m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 6: Quality Gate

**Files:**

- No new files.
- This task verifies the whole change.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/tool-vm-lease.test.ts packages/gateway-interface/src/tool-vm-active-use.test.ts packages/gondolin-adapter/src/vm-adapter.test.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run package typecheck**

Run:

```bash
pnpm typecheck
```

Expected: pass with zero TypeScript errors.

- [ ] **Step 3: Run lint**

Run:

```bash
pnpm lint
pnpm lint:types
```

Expected: both pass.

- [ ] **Step 4: Run formatting check**

Run:

```bash
pnpm fmt:check
```

Expected: pass. If it fails, run `pnpm fmt`, inspect the diff, then rerun `pnpm fmt:check`.

- [ ] **Step 5: Run broad unit suite**

Run:

```bash
pnpm test:unit
```

Expected: pass.

- [ ] **Step 6: Run live cross-VM SSH smoke when QEMU is available**

Run:

```bash
mise exec -- pnpm vitest run packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts
```

Expected with local VM tooling ready: pass.

If it fails because guest assets or QEMU are missing, capture the exact failure text in the final implementation report. Do not claim the SSH path is verified.

- [ ] **Step 7: Commit final verification docs or fixes**

Only commit if the human explicitly asked for git writes in the execution session.

```bash
git status --short
git add packages docs
git commit \
	-m "chore: verify Gondolin adapter and Tool VM SSH cleanup" \
	-m "Co-authored-by: Codex <noreply@openai.com>"
```

## Self-Review Checklist

- Spec coverage: the plan covers the adapter widening, SSH capability typing, OpenClaw-owned FS bridge, patch/upstream gate, and documentation.
- Placeholder scan: no `TBD`, no generic "add tests", and no "handle edge cases" instructions without concrete code.
- Type consistency: `VmCapabilityLease`, `VmSshEndpoint`, `ToolVmSshLease`, `ToolVmLeasePeek`, `OpenClawSandboxFsBridge`, and `OpenClawFsBridgeLeaseContext` are the names used throughout.
- Boundary check: no generic `ToolVmSshFsBridge` is introduced.
- Transport check: credentialed runner v1 is explicitly pointed at Gondolin RPC, not SSH FS or runner HTTP.
