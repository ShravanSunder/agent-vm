# Credentialed Runner V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build controller-owned credentialed runner VMs that execute typed, policy-approved CLI calls through native Gondolin `vm.exec()` and `vm.fs`, without SSH, in-VM HTTP listeners, or custom file RPC.

**Architecture:** The controller owns warm runner leases and the `ManagedVm` handle. Agent-facing callers submit typed tool requests to the controller; the controller validates against a catalog, starts an active-use record, executes an argv array through Gondolin, and exposes only structured output or validated VFS artifacts. Maintainer-only credential setup is a separate protected path that can write credential state; agent execution cannot choose shell text, arbitrary argv, or arbitrary filesystem paths.

**Tech Stack:** TypeScript, Hono, Zod, Vitest, `@agent-vm/gondolin-adapter` `ManagedVm`, native Gondolin `ExecProcess` / `VmFs`, `@agent-vm/gateway-interface` `VmCapabilityLease`, `@agent-vm/secret-management`.

---

## Status And Scope

This is the executable follow-up to `2026-05-20-credentialed-tool-system.md`.
That older document remains useful as architecture background, but it predates
the merged Gondolin adapter widening and Tool VM SSH cleanup.

Current prerequisites already landed on `master`:

- `packages/gondolin-adapter/src/vm-adapter.ts` exposes `ManagedVm.exec(command, options)` with Gondolin's native exec options and `ManagedVm.fs` as Gondolin `VmFs`.
- `packages/gateway-interface/src/vm-capability-lease.ts` defines `VmCapabilityLease<TTransport>` and reusable VM SSH endpoint primitives.
- `packages/gateway-interface/src/tool-vm-lease.ts` specializes the current OpenClaw Tool VM transport as `ToolVmSshLease` over `ssh-sandbox`.
- `docs/subsystems/gondolin-vm-layer.md` documents that `gondolin-rpc` is reserved for controller-owned workloads using `ManagedVm`.

This plan implements the first `gondolin-rpc` consumer: credentialed runners.
It does not alter the OpenClaw Tool VM SSH data path.

## System Model

```
  Agent / Gateway
      |
      | typed request only
      v
  Controller HTTP route
      |
      | validate catalog + policy
      | start runner active use + audit run
      | native Gondolin RPC
      v
  Warm credentialed runner VM
      |
      | argv array, no shell
      | provider egress only
      v
  Provider APIs

  Artifacts:
      runner writes /run-out/<runId>/<declaredName>
      controller reads through ManagedVm.fs or host VFS provider
```

## Non-Negotiable Boundaries

1. No SSH for credentialed runners.
2. No HTTP server, MCP server, or other listener inside the runner VM.
3. No custom controller-to-runner RPC. Use native Gondolin `ManagedVm.exec()` and `ManagedVm.fs`.
4. No string shell execution for agent-callable runs. Use argv arrays only.
5. No caller-supplied argv. The controller builds argv from a typed catalog.
6. No arbitrary caller-supplied paths. Inputs, outputs, and credential state use named mounts only.
7. Artifacts must live under VFS mounts, especially `/run-out/<runId>`. Do not use guest rootfs paths such as `/tmp/output.json` for artifacts.
8. Maintainer credential setup is protected and separate from agent execution.
9. Agent execution cannot write `/cred`.
10. Audit events record metadata, hashes, counts, sizes, and outcomes; they never record secret values.
11. The controller remains the control plane and the execution owner. Bytes may pass through process streams, but there is no reusable generic file proxy.
12. Piped Gondolin stdout/stderr must be actively drained while the process runs. `await process` is not a drain loop.
13. V1 does not implement interactive PTY maintainer auth over HTTP. Maintainer commands must be non-interactive, fixed argv operations; interactive auth is a later duplex-transport plan.

## Transport Relationship

```
  Transport       Current consumer             Data path
  ---------       ----------------             ---------
  ssh-sandbox     OpenClaw Tool VM             gateway VM -> Tool VM SSH
  gondolin-rpc    Credentialed runner v1       controller -> ManagedVm.exec/fs
  ingress-service reserved                     host -> VM HTTP ingress
```

`ToolVmSshLease` stays as the SSH wire contract for OpenClaw. Credentialed
runners introduce a controller-internal `CredentialRunnerLease` because its
capability is the host-side `ManagedVm`, which is not serializable to a gateway.

## Review-Hardened Decisions

The adversarial review of the first draft found several real plan bugs. This
plan intentionally chooses the following corrections:

- Agent execution drains `ExecProcess.output()` while awaiting the process. It
  counts bytes, enforces per-stream caps, and records truncation. It never
  relies on `ExecResult.stdout` or `ExecResult.stderr` when `stdout: 'pipe'`,
  `stderr: 'pipe'`, and `buffer: false` are used.
- `CredentialRunnerActiveUse` is a runner-owned lifecycle, not an import of the
  Tool VM named helper. The shape mirrors Tool VM active-use behavior, but the
  type names live under `@agent-vm/credential-runner`.
- `runId` and `activeUseId` are different ids. `runId` names the run and
  artifact namespace; `activeUseId` names the lease-liveness claim. Audit
  records join them.
- `argvHash` is `sha256(JSON.stringify(argv))`, hex encoded.
- `redactionCount` is not part of v1 audit because v1 does not implement a
  redaction pipeline.
- `/cred` is durable secret state under zone `stateDir`, created with mode
  `0700`, and included in normal encrypted zone backups.
- V1 only supports `stateScope: 'profile-provider'`. Sharing one credential
  directory across providers is not safe enough for this slice.
- Artifact symlink rejection is not claimed in v1 because Gondolin `VmFs`
  exposes `stat()` but not `lstat()`. V1 relies on memory-backed `/run-out`,
  strict path validation, and regular-file checks via `stat()`.
- Maintainer setup does not use `pty: true` or `stdin: true` in v1. If a
  provider requires interactive OAuth, that provider is not supported until a
  separate duplex maintainer plan exists.
- Credential runner egress uses zone `egressHosts` with a new
  `credential-runner` audience. Provider definitions may declare required hosts
  for validation, but they are not a second allowlist source.
- Runner VFS mount keys are expected to be shortcut bind-mounted at their
  literal guest paths (`/cred`, `/run-in`, `/run-out`, `/scratch`) by the
  Gondolin adapter, even though the underlying FUSE mount is `/data`.

## File Structure

Create a new package for catalog, run, artifact, and policy types:

- `packages/credential-runner/package.json` - workspace package metadata.
- `packages/credential-runner/src/index.ts` - public exports.
- `packages/credential-runner/src/catalog.ts` - typed tool catalog and argv builders.
- `packages/credential-runner/src/credential-runner-lease.ts` - `gondolin-rpc` lease type that composes `ManagedVm`.
- `packages/credential-runner/src/credential-runner-active-use.ts` - runner-owned active-use ids and request/response contracts.
- `packages/credential-runner/src/run-records.ts` - run ids, audit event types, output summaries.
- `packages/credential-runner/src/output-drain.ts` - Gondolin `ExecProcess.output()` drain helper and byte caps.
- `packages/credential-runner/src/artifact-policy.ts` - artifact path and size validation.
- `packages/credential-runner/src/catalog.test.ts` - catalog validation tests.
- `packages/credential-runner/src/output-drain.test.ts` - streaming byte count and truncation tests.
- `packages/credential-runner/src/artifact-policy.test.ts` - artifact validation tests.
- `packages/credential-runner/tsconfig.json` - package typecheck config.
- `packages/credential-runner/tsdown.config.ts` - build config.

Add controller implementation under `agent-vm` because the controller owns
`ManagedVm` instances:

- `packages/agent-vm/src/controller/credential-runners/credential-runner-vm-spec.ts` - create runner VM options and VFS layout.
- `packages/agent-vm/src/controller/credential-runners/credential-runner-lease-manager.ts` - warm runner lease lifecycle.
- `packages/agent-vm/src/controller/credential-runners/credential-runner-executor.ts` - active-use wrapped `ManagedVm.exec()` runner.
- `packages/agent-vm/src/controller/credential-runners/credential-runner-artifacts.ts` - VFS artifact inspection and streaming helpers.
- `packages/agent-vm/src/controller/credential-runners/credential-runner-runtime.ts` - controller-runtime assembly, reaper, and teardown wiring.
- `packages/agent-vm/src/controller/http/credential-runner-routes.ts` - Hono routes for maintainer setup and agent execution.
- `packages/agent-vm/src/controller/http/credential-runner-routes.test.ts` - route-level tests.
- `packages/agent-vm/src/controller/credential-runners/*.test.ts` - controller unit tests.

Update shared configuration and docs:

- `packages/gateway-interface/src/audience.ts` - add the `credential-runner` runtime audience.
- `packages/gateway-interface/src/gateway-runtime-contract.ts` - add `buildCredentialRunnerSessionLabel`.
- `packages/agent-vm/src/config/system-config.ts` - credential runner profile config.
- `packages/agent-vm/src/config/system-config.test.ts` - config validation tests.
- `packages/agent-vm/src/controller/http/controller-http-route-support.ts` - route operation interface extension.
- `packages/agent-vm/src/controller/http/controller-http-routes.ts` - register credential runner routes.
- `docs/subsystems/credentialed-runners.md` - operator and maintainer model.
- `docs/subsystems/gondolin-vm-layer.md` - link `gondolin-rpc` to credentialed runner v1.
- `docs/README.md` - docs map entry.
- `docs/superpowers/plans/README.md` - mark this plan as the credentialed runner executable plan.

## Core Types

Add a host-side capability handle type without changing the existing SSH wire
lease shape:

```ts
// packages/gateway-interface/src/vm-capability-lease.ts
export interface VmCapabilityHandle<TTransport extends string, TCapability>
	extends VmCapabilityLease<TTransport> {
	readonly capability: TCapability;
}
```

Credentialed runner leases compose real adapter types:

```ts
// packages/credential-runner/src/credential-runner-lease.ts
import type { VmCapabilityHandle } from '@agent-vm/gateway-interface';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';

export type CredentialRunnerTransport = 'gondolin-rpc';

export interface CredentialRunnerVfsLayout {
	readonly cred: '/cred';
	readonly runIn: '/run-in';
	readonly runOut: '/run-out';
	readonly scratch: '/scratch';
}

export interface CredentialRunnerCapability {
	readonly managedVm: ManagedVm;
	readonly profileId: string;
	readonly providerId: string;
	readonly stateScope: 'profile-provider';
	readonly vfs: CredentialRunnerVfsLayout;
}

export interface CredentialRunnerLease
	extends VmCapabilityHandle<CredentialRunnerTransport, CredentialRunnerCapability> {
	readonly createdAt: number;
	readonly effectiveIdleTtlMs: number;
	readonly lastUsedAt: number;
}
```

Runner active-use contracts stay in the credential-runner vocabulary:

```ts
// packages/credential-runner/src/credential-runner-active-use.ts
import { v7 as uuidv7, validate as validateUuid, version as uuidVersion } from 'uuid';

export type CredentialRunnerActiveUseOutcome =
	| 'abandoned'
	| 'cancelled'
	| 'completed'
	| 'failed'
	| 'timed-out';

export interface CredentialRunnerActiveUseCorrelation {
	readonly agentId?: string;
	readonly runId: string;
	readonly sessionId?: string;
	readonly sessionKey?: string;
	readonly toolCallId?: string;
	readonly toolName: string;
}

export interface StartCredentialRunnerActiveUseRequest {
	readonly correlation: CredentialRunnerActiveUseCorrelation;
	readonly useId: string;
}

export interface EndCredentialRunnerActiveUseRequest {
	readonly outcome: CredentialRunnerActiveUseOutcome;
}

export function createCredentialRunnerActiveUseId(): string {
	return uuidv7();
}

export function isCredentialRunnerActiveUseId(value: string): boolean {
	return validateUuid(value) && uuidVersion(value) === 7;
}
```

Catalog entries build argv arrays. The agent never supplies argv:

```ts
// packages/credential-runner/src/catalog.ts
import { z } from 'zod';

export interface CredentialRunnerTool<TArgsSchema extends z.ZodType> {
	readonly argsSchema: TArgsSchema;
	readonly name: string;
	buildArgv(args: z.infer<TArgsSchema>, context: CredentialRunnerCommandContext): readonly string[];
}

export interface CredentialRunnerCommandContext {
	readonly credentialDir: '/cred';
	readonly runInputDir: `/run-in/${string}`;
	readonly runOutputDir: `/run-out/${string}`;
	readonly scratchDir: `/scratch/${string}`;
}
```

Run records carry correlation across lease, active use, exec, artifacts, and
response:

```ts
// packages/credential-runner/src/run-records.ts
export interface CredentialRunnerOutputSummary {
	readonly bytes: number;
	readonly truncated: boolean;
}

export interface CredentialRunnerAuditEvent {
	readonly activeUseId: string;
	readonly artifactCount: number;
	readonly argvHash: string;
	readonly durationMs: number;
	readonly exitCode: number | null;
	readonly profileId: string;
	readonly providerId: string;
	readonly runId: string;
	readonly stderr: CredentialRunnerOutputSummary;
	readonly stdout: CredentialRunnerOutputSummary;
	readonly toolName: string;
}
```

Output draining is explicit. This is the load-bearing Gondolin rule for v1:

```ts
// packages/credential-runner/src/output-drain.ts
import { createHash } from 'node:crypto';

import type { ManagedExecProcess } from '@agent-vm/gondolin-adapter';

import type { CredentialRunnerOutputSummary } from './run-records.js';

export interface CredentialRunnerOutputCaps {
	readonly stderrMaxBytes: number;
	readonly stdoutMaxBytes: number;
}

export interface DrainedCredentialRunnerOutput {
	readonly stderr: CredentialRunnerOutputSummary;
	readonly stdout: CredentialRunnerOutputSummary;
}

export function hashCredentialRunnerArgv(argv: readonly string[]): string {
	return createHash('sha256').update(JSON.stringify(argv)).digest('hex');
}

export async function drainCredentialRunnerOutput(
	process: ManagedExecProcess,
	caps: CredentialRunnerOutputCaps,
): Promise<DrainedCredentialRunnerOutput> {
	let stderrBytes = 0;
	let stdoutBytes = 0;
	let stderrTruncated = false;
	let stdoutTruncated = false;

	for await (const chunk of process.output()) {
		const byteLength = chunk.data.byteLength;
		if (chunk.stream === 'stdout') {
			stdoutBytes += byteLength;
			stdoutTruncated = stdoutTruncated || stdoutBytes > caps.stdoutMaxBytes;
		} else {
			stderrBytes += byteLength;
			stderrTruncated = stderrTruncated || stderrBytes > caps.stderrMaxBytes;
		}
	}

	return {
		stderr: { bytes: Math.min(stderrBytes, caps.stderrMaxBytes), truncated: stderrTruncated },
		stdout: { bytes: Math.min(stdoutBytes, caps.stdoutMaxBytes), truncated: stdoutTruncated },
	};
}
```

## Task 1: Package Skeleton And Catalog Contract

**Files:**
- Create: `packages/credential-runner/package.json`
- Create: `packages/credential-runner/tsconfig.json`
- Create: `packages/credential-runner/tsdown.config.ts`
- Create: `packages/credential-runner/src/index.ts`
- Create: `packages/credential-runner/src/catalog.ts`
- Test: `packages/credential-runner/src/catalog.test.ts`

- [ ] **Step 1: Write the failing catalog tests**

```ts
// packages/credential-runner/src/catalog.test.ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createCredentialRunnerCatalog } from './catalog.js';

describe('createCredentialRunnerCatalog', () => {
	it('builds argv from a typed catalog entry and not from caller input', () => {
		const catalog = createCredentialRunnerCatalog([
			{
				name: 'google.calendar.list_events',
				argsSchema: z.object({ calendarId: z.string().min(1), maxResults: z.number().int().min(1).max(50) }),
				buildArgv: (args, context) => [
					'/usr/local/bin/gog',
					'calendar',
					'events',
					'list',
					'--calendar',
					args.calendarId,
					'--max-results',
					String(args.maxResults),
					'--credential-dir',
					context.credentialDir,
					'--json',
				],
			},
		]);

		const command = catalog.buildCommand({
			args: { calendarId: 'primary', maxResults: 20 },
			context: {
				credentialDir: '/cred',
				runInputDir: '/run-in/018f',
				runOutputDir: '/run-out/018f',
				scratchDir: '/scratch/018f',
			},
			toolName: 'google.calendar.list_events',
		});

		expect(command.argv).toEqual([
			'/usr/local/bin/gog',
			'calendar',
			'events',
			'list',
			'--calendar',
			'primary',
			'--max-results',
			'20',
			'--credential-dir',
			'/cred',
			'--json',
		]);
	});

	it('rejects unknown tools', () => {
		const catalog = createCredentialRunnerCatalog([]);

		expect(() =>
			catalog.buildCommand({
				args: {},
				context: {
					credentialDir: '/cred',
					runInputDir: '/run-in/018f',
					runOutputDir: '/run-out/018f',
					scratchDir: '/scratch/018f',
				},
				toolName: 'shell.run',
			}),
		).toThrow("Unknown credential runner tool 'shell.run'.");
	});

	it('rejects catalog entries that try to execute a shell binary', () => {
		const catalog = createCredentialRunnerCatalog([
			{
				name: 'unsafe.shell',
				argsSchema: z.object({}),
				buildArgv: () => ['/bin/sh', '-c', 'echo unsafe'],
			},
		]);

		expect(() =>
			catalog.buildCommand({
				args: {},
				context: {
					credentialDir: '/cred',
					runInputDir: '/run-in/018f',
					runOutputDir: '/run-out/018f',
					scratchDir: '/scratch/018f',
				},
				toolName: 'unsafe.shell',
			}),
		).toThrow("Credential runner tool 'unsafe.shell' cannot execute shell binary '/bin/sh'.");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/credential-runner/src/catalog.test.ts`

Expected: FAIL with module not found for `./catalog.js`.

- [ ] **Step 3: Implement the package and catalog**

```json
// packages/credential-runner/package.json
{
	"name": "@agent-vm/credential-runner",
	"version": "0.0.71",
	"description": "Typed credentialed runner catalog, policy, and lease contracts for agent-vm.",
	"homepage": "https://github.com/ShravanSunder/agent-vm#readme",
	"bugs": {
		"url": "https://github.com/ShravanSunder/agent-vm/issues"
	},
	"license": "MIT",
	"author": "Shravan Sunder <ShravanSunder@users.noreply.github.com>",
	"repository": {
		"type": "git",
		"url": "git+https://github.com/ShravanSunder/agent-vm.git",
		"directory": "packages/credential-runner"
	},
	"files": ["dist"],
	"type": "module",
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js"
		}
	},
	"publishConfig": {
		"access": "public"
	},
	"scripts": {
		"build": "tsdown",
		"prepack": "pnpm -C ../.. build",
		"typecheck": "tsc -p tsconfig.json --noEmit"
	},
	"dependencies": {
		"@agent-vm/gateway-interface": "workspace:*",
		"@agent-vm/gondolin-adapter": "workspace:*",
		"uuid": "^11.1.1",
		"zod": "^4.2.1"
	},
	"devDependencies": {
		"vitest": "^4.1.5"
	}
}
```

```json
// packages/credential-runner/tsconfig.json
{
	"extends": "../../tsconfig.json",
	"compilerOptions": {
		"rootDir": "src",
		"outDir": "dist"
	},
	"include": ["src/**/*.ts"]
}
```

```ts
// packages/credential-runner/tsdown.config.ts
import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	dts: true,
	format: ['esm'],
});
```

```ts
// packages/credential-runner/src/catalog.ts
import { z } from 'zod';

export interface CredentialRunnerCommandContext {
	readonly credentialDir: '/cred';
	readonly runInputDir: `/run-in/${string}`;
	readonly runOutputDir: `/run-out/${string}`;
	readonly scratchDir: `/scratch/${string}`;
}

export interface CredentialRunnerTool<TArgsSchema extends z.ZodType> {
	readonly argsSchema: TArgsSchema;
	readonly name: string;
	buildArgv(args: z.infer<TArgsSchema>, context: CredentialRunnerCommandContext): readonly string[];
}

export interface BuildCredentialRunnerCommandRequest {
	readonly args: unknown;
	readonly context: CredentialRunnerCommandContext;
	readonly toolName: string;
}

export interface CredentialRunnerCommand {
	readonly argv: readonly string[];
	readonly toolName: string;
}

export interface CredentialRunnerCatalog {
	buildCommand(request: BuildCredentialRunnerCommandRequest): CredentialRunnerCommand;
}

const deniedCredentialRunnerBinaries = new Set([
	'/bin/bash',
	'/bin/sh',
	'/usr/bin/bash',
	'bash',
	'sh',
]);

function assertAllowedCredentialRunnerArgv(toolName: string, argv: readonly string[]): void {
	const executable = argv[0];
	if (!executable) {
		throw new Error(`Credential runner tool '${toolName}' built an empty argv.`);
	}
	if (deniedCredentialRunnerBinaries.has(executable)) {
		throw new Error(`Credential runner tool '${toolName}' cannot execute shell binary '${executable}'.`);
	}
	if (executable === '/usr/bin/env' && ['bash', 'sh'].includes(argv[1] ?? '')) {
		throw new Error(`Credential runner tool '${toolName}' cannot execute shell binary '/usr/bin/env ${argv[1]}'.`);
	}
}

export function createCredentialRunnerCatalog(
	tools: readonly CredentialRunnerTool<z.ZodType>[],
): CredentialRunnerCatalog {
	const toolsByName = new Map<string, CredentialRunnerTool<z.ZodType>>();
	for (const tool of tools) {
		if (toolsByName.has(tool.name)) {
			throw new Error(`Duplicate credential runner tool '${tool.name}'.`);
		}
		toolsByName.set(tool.name, tool);
	}

	return {
		buildCommand(request: BuildCredentialRunnerCommandRequest): CredentialRunnerCommand {
			const tool = toolsByName.get(request.toolName);
			if (!tool) {
				throw new Error(`Unknown credential runner tool '${request.toolName}'.`);
			}
			const parsedArgs = tool.argsSchema.parse(request.args);
			const argv = tool.buildArgv(parsedArgs, request.context);
			assertAllowedCredentialRunnerArgv(request.toolName, argv);
			return {
				argv,
				toolName: request.toolName,
			};
		},
	};
}
```

```ts
// packages/credential-runner/src/index.ts
export * from './catalog.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/credential-runner/src/catalog.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/credential-runner
git commit -m "feat: add credential runner catalog contract" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 2: Gondolin-RPC Lease Types

**Files:**
- Modify: `packages/gateway-interface/src/vm-capability-lease.ts`
- Modify: `packages/gateway-interface/src/index.ts`
- Create: `packages/credential-runner/src/credential-runner-lease.ts`
- Modify: `packages/credential-runner/src/index.ts`
- Test: `packages/credential-runner/src/credential-runner-lease.test.ts`

- [ ] **Step 1: Write the failing type and runtime tests**

```ts
// packages/credential-runner/src/credential-runner-lease.test.ts
import { describe, expect, it, vi } from 'vitest';

import { isCredentialRunnerLease } from './credential-runner-lease.js';

describe('CredentialRunnerLease', () => {
	it('accepts a gondolin-rpc lease with a ManagedVm capability', () => {
		const managedVm = {
			id: 'runner-vm',
			fs: {},
			exec: vi.fn(),
			enableIngress: vi.fn(),
			enableSsh: vi.fn(),
			getVmInstance: vi.fn(),
			setIngressRoutes: vi.fn(),
			close: vi.fn(),
		};

		expect(
			isCredentialRunnerLease({
				capability: {
					managedVm,
					profileId: 'default',
					providerId: 'google',
					stateScope: 'profile-provider',
					vfs: { cred: '/cred', runIn: '/run-in', runOut: '/run-out', scratch: '/scratch' },
				},
				createdAt: 1,
				effectiveIdleTtlMs: 30_000,
				lastUsedAt: 1,
				leaseId: 'lease-1',
				transport: 'gondolin-rpc',
			}),
		).toBe(true);
	});

	it('rejects SSH leases because the credential runner is not an SSH transport', () => {
		expect(
			isCredentialRunnerLease({
				capability: {},
				createdAt: 1,
				effectiveIdleTtlMs: 30_000,
				lastUsedAt: 1,
				leaseId: 'lease-1',
				transport: 'ssh-sandbox',
			}),
		).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/credential-runner/src/credential-runner-lease.test.ts`

Expected: FAIL with module not found for `./credential-runner-lease.js`.

- [ ] **Step 3: Add the generic host-side handle and runner lease**

```ts
// packages/gateway-interface/src/vm-capability-lease.ts
export interface VmCapabilityHandle<TTransport extends string, TCapability>
	extends VmCapabilityLease<TTransport> {
	readonly capability: TCapability;
}
```

```ts
// packages/credential-runner/src/credential-runner-lease.ts
import type { VmCapabilityHandle } from '@agent-vm/gateway-interface';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';

export type CredentialRunnerTransport = 'gondolin-rpc';

export interface CredentialRunnerVfsLayout {
	readonly cred: '/cred';
	readonly runIn: '/run-in';
	readonly runOut: '/run-out';
	readonly scratch: '/scratch';
}

export interface CredentialRunnerCapability {
	readonly managedVm: ManagedVm;
	readonly profileId: string;
	readonly providerId: string;
	readonly stateScope: 'profile-provider';
	readonly vfs: CredentialRunnerVfsLayout;
}

export interface CredentialRunnerLease
	extends VmCapabilityHandle<CredentialRunnerTransport, CredentialRunnerCapability> {
	readonly createdAt: number;
	readonly effectiveIdleTtlMs: number;
	readonly lastUsedAt: number;
}

function objectValue(value: unknown): object | undefined {
	return typeof value === 'object' && value !== null ? value : undefined;
}

function isCredentialRunnerCapability(value: unknown): value is CredentialRunnerCapability {
	const record = objectValue(value);
	const vfs = objectValue(Reflect.get(record ?? {}, 'vfs'));
	return (
		record !== undefined &&
		objectValue(Reflect.get(record, 'managedVm')) !== undefined &&
		typeof Reflect.get(record, 'profileId') === 'string' &&
		typeof Reflect.get(record, 'providerId') === 'string' &&
		Reflect.get(record, 'stateScope') === 'profile-provider' &&
		vfs !== undefined &&
		Reflect.get(vfs, 'cred') === '/cred' &&
		Reflect.get(vfs, 'runIn') === '/run-in' &&
		Reflect.get(vfs, 'runOut') === '/run-out' &&
		Reflect.get(vfs, 'scratch') === '/scratch'
	);
}

export function isCredentialRunnerLease(value: unknown): value is CredentialRunnerLease {
	const record = objectValue(value);
	return (
		record !== undefined &&
		Reflect.get(record, 'transport') === 'gondolin-rpc' &&
		typeof Reflect.get(record, 'leaseId') === 'string' &&
		isCredentialRunnerCapability(Reflect.get(record, 'capability')) &&
		typeof Reflect.get(record, 'createdAt') === 'number' &&
		typeof Reflect.get(record, 'effectiveIdleTtlMs') === 'number' &&
		typeof Reflect.get(record, 'lastUsedAt') === 'number'
	);
}
```

```ts
// packages/gateway-interface/src/index.ts
export type {
	VmCapabilityHandle,
	VmCapabilityLease,
	VmSshEndpoint,
	VmSshLease,
	VmSshPublicEndpoint,
} from './vm-capability-lease.js';
```

```ts
// packages/credential-runner/src/index.ts
export * from './artifact-policy.js';
export * from './catalog.js';
export * from './credential-runner-active-use.js';
export * from './credential-runner-lease.js';
export * from './output-drain.js';
export * from './run-records.js';
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm vitest run packages/credential-runner/src/credential-runner-lease.test.ts && pnpm --filter @agent-vm/credential-runner typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-interface/src packages/credential-runner/src
git commit -m "feat: define credential runner gondolin-rpc lease" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 3: System Config For Runner Profiles

**Files:**
- Modify: `packages/gateway-interface/src/audience.ts`
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `packages/agent-vm/src/config/system-config.test.ts`

- [ ] **Step 1: Write failing config tests**

Add tests that prove:

```ts
expect(config.credentialRunners.profiles.default.vfs.cred).toBe('/cred');
expect(config.credentialRunners.providers.google.requiredHosts).toEqual([
	'accounts.google.com',
	'www.googleapis.com',
]);
expect(config.zones[0].egressHosts).toContainEqual({
	audience: 'credential-runner',
	host: 'www.googleapis.com',
});
```

and prove invalid config rejects:

```ts
await expect(loadSystemConfig(configPath)).rejects.toThrow(
	/credential runner artifacts must use the fixed VFS mount '\/run-out'/u,
);
await expect(loadSystemConfig(configPath)).rejects.toThrow(
	/credential runner stateScope must be 'profile-provider'/u,
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/agent-vm/src/config/system-config.test.ts`

Expected: FAIL because `credentialRunners` is not parsed.

- [ ] **Step 3: Add credential runner schemas**

Add `credential-runner` as a first-class runtime audience and add a strict
optional top-level `credentialRunners` object:

```ts
// packages/gateway-interface/src/audience.ts
export const vmAudienceValues = ['gateway', 'tool-vm', 'credential-runner', 'both'] as const;
```

```ts
const credentialRunnerVfsSchema = z
	.object({
		cred: z.literal('/cred').default('/cred'),
		runIn: z.literal('/run-in').default('/run-in'),
		runOut: z.literal('/run-out').default('/run-out'),
		scratch: z.literal('/scratch').default('/scratch'),
	})
	.strict()
	.default({});

const credentialRunnerProfileSchema = z
	.object({
		cpus: z.number().int().min(1).default(1),
		imageProfile: z.string().min(1),
		memory: z.string().min(1).default('1G'),
		rootfsMode: z.literal('memory').default('memory'),
		stateScope: z.literal('profile-provider').default('profile-provider'),
		vfs: credentialRunnerVfsSchema,
	})
	.strict();

const credentialRunnerProviderSchema = z
	.object({
		defaultProfileId: z.string().min(1),
		requiredHosts: z.array(z.string().min(1)).min(1),
	})
	.strict();
```

Provider `requiredHosts` is a validation aid only. The VM egress allowlist comes
from the zone's `egressHosts` entries that target audience
`credential-runner` or `both`; if a provider's `requiredHosts` are not covered
by zone egress, config loading must fail loudly.

- [ ] **Step 4: Run config tests**

Run: `pnpm vitest run packages/agent-vm/src/config/system-config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-interface/src/audience.ts packages/agent-vm/src/config/system-config.ts packages/agent-vm/src/config/system-config.test.ts
git commit -m "feat: add credential runner system config" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 4: Runner VM Spec Builder

**Files:**
- Modify: `packages/gateway-interface/src/gateway-runtime-contract.ts`
- Modify: `packages/gateway-interface/src/index.ts`
- Create: `packages/agent-vm/src/controller/credential-runners/credential-runner-vm-spec.ts`
- Test: `packages/agent-vm/src/controller/credential-runners/credential-runner-vm-spec.test.ts`

- [ ] **Step 1: Write failing VM spec tests**

Assert the generated `CreateVmOptions` has:

```ts
expect(vmOptions.rootfsMode).toBe('memory');
expect(vmOptions.vfsMounts).toHaveProperty('/cred');
expect(vmOptions.vfsMounts).toHaveProperty('/run-in');
expect(vmOptions.vfsMounts).toHaveProperty('/run-out');
expect(vmOptions.vfsMounts).toHaveProperty('/scratch');
expect(vmOptions.tcpHosts).toBeUndefined();
expect(vmOptions.allowedHosts).toEqual(['accounts.google.com', 'www.googleapis.com']);
expect(vmOptions.sessionLabel).toBe('claw-tests-a1b2c3d4:sunfam:credential-runner:default:google');
expect(resolveCredentialRunnerStateDir({
	profileId: 'default',
	providerId: 'google',
	stateDir: '/var/lib/agent-vm/state/sunfam',
})).toBe('/var/lib/agent-vm/state/sunfam/credential-runners/default/google');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/controller/credential-runners/credential-runner-vm-spec.test.ts`

Expected: FAIL with module not found for `credential-runner-vm-spec.js`.

- [ ] **Step 3: Implement VM spec creation**

Create a session-label helper next to the existing gateway/tool helpers:

```ts
// packages/gateway-interface/src/gateway-runtime-contract.ts
export function buildCredentialRunnerSessionLabel(
	projectNamespace: string,
	zoneId: string,
	profileId: string,
	providerId: string,
): string {
	return `${projectNamespace}:${zoneId}:credential-runner:${profileId}:${providerId}`;
}
```

Then create the VM spec functions:

```ts
export function buildCredentialRunnerVmOptions(
	options: BuildCredentialRunnerVmOptionsRequest,
): CreateVmOptions {
	return {
		allowedHosts: [...options.allowedHosts],
		cpus: options.profile.cpus,
		env: {
			AGENT_VM_CREDENTIAL_RUNNER: '1',
			AGENT_VM_CREDENTIAL_RUNNER_PROVIDER: options.providerId,
		},
		imagePath: options.imagePath,
		memory: options.profile.memory,
		rootfsMode: 'memory',
		secrets: {},
		sessionLabel: buildCredentialRunnerSessionLabel(
			options.projectNamespace,
			options.zoneId,
			options.profileId,
			options.providerId,
		),
		vfsMounts: {
			'/cred': { kind: 'realfs', hostPath: options.credentialStateDir },
			'/run-in': { kind: 'memory' },
			'/run-out': { kind: 'memory' },
			'/scratch': { kind: 'memory' },
		},
	};
}

export function resolveCredentialRunnerStateDir(options: {
	readonly profileId: string;
	readonly providerId: string;
	readonly stateDir: string;
}): string {
	return path.join(
		options.stateDir,
		'credential-runners',
		options.profileId,
		options.providerId,
	);
}
```

`credentialStateDir` must be created with `mkdir(..., { recursive: true, mode:
0o700 })` before VM creation. It is durable credential state under zone
`stateDir`, not `cacheDir` and not `runtimeDir`.

- [ ] **Step 4: Run VM spec tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/credential-runners/credential-runner-vm-spec.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-interface/src/gateway-runtime-contract.ts packages/gateway-interface/src/index.ts packages/agent-vm/src/controller/credential-runners/credential-runner-vm-spec.ts packages/agent-vm/src/controller/credential-runners/credential-runner-vm-spec.test.ts
git commit -m "feat: build credential runner VM specs" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 5: Warm Runner Lease Manager

**Files:**
- Create: `packages/agent-vm/src/controller/credential-runners/credential-runner-lease-manager.ts`
- Test: `packages/agent-vm/src/controller/credential-runners/credential-runner-lease-manager.test.ts`

- [ ] **Step 1: Write failing lease manager tests**

Cover:

```ts
expect(firstLease.leaseId).toBe(secondLease.leaseId);
expect(secondLease.lastUsedAt).toBeGreaterThan(firstLease.lastUsedAt);
await expect(
	manager.createLease({ ...sameScope, profileId: 'different-profile' }),
).rejects.toThrow(/credential runner lease scope conflict/u);

const activeUse = manager.startActiveUse(firstLease.leaseId, {
	correlation: {
		runId: '01900000-0000-7000-8000-000000000001',
		toolName: 'google.calendar.list_events',
	},
	useId: '01900000-0000-7000-8000-000000000002',
});
expect(activeUse).toEqual(expect.objectContaining({ useId: '01900000-0000-7000-8000-000000000002' }));

expect(() => manager.beginMaintenance(firstLease.leaseId)).toThrow(/active credential runner uses/u);
```

Also add tests that prove:

```ts
await manager.reapExpiredLeases();
expect(closeVm).toHaveBeenCalledTimes(1);

await expect(manager.releaseLease(firstLease.leaseId)).rejects.toThrow(/active credential runner uses/u);
await manager.releaseLease(firstLease.leaseId, { force: true });
expect(closeVm).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/controller/credential-runners/credential-runner-lease-manager.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement lease manager**

Use a scope key shaped as:

```ts
const scopeKey = `${zoneId}\0${profileId}\0${providerId}\0${stateScope}`;
```

The manager must:

- create a VM through injected `createManagedVm`;
- return `CredentialRunnerLease`;
- reuse only when `profileId`, `providerId`, `stateScope`, and `effectiveIdleTtlMs` match;
- touch `lastUsedAt` on create, reuse, renew, start run, heartbeat, and end run;
- create tombstones for ended use ids so duplicate starts are rejected during the retry window;
- allow concurrent agent runs when they have distinct `runId` and `activeUseId`;
- reject agent runs while maintainer setup is active;
- reject maintainer setup while active agent runs exist;
- count artifact streams as active uses so normal lease release cannot delete memory-backed `/run-out` while an artifact is being read;
- reap leases whose `lastUsedAt + effectiveIdleTtlMs` is older than `now()`;
- refuse normal release when active uses exist;
- force release during controller teardown.

- [ ] **Step 4: Run lease tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/credential-runners/credential-runner-lease-manager.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/credential-runners/credential-runner-lease-manager.ts packages/agent-vm/src/controller/credential-runners/credential-runner-lease-manager.test.ts
git commit -m "feat: manage credential runner leases" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 6: Active-Use Wrapped Execution

**Files:**
- Create: `packages/agent-vm/src/controller/credential-runners/credential-runner-executor.ts`
- Create: `packages/credential-runner/src/output-drain.ts`
- Create: `packages/credential-runner/src/run-records.ts`
- Test: `packages/credential-runner/src/output-drain.test.ts`
- Test: `packages/agent-vm/src/controller/credential-runners/credential-runner-executor.test.ts`

- [ ] **Step 1: Write failing executor tests**

Assert:

```ts
expect(managedVm.fs.mkdir).toHaveBeenCalledWith('/run-in/01900000-0000-7000-8000-000000000001', {
	recursive: true,
});
expect(managedVm.fs.mkdir).toHaveBeenCalledWith('/run-out/01900000-0000-7000-8000-000000000001', {
	recursive: true,
});
expect(managedVm.fs.mkdir).toHaveBeenCalledWith('/scratch/01900000-0000-7000-8000-000000000001', {
	recursive: true,
});
expect(startActiveUse).toHaveBeenCalledWith(
	expect.objectContaining({
		correlation: expect.objectContaining({
			runId: '01900000-0000-7000-8000-000000000001',
			toolName: 'google.calendar.list_events',
		}),
	}),
);
expect(managedVm.exec).toHaveBeenCalledWith(
	['/usr/local/bin/gog', 'calendar', 'events', 'list'],
	expect.objectContaining({ buffer: false, stderr: 'pipe', stdout: 'pipe' }),
);
expect(endActiveUse).toHaveBeenCalledWith(expect.any(String), { outcome: 'completed' });
expect(auditEvent).toEqual(
	expect.objectContaining({
		activeUseId: '01900000-0000-7000-8000-000000000002',
		argvHash: '4e25cd9c279963e596241e5abce8ea9857eb8c254d0b75d5d3b612f8f27077fd',
		runId: '01900000-0000-7000-8000-000000000001',
		stderr: { bytes: 0, truncated: false },
		stdout: { bytes: 1024, truncated: false },
	}),
);
```

Also assert:

- a non-zero exit code ends with outcome `'failed'`;
- an oversized stdout stream records `stdout.truncated === true` and ends the
  active use with outcome `'failed'`;
- an oversized stderr stream records `stderr.truncated === true`;
- the returned `runId` matches the audit event and the artifact namespace.

For `packages/credential-runner/src/output-drain.test.ts`, create a fake
`ManagedExecProcess` whose `output()` yields one stdout chunk of 1024 bytes and
one stderr chunk of 12 bytes:

```ts
const output = await drainCredentialRunnerOutput(fakeProcess, {
	stderrMaxBytes: 128,
	stdoutMaxBytes: 2048,
});
expect(output).toEqual({
	stderr: { bytes: 12, truncated: false },
	stdout: { bytes: 1024, truncated: false },
});
expect(hashCredentialRunnerArgv(['/usr/local/bin/gog', 'calendar', 'events', 'list'])).toBe(
	'4e25cd9c279963e596241e5abce8ea9857eb8c254d0b75d5d3b612f8f27077fd',
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/controller/credential-runners/credential-runner-executor.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement executor**

The execution core must use native Gondolin types:

```ts
const process = lease.capability.managedVm.exec([...command.argv], {
	buffer: false,
	cwd: context.scratchDir,
	env: {
		AGENT_VM_RUN_ID: runId,
	},
	stderr: 'pipe',
	stdout: 'pipe',
});

const [output, result] = await Promise.all([
	drainCredentialRunnerOutput(process, outputCaps),
	process.result,
]);
```

Before calling `exec`, the executor must create:

```ts
await lease.capability.managedVm.fs.mkdir(context.runInputDir, { recursive: true });
await lease.capability.managedVm.fs.mkdir(context.runOutputDir, { recursive: true });
await lease.capability.managedVm.fs.mkdir(context.scratchDir, { recursive: true });
```

It must create `runId` with UUIDv7, create `activeUseId` with
`createCredentialRunnerActiveUseId()`, compute `argvHash` with
`hashCredentialRunnerArgv(argv)`, count stdout/stderr bytes while streaming,
write a `CredentialRunnerAuditEvent`, and always call `endActiveUse` in a
`finally` block. It must not read `result.stdout` or `result.stderr` for
agent-callable runs.

- [ ] **Step 4: Run executor tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/credential-runners/credential-runner-executor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/credential-runners/credential-runner-executor.ts packages/credential-runner/src/run-records.ts packages/agent-vm/src/controller/credential-runners/credential-runner-executor.test.ts
git commit -m "feat: execute credential runner commands" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 7: VFS Artifact Policy

**Files:**
- Create: `packages/credential-runner/src/artifact-policy.ts`
- Create: `packages/credential-runner/src/artifact-policy.test.ts`
- Create: `packages/agent-vm/src/controller/credential-runners/credential-runner-artifacts.ts`
- Test: `packages/agent-vm/src/controller/credential-runners/credential-runner-artifacts.test.ts`

- [ ] **Step 1: Write failing artifact policy tests**

Assert:

```ts
expect(() => validateCredentialRunnerArtifactPath('/run-out/018f/events.json')).not.toThrow();
expect(() => validateCredentialRunnerArtifactPath('/tmp/events.json')).toThrow(/must be under \/run-out/u);
expect(() => validateCredentialRunnerArtifactPath('/run-out/018f/../secret')).toThrow(/parent traversal/u);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/credential-runner/src/artifact-policy.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement artifact validation**

```ts
export function validateCredentialRunnerArtifactPath(pathValue: string): void {
	if (!pathValue.startsWith('/run-out/')) {
		throw new Error(`Credential runner artifact path '${pathValue}' must be under /run-out.`);
	}
	if (pathValue.split('/').includes('..')) {
		throw new Error(`Credential runner artifact path '${pathValue}' must not contain parent traversal.`);
	}
}
```

- [ ] **Step 4: Implement controller artifact helper**

The helper reads through `ManagedVm.fs`, validates size, and requires a regular
file. Do not claim symlink rejection in v1: Gondolin `VmFs` exposes `stat()`
but not `lstat()`, and `stat()` follows symlinks. The v1 defense is
memory-backed `/run-out`, strict path validation, and regular-file checks.

```ts
import { finished } from 'node:stream/promises';

const artifactUse = await manager.startActiveUse(lease.leaseId, {
	correlation: {
		runId,
		toolName: 'credential-runner.artifact.read',
	},
	useId: createCredentialRunnerActiveUseId(),
});
const stats = await lease.capability.managedVm.fs.stat(pathValue);
if (!stats.isFile()) {
	throw new Error(`Credential runner artifact '${pathValue}' is not a regular file.`);
}
if (stats.size > policy.maxArtifactBytes) {
	throw new Error(`Credential runner artifact '${pathValue}' exceeds maxArtifactBytes.`);
}
const stream = await lease.capability.managedVm.fs.readFileStream(pathValue);
void finished(stream).then(
	async () => {
		await manager.endActiveUse(lease.leaseId, artifactUse.useId, { outcome: 'completed' });
	},
	async () => {
		await manager.endActiveUse(lease.leaseId, artifactUse.useId, { outcome: 'failed' });
	},
);
return stream;
```

- [ ] **Step 5: Run artifact tests**

Run: `pnpm vitest run packages/credential-runner/src/artifact-policy.test.ts packages/agent-vm/src/controller/credential-runners/credential-runner-artifacts.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/credential-runner/src/artifact-policy.ts packages/credential-runner/src/artifact-policy.test.ts packages/agent-vm/src/controller/credential-runners/credential-runner-artifacts.ts packages/agent-vm/src/controller/credential-runners/credential-runner-artifacts.test.ts
git commit -m "feat: validate credential runner artifacts" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 8: Controller Routes

**Files:**
- Create: `packages/agent-vm/src/controller/http/credential-runner-routes.ts`
- Create: `packages/agent-vm/src/controller/http/credential-runner-routes.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`

- [ ] **Step 1: Write failing route tests**

Route behavior:

```text
POST /zones/:zoneId/credential-runners/:providerId/runs
POST /zones/:zoneId/credential-runners/:providerId/maintainer/actions
GET  /zones/:zoneId/credential-runners/:providerId/runs/:runId/artifacts/:artifactName
```

Tests must prove:

```ts
expect(response.status).toBe(200);
expect(executeCredentialRunnerRun).toHaveBeenCalledWith(
	expect.objectContaining({
		providerId: 'google',
		zoneId: 'sunfam',
	}),
);
```

Maintainer setup must require zone admin auth when `adminAccess` is configured:

```ts
expect(response.status).toBe(401);
```

The run route must reject maintainer operations:

```ts
const response = await app.request('/zones/sunfam/credential-runners/google/runs', {
	method: 'POST',
	body: JSON.stringify({ args: {}, toolName: 'google.auth.login' }),
	headers: { 'content-type': 'application/json' },
});
expect(response.status).toBe(400);
expect(await response.json()).toMatchObject({ error: 'maintainer-action-not-agent-callable' });
```

- [ ] **Step 2: Run route tests to verify they fail**

Run: `pnpm vitest run packages/agent-vm/src/controller/http/credential-runner-routes.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement routes**

`runs` accepts:

```ts
const credentialRunnerRunRequestSchema = z
	.object({
		args: z.unknown(),
		correlation: z
			.object({
				agentId: z.string().min(1).optional(),
				sessionId: z.string().min(1).optional(),
				sessionKey: z.string().min(1).optional(),
				toolCallId: z.string().min(1).optional(),
			})
			.strict()
			.optional(),
		profileId: z.string().min(1).optional(),
		toolName: z.string().min(1),
	})
	.strict();
```

The route delegates to `ControllerRouteOperations.executeCredentialRunnerRun`.
It does not accept argv, command strings, filesystem paths, or environment
variables.

`maintainer/actions` accepts only fixed maintainer action names:

```ts
const credentialRunnerMaintainerActionRequestSchema = z
	.object({
		action: z.enum(['print-device-auth-instructions', 'refresh-token']),
		profileId: z.string().min(1).optional(),
	})
	.strict();
```

It does not expose PTY, stdin, arbitrary argv, or shell commands.

- [ ] **Step 4: Run route tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/http/credential-runner-routes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/http/credential-runner-routes.ts packages/agent-vm/src/controller/http/credential-runner-routes.test.ts packages/agent-vm/src/controller/http/controller-http-route-support.ts packages/agent-vm/src/controller/http/controller-http-routes.ts
git commit -m "feat: add credential runner controller routes" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 9: Maintainer Credential Setup

**Files:**
- Create: `packages/agent-vm/src/controller/credential-runners/credential-runner-maintainer.ts`
- Test: `packages/agent-vm/src/controller/credential-runners/credential-runner-maintainer.test.ts`

- [ ] **Step 1: Write failing maintainer tests**

Assert maintainer setup:

```ts
expect(managedVm.exec).toHaveBeenCalledWith(
	['/usr/local/bin/gog', 'auth', 'device-code', '--credential-dir', '/cred', '--json'],
	expect.objectContaining({ buffer: false, stderr: 'pipe', stdout: 'pipe' }),
);
expect(managedVm.exec).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pty: true }));
expect(managedVm.exec).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stdin: true }));
```

Also assert:

```ts
expect(() => leaseManager.beginMaintenance(lease.leaseId)).toThrow(/active credential runner uses/u);
expect(() =>
	agentCatalog.buildCommand({
		args: {},
		context: {
			credentialDir: '/cred',
			runInputDir: '/run-in/018f',
			runOutputDir: '/run-out/018f',
			scratchDir: '/scratch/018f',
		},
		toolName: 'google.auth.login',
	}),
).toThrow("Unknown credential runner tool 'google.auth.login'.");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/agent-vm/src/controller/credential-runners/credential-runner-maintainer.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement maintainer setup**

The maintainer path is protected by zone admin auth and may write `/cred`, but
v1 still uses fixed, non-interactive argv. It must not use `pty: true`,
`stdin: true`, WebSocket, SSE, or chunked duplex HTTP. Providers that require
interactive terminal OAuth are out of scope until a separate duplex maintainer
plan exists.

```ts
// packages/agent-vm/src/controller/credential-runners/credential-runner-maintainer.ts
import { drainCredentialRunnerOutput, type CredentialRunnerLease } from '@agent-vm/credential-runner';

import type { CredentialRunnerLeaseManager } from './credential-runner-lease-manager.js';

export interface RunCredentialRunnerMaintainerSetupOptions {
	readonly lease: CredentialRunnerLease;
	readonly leaseManager: CredentialRunnerLeaseManager;
	readonly providerId: string;
	readonly action: 'print-device-auth-instructions' | 'refresh-token';
}

export async function runCredentialRunnerMaintainerSetup(
	options: RunCredentialRunnerMaintainerSetupOptions,
): Promise<void> {
	const maintenance = options.leaseManager.beginMaintenance(options.lease.leaseId);
	const argv = argvForMaintainerAction(options.providerId, options.action);
	try {
		const process = options.lease.capability.managedVm.exec(argv, {
			buffer: false,
			cwd: '/scratch/maintainer',
			stderr: 'pipe',
			stdout: 'pipe',
		});
		const [_output, result] = await Promise.all([
			drainCredentialRunnerOutput(process, { stderrMaxBytes: 64 * 1024, stdoutMaxBytes: 64 * 1024 }),
			process.result,
		]);
		if (result.exitCode !== 0) {
			throw new Error(
				`Credential runner maintainer action '${options.action}' for provider '${options.providerId}' exited with code ${String(result.exitCode)}.`,
			);
		}
	} finally {
		maintenance.end();
	}
}

function argvForMaintainerAction(
	providerId: string,
	action: RunCredentialRunnerMaintainerSetupOptions['action'],
): readonly string[] {
	switch (providerId) {
		case 'google':
			switch (action) {
				case 'print-device-auth-instructions':
					return ['/usr/local/bin/gog', 'auth', 'device-code', '--credential-dir', '/cred', '--json'];
				case 'refresh-token':
					return ['/usr/local/bin/gog', 'auth', 'refresh', '--credential-dir', '/cred', '--json'];
			}
		default:
			throw new Error(`Credential runner provider '${providerId}' does not support maintainer actions.`);
	}
}
```

- [ ] **Step 4: Run maintainer tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/credential-runners/credential-runner-maintainer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/credential-runners/credential-runner-maintainer.ts packages/agent-vm/src/controller/credential-runners/credential-runner-maintainer.test.ts
git commit -m "feat: add credential runner maintainer setup" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 10: Controller Runtime Wiring

**Files:**
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts`
- Create: `packages/agent-vm/src/controller/credential-runners/credential-runner-runtime.ts`
- Test: `packages/agent-vm/src/controller/controller-runtime.test.ts`

- [ ] **Step 1: Write failing runtime wiring tests**

Assert:

```ts
expect(createCredentialRunnerLeaseManager).toHaveBeenCalledWith(
	expect.objectContaining({
		createManagedVm: expect.any(Function),
		now: expect.any(Function),
	}),
);
expect(controllerAppOptions.operations.executeCredentialRunnerRun).toEqual(expect.any(Function));
expect(controllerAppOptions.operations.runCredentialRunnerMaintainerAction).toEqual(expect.any(Function));
```

Also assert teardown force-closes runner leases:

```ts
await runtime.close();
expect(credentialRunnerLeaseManager.releaseAllLeases).toHaveBeenCalledWith({ force: true });
```

and assert the reaper is registered:

```ts
expect(setIntervalImpl).toHaveBeenCalledWith(expect.any(Function), 60_000);
await runRegisteredInterval();
expect(credentialRunnerLeaseManager.reapExpiredLeases).toHaveBeenCalled();
```

- [ ] **Step 2: Run runtime tests to verify they fail**

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-runtime.test.ts`

Expected: FAIL because credential runner runtime wiring does not exist.

- [ ] **Step 3: Implement runtime assembly**

`credential-runner-runtime.ts` owns assembly and keeps `controller-runtime.ts`
from growing a second large subsystem:

```ts
export interface CredentialRunnerRuntime {
	readonly operations: Pick<
		ControllerRouteOperations,
		| 'executeCredentialRunnerRun'
		| 'getCredentialRunnerArtifact'
		| 'runCredentialRunnerMaintainerAction'
	>;
	close(): Promise<void>;
	reapExpiredLeases(): Promise<void>;
}

export async function createCredentialRunnerRuntime(
	options: CreateCredentialRunnerRuntimeOptions,
): Promise<CredentialRunnerRuntime> {
	const leaseManager = createCredentialRunnerLeaseManager(options);
	return {
		operations: {
			executeCredentialRunnerRun: async (request) =>
				await executeCredentialRunnerRun({ ...request, leaseManager }),
			getCredentialRunnerArtifact: async (request) =>
				await getCredentialRunnerArtifact({ ...request, leaseManager }),
			runCredentialRunnerMaintainerAction: async (request) =>
				await runCredentialRunnerMaintainerAction({ ...request, leaseManager }),
		},
		close: async () => {
			await leaseManager.releaseAllLeases({ force: true });
		},
		reapExpiredLeases: async () => {
			await leaseManager.reapExpiredLeases();
		},
	};
}
```

`controller-runtime.ts` must instantiate this runtime after `secretResolver` and
before `createControllerService`, spread its operations into
`ControllerRouteOperations`, call `credentialRunnerRuntime.reapExpiredLeases()`
from the same 60s reaper cadence, and call `credentialRunnerRuntime.close()`
during controller shutdown.

- [ ] **Step 4: Run runtime wiring tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime-types.ts packages/agent-vm/src/controller/credential-runners/credential-runner-runtime.ts packages/agent-vm/src/controller/controller-runtime.test.ts
git commit -m "feat: wire credential runner runtime" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 11: Documentation

**Files:**
- Create: `docs/subsystems/credentialed-runners.md`
- Modify: `docs/subsystems/gondolin-vm-layer.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/plans/README.md`

- [ ] **Step 1: Write subsystem doc**

Document:

- controller-owned `gondolin-rpc`;
- no SSH and no in-VM listener;
- maintainer path vs agent execution path;
- `/cred`, `/run-in`, `/run-out`, `/scratch`;
- `/cred` under zone `stateDir` and backed up as durable secret state;
- VFS-only artifact rule;
- explicit stdout/stderr drain loop for `buffer: false` exec;
- audit correlation fields;
- no interactive PTY maintainer support in v1;
- why `ManagedVm.exec()` and `ManagedVm.fs` are used directly.

- [ ] **Step 2: Update plan index**

Mark this plan as the current executable credentialed runner plan and mark
`2026-05-20-credentialed-tool-system.md` as a design reference superseded for
execution.

- [ ] **Step 3: Run docs format check**

Run: `pnpm fmt:check`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/subsystems/credentialed-runners.md docs/subsystems/gondolin-vm-layer.md docs/README.md docs/superpowers/plans/README.md
git commit -m "docs: document credentialed runners" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 12: Final Quality Gate

**Files:**
- All files changed by Tasks 1-11.

- [ ] **Step 1: Run unit tests**

Run: `pnpm test:unit`

Expected: PASS with all unit test files passing.

- [ ] **Step 2: Run integration tests**

Run: `mise exec -- pnpm test:integration`

Expected: PASS with environment-dependent live tests either passing or explicitly skipped.

- [ ] **Step 3: Run smoke tests**

Run: `mise exec -- pnpm test:smoke`

Expected: PASS with environment-dependent live smokes either passing or explicitly skipped.

- [ ] **Step 4: Run full check**

Run: `pnpm check`

Expected: PASS.

- [ ] **Step 5: Commit final cleanup**

If any documentation, formatting, or test fix changed files during the quality
gate, commit them:

```bash
git status --short
git add packages/credential-runner packages/gateway-interface/src packages/agent-vm/src/controller/credential-runners packages/agent-vm/src/controller/http packages/agent-vm/src/config packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime-types.ts docs/subsystems docs/README.md docs/superpowers/plans/README.md
git commit -m "chore: finish credential runner v1" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Acceptance Criteria

- `@agent-vm/credential-runner` exists and exports catalog, lease, run, and artifact policy types.
- `CredentialRunnerLease` composes `ManagedVm` and `VmCapabilityHandle<'gondolin-rpc', CredentialRunnerCapability>`.
- Controller runner execution uses `ManagedVm.exec([...argv], { stdout: 'pipe', stderr: 'pipe', buffer: false })` and drains `ExecProcess.output()` while the process runs.
- Output byte caps are enforced for stdout and stderr, and truncation is recorded in audit.
- Agent-callable runs cannot submit shell strings, argv arrays, environment maps, or filesystem paths.
- Agent-callable catalog entries cannot execute shell binaries.
- Maintainer setup is protected, non-interactive in v1, and separate from agent execution.
- Maintainer setup cannot run concurrently with agent execution on the same lease.
- Runner VM specs create `/cred`, `/run-in`, `/run-out`, and `/scratch` VFS mounts.
- `/cred` resolves under zone `stateDir/credential-runners/<profileId>/<providerId>` with mode `0700`.
- Runner VM specs do not configure SSH, ingress, or inbound `tcpHosts`.
- Artifact APIs only expose validated files under `/run-out/<runId>`.
- Artifact streams count as active uses until the stream finishes or errors.
- Credential runner leases are reaped after `effectiveIdleTtlMs` and force-closed during controller shutdown.
- Audit events include `runId`, `activeUseId`, `profileId`, `providerId`, `toolName`, deterministic `argvHash`, exit/duration/output summaries, and artifact count.
- Unit, integration, smoke, and `pnpm check` pass from the current worktree.
