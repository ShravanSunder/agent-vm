# Runtime Path Mapping Translator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one reusable runtime path translation engine so the OpenClaw plugin and agent-vm controller can translate `/workspace`, `/work`, `/zone`, sandbox paths, and host-backed roots without duplicating path matrix logic or letting cwd/scope leak into lease identity.

**Architecture:** `@agent-vm/gateway-interface` owns a pure `RuntimePathMapping` translator with typed storage backing and structured retry errors. Runtime packages inject their own mappings: the OpenClaw plugin injects Tool VM cwd/workspace semantics, while the controller injects OpenClaw gateway lease-path semantics from `system.json` roots and keeps final `realpath` security validation.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo, Oxfmt/Oxlint, Zod-adjacent typed contracts through `@agent-vm/gateway-interface`.

**Base Branch:** Execute this plan only after `fix/tool-vm-lease-and-ingress-defaults` has landed, or rebase this plan onto that branch before starting. The controller `/lease` API must already be the hard-cut shape with no `scopeKey` and no `sandbox` request fields.

---

## Mental Model

```text
┌────────────────────────────────────────────────────────────────────┐
│ One translator, many runtime mappings                               │
└────────────────────────────────────────────────────────────────────┘

@agent-vm/gateway-interface
  owns pure mechanics:
    normalize absolute POSIX paths
    reject parent traversal
    longest-prefix match guestRoot or hostRoot
    compute relative path
    return guest path, host path, backing, capabilities
    return structured retry errors

@agent-vm/openclaw-agent-vm-plugin
  injects OpenClaw Tool VM mapping:
    /workspace <-> agentWorkspaceDir
    /work      -> Tool VM rootfs/COW scratch

@agent-vm/agent-vm controller
  injects OpenClaw gateway lease mapping:
    /home/openclaw/.openclaw/state/sandboxes <-> stateDir/sandboxes
    /zone                                      <-> zoneFilesDir
```

```text
┌────────────────────────────────────────────────────────────────────┐
│ Two projections from the same translation                           │
└────────────────────────────────────────────────────────────────────┘

Plugin projection:
  inputPath            OpenClaw workspaceDir/cwd intent
  leaseWorkMountDir    host/gateway RealFS source sent to POST /lease
  effectiveGuestCwd    Tool VM cwd used for exec/fs bridge

Controller projection:
  inputPath            POST /lease workMountDir
  hostWorkMountDir     controller trusted host path after realpath proof
  guestWorkdir         Tool VM mount/cwd root returned in lease response
  zoneGitMount         optional zone-git VFS metadata
```

## Package Ownership

```text
┌───────────────────────────────┬────────────────────────────────────┐
│ Package                       │ Owns                               │
├───────────────────────────────┼────────────────────────────────────┤
│ gateway-interface             │ RuntimePathMapping types, pure      │
│                               │ translator, Tool VM guest root      │
│                               │ constants, structured error shape   │
├───────────────────────────────┼────────────────────────────────────┤
│ openclaw-agent-vm-plugin      │ OpenClaw plugin inputs, agentId     │
│                               │ derivation, cfg assertion, Tool VM  │
│                               │ mapping injection, effective cwd    │
├───────────────────────────────┼────────────────────────────────────┤
│ agent-vm controller           │ system.json roots, /lease API,      │
│                               │ realpath/allowed-root validation,   │
│                               │ Tool VM lifecycle mounts            │
├───────────────────────────────┼────────────────────────────────────┤
│ gondolin-adapter              │ VM/VFS mechanics only; no OpenClaw  │
│                               │ workspace or lease identity policy  │
└───────────────────────────────┴────────────────────────────────────┘
```

## Files

Create:

- `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.ts` — pure translator, types, constants, structured errors.
- `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts` — unit tests for bidirectional mapping, scratch paths, root restrictions, errors.
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.ts` — plugin-owned mapping builder/projection from OpenClaw inputs to lease mount + guest cwd.
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts` — plugin matrix tests for `/workspace`, `/work`, host workspace paths, cross-agent errors.
- `packages/agent-vm/src/controller/leases/openclaw-gateway-lease-path-mapping.ts` — controller-owned mapping builder from `stateDir`, `zoneFilesDir`, `runtimeDir`.

Modify:

- `packages/gateway-interface/src/index.ts` — export runtime path mapping API.
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts` — use plugin mapping before `requestLease`; cache the lease by `zoneId + agentId`; rebuild a per-call handle with the current `effectiveGuestCwd`; normalize exec cwd.
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts` — keep dependency contract simple; workdir remains guest path only.
- `packages/openclaw-agent-vm-plugin/src/openclaw-backend-dependencies.ts` — consume already-normalized guest workdir; no mapping logic here.
- `packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts` — reuse gateway-interface translator for gateway path mapping; preserve final `realpath` validation.
- `packages/agent-vm/src/controller/http/controller-http-routes.ts` — include structured retry guidance when path translation fails.
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts` — integration coverage that `/workspace` and `/work` do not fork leases and never reach controller as `workMountDir`.
- `packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts` — update/extend controller resolver tests against shared translator behavior.
- `packages/agent-vm/src/controller/http/controller-http-routes.test.ts` — assert JSON guidance for path translation failures.
- `docs/architecture/storage-model.md` — document that path matrix mechanics live in `gateway-interface`, while runtime mappings are injected.
- `docs/architecture/openclaw-gateway.md` — document plugin cwd normalization and controller host-root enforcement.
- `packages/agent-vm/src/cli/manual-templates.ts` — update generated manual runtime-path guidance.
- `packages/agent-vm/src/cli/manual-templates.test.ts` — assert generated manual text matches the new path contract.

Not touched in this plan:

- `packages/gondolin-adapter/src/vm-adapter.ts` — it receives VFS mounts and should not learn OpenClaw path policy.
- `packages/worker-gateway/src/worker-lifecycle.ts` — worker `/work/repos` semantics can use the generic translator in a separate worker-specific change.

## TDD And Testing Pyramid

This plan must be executed test-first. No production code step starts until the corresponding failing test has been written and run to confirm the expected failure.

```text
Acceptance / smoke loop
  Task 6 proves the OpenClaw plugin boundary end to end:
    - `/workspace[/subpath]` and `/work[/subpath]` are accepted as plugin input intent.
    - the controller request never contains `workspaceDir`, `scopeKey`, or `sandbox`.
    - same-agent subagent-shaped sessions reuse one controller lease.

Integration loop
  Task 3 proves the plugin factory behavior:
    - lease cache key is `zoneId + agentId`.
    - cached lease is reused across cwd intents.
    - handle is rebuilt per call so `effectiveGuestCwd` stays request-local.

  Task 4 and Task 5 prove the controller boundary:
    - controller translates only controller-supported gateway paths.
    - controller still rejects direct Tool VM guest paths in `/lease workMountDir`.
    - structured retry guidance survives into HTTP JSON.

Unit loop
  Task 1 proves generic translator mechanics:
    - absolute path normalization.
    - parent traversal rejection.
    - longest-prefix root match.
    - root-path restrictions.
    - purpose capability checks.

  Task 2 proves OpenClaw Tool VM projection:
    - host workspace paths become `/workspace[/subpath]` cwd.
    - `/workspace[/subpath]` maps to the agent workspace mount.
    - `/work[/subpath]` is execution cwd only, never lease mount identity.
```

---

### Task 1: Add Pure Runtime Path Translator To gateway-interface

**Files:**
- Create: `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts`
- Create: `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.ts`
- Modify: `packages/gateway-interface/src/index.ts`

- [ ] **Step 1: Write the failing translator tests**

Create `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
	TOOL_VM_SCRATCH_GUEST_ROOT,
	TOOL_VM_WORKSPACE_GUEST_ROOT,
	translateRuntimePath,
	type RuntimePathMapping,
} from './runtime-path-mapping.js';

const mapping = {
	id: 'test-tool-vm',
	roots: [
		{
			id: 'agent-workspace',
			guestRoot: TOOL_VM_WORKSPACE_GUEST_ROOT,
			hostRoot: '/zone/agents/beta',
			backing: {
				kind: 'host-realfs',
				durability: 'durable',
				backup: 'included',
			},
			capabilities: {
				executionCwd: true,
				leaseMount: true,
			},
			rootPathAllowed: true,
			guidanceLabel: 'agent workspace',
		},
		{
			id: 'tool-vm-scratch',
			guestRoot: TOOL_VM_SCRATCH_GUEST_ROOT,
			backing: {
				kind: 'guest-rootfs-cow',
				durability: 'vm-lifetime',
			},
			capabilities: {
				executionCwd: true,
				leaseMount: false,
			},
			rootPathAllowed: true,
			guidanceLabel: 'Tool VM scratch',
		},
		{
			id: 'workspace-cache',
			guestRoot: '/workspace-cache',
			hostRoot: '/cache/workspace',
			backing: {
				kind: 'host-realfs',
				durability: 'cache',
				backup: 'excluded',
			},
			capabilities: {
				executionCwd: true,
				leaseMount: false,
			},
			rootPathAllowed: true,
			guidanceLabel: 'workspace cache',
		},
	],
} satisfies RuntimePathMapping;

describe('translateRuntimePath', () => {
	it('maps guest workspace subpaths to host paths', () => {
		const result = translateRuntimePath({
			mapping,
			inputPath: '/workspace/app',
			purpose: 'executionCwd',
		});

		expect(result).toEqual({
			ok: true,
			value: {
				backing: {
					kind: 'host-realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: true,
					leaseMount: true,
				},
				guestPath: '/workspace/app',
				guestRoot: '/workspace',
				hasHostBacking: true,
				hostPath: '/zone/agents/beta/app',
				hostRoot: '/zone/agents/beta',
				inputNamespace: 'guest',
				inputPath: '/workspace/app',
				mappingId: 'test-tool-vm',
				relativePath: 'app',
				rootId: 'agent-workspace',
			},
		});
	});

	it('maps host workspace subpaths back to guest paths', () => {
		const result = translateRuntimePath({
			mapping,
			inputPath: '/zone/agents/beta/app',
			purpose: 'executionCwd',
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				guestPath: '/workspace/app',
				hostPath: '/zone/agents/beta/app',
				inputNamespace: 'host',
				relativePath: 'app',
				rootId: 'agent-workspace',
			},
		});
	});

	it('allows scratch paths as execution cwd without host backing', () => {
		const result = translateRuntimePath({
			mapping,
			inputPath: '/work/tmp',
			purpose: 'executionCwd',
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				backing: {
					kind: 'guest-rootfs-cow',
					durability: 'vm-lifetime',
				},
				guestPath: '/work/tmp',
				hasHostBacking: false,
				inputNamespace: 'guest',
				relativePath: 'tmp',
				rootId: 'tool-vm-scratch',
			},
		});
	});

	it('rejects scratch paths for lease mounts with retry guidance', () => {
		const result = translateRuntimePath({
			mapping,
			inputPath: '/work/tmp',
			purpose: 'leaseMount',
		});

		expect(result).toEqual({
			ok: false,
			error: {
				allowedPathForms: [
					'/workspace[/subpath]',
					'/zone/agents/beta[/subpath]',
				],
				code: 'purpose-not-allowed',
				inputPath: '/work/tmp',
				mappingId: 'test-tool-vm',
				message: "Path '/work/tmp' matched Tool VM scratch but cannot be used for leaseMount.",
				purpose: 'leaseMount',
				retryGuidance:
					"Use one of the allowed path forms for test-tool-vm leaseMount: /workspace[/subpath], /zone/agents/beta[/subpath].",
			},
		});
	});

	it('uses longest root match', () => {
		const result = translateRuntimePath({
			mapping,
			inputPath: '/workspace-cache/npm',
			purpose: 'executionCwd',
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				guestPath: '/workspace-cache/npm',
				hostPath: '/cache/workspace/npm',
				rootId: 'workspace-cache',
			},
		});
	});

	it('rejects parent traversal before normalization', () => {
		const result = translateRuntimePath({
			mapping,
			inputPath: '/workspace/../secret',
			purpose: 'executionCwd',
		});

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'path-parent-traversal',
				inputPath: '/workspace/../secret',
			},
		});
	});

	it('rejects unknown absolute paths with allowed forms', () => {
		const result = translateRuntimePath({
			mapping,
			inputPath: '/tmp/build',
			purpose: 'executionCwd',
		});

		expect(result).toEqual({
			ok: false,
			error: {
				allowedPathForms: [
					'/workspace[/subpath]',
					'/zone/agents/beta[/subpath]',
					'/work[/subpath]',
					'/workspace-cache[/subpath]',
					'/cache/workspace[/subpath]',
				],
				code: 'unknown-runtime-path',
				inputPath: '/tmp/build',
				mappingId: 'test-tool-vm',
				message: "Path '/tmp/build' is not part of runtime path mapping 'test-tool-vm'.",
				purpose: 'executionCwd',
				retryGuidance:
					"Use one of the allowed path forms for test-tool-vm executionCwd: /workspace[/subpath], /zone/agents/beta[/subpath], /work[/subpath], /workspace-cache[/subpath], /cache/workspace[/subpath].",
			},
		});
	});

	it('rejects exact roots when rootPathAllowed is false', () => {
		const gatewayMapping = {
			id: 'openclaw-gateway-lease',
			roots: [
				{
					id: 'zone-files',
					guestRoot: '/zone',
					hostRoot: '/host/zone-files',
					backing: {
						kind: 'host-realfs',
						durability: 'durable',
						backup: 'included',
					},
					capabilities: {
						executionCwd: false,
						leaseMount: true,
					},
					rootPathAllowed: false,
					guidanceLabel: 'zone files',
				},
			],
		} satisfies RuntimePathMapping;

		const result = translateRuntimePath({
			mapping: gatewayMapping,
			inputPath: '/zone',
			purpose: 'leaseMount',
		});

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'root-path-not-allowed',
				inputPath: '/zone',
			},
		});
	});
});
```

- [ ] **Step 2: Run the failing translator tests**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts
```

Expected: FAIL with a module resolution error for `./runtime-path-mapping.js`.

- [ ] **Step 3: Implement the pure translator**

Create `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.ts`:

```ts
export const TOOL_VM_WORKSPACE_GUEST_ROOT = '/workspace';
export const TOOL_VM_SCRATCH_GUEST_ROOT = '/work';

export type RuntimePathPurpose = 'executionCwd' | 'leaseMount';

export interface RuntimePathCapabilities {
	readonly executionCwd: boolean;
	readonly leaseMount: boolean;
}

export type RuntimePathBacking =
	| {
			readonly kind: 'host-realfs';
			readonly durability: 'durable' | 'runtime' | 'cache';
			readonly backup: 'included' | 'excluded';
	  }
	| {
			readonly kind: 'guest-rootfs-cow';
			readonly durability: 'vm-lifetime';
	  };

export interface RuntimePathRootMapping {
	readonly id: string;
	readonly guestRoot?: string;
	readonly hostRoot?: string;
	readonly backing: RuntimePathBacking;
	readonly capabilities: RuntimePathCapabilities;
	readonly rootPathAllowed: boolean;
	readonly guidanceLabel: string;
}

export interface RuntimePathMapping {
	readonly id: string;
	readonly roots: readonly RuntimePathRootMapping[];
}

export interface TranslateRuntimePathInput {
	readonly mapping: RuntimePathMapping;
	readonly inputPath: string;
	readonly purpose: RuntimePathPurpose;
}

export interface RuntimePathTranslation {
	readonly mappingId: string;
	readonly rootId: string;
	readonly inputPath: string;
	readonly inputNamespace: 'guest' | 'host';
	readonly relativePath: string;
	readonly backing: RuntimePathBacking;
	readonly capabilities: RuntimePathCapabilities;
	readonly guestPath?: string;
	readonly hostPath?: string;
	readonly guestRoot?: string;
	readonly hostRoot?: string;
	readonly hasHostBacking: boolean;
}

export type RuntimePathTranslationErrorCode =
	| 'path-not-absolute'
	| 'path-parent-traversal'
	| 'unknown-runtime-path'
	| 'purpose-not-allowed'
	| 'root-path-not-allowed';

export interface RuntimePathTranslationError {
	readonly allowedPathForms: readonly string[];
	readonly code: RuntimePathTranslationErrorCode;
	readonly inputPath: string;
	readonly mappingId: string;
	readonly message: string;
	readonly purpose: RuntimePathPurpose;
	readonly retryGuidance: string;
}

export type TranslateRuntimePathResult =
	| {
			readonly ok: true;
			readonly value: RuntimePathTranslation;
	  }
	| {
			readonly ok: false;
			readonly error: RuntimePathTranslationError;
	  };

interface RuntimePathRootMatch {
	readonly inputNamespace: 'guest' | 'host';
	readonly matchedRoot: string;
	readonly root: RuntimePathRootMapping;
}

function pathContainsParentTraversal(inputPath: string): boolean {
	return inputPath.split(/\/+/u).includes('..');
}

function normalizeAbsolutePath(inputPath: string): string {
	const rawSegments = inputPath.split('/').filter((segment) => segment !== '' && segment !== '.');
	return `/${rawSegments.join('/')}`;
}

function normalizeRoot(rootPath: string): string {
	const normalizedRoot = normalizeAbsolutePath(rootPath);
	return normalizedRoot === '/' ? normalizedRoot : normalizedRoot.replace(/\/+$/u, '');
}

function pathMatchesRoot(candidatePath: string, rootPath: string): boolean {
	return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

function relativePathForRoot(candidatePath: string, rootPath: string): string {
	return candidatePath === rootPath ? '' : candidatePath.slice(rootPath.length + 1);
}

function joinRootAndRelative(rootPath: string, relativePath: string): string {
	return relativePath === '' ? rootPath : `${rootPath}/${relativePath}`;
}

function allowedPathFormsForMapping(
	mapping: RuntimePathMapping,
	purpose: RuntimePathPurpose,
): readonly string[] {
	return mapping.roots.flatMap((root) => {
		if (!root.capabilities[purpose]) {
			return [];
		}
		const suffix = root.rootPathAllowed ? '[/subpath]' : '/<child>';
		return [root.guestRoot, root.hostRoot]
			.filter((value): value is string => value !== undefined)
			.map((value) => `${normalizeRoot(value)}${suffix}`);
	});
}

function retryGuidanceForMapping(mapping: RuntimePathMapping, purpose: RuntimePathPurpose): string {
	return `Use one of the allowed path forms for ${mapping.id} ${purpose}: ${allowedPathFormsForMapping(mapping, purpose).join(', ')}.`;
}

function errorResult(params: {
	readonly code: RuntimePathTranslationErrorCode;
	readonly inputPath: string;
	readonly mapping: RuntimePathMapping;
	readonly message: string;
	readonly purpose: RuntimePathPurpose;
}): TranslateRuntimePathResult {
	return {
		ok: false,
		error: {
			allowedPathForms: allowedPathFormsForMapping(params.mapping, params.purpose),
			code: params.code,
			inputPath: params.inputPath,
			mappingId: params.mapping.id,
			message: params.message,
			purpose: params.purpose,
			retryGuidance: retryGuidanceForMapping(params.mapping, params.purpose),
		},
	};
}

function findBestRootMatch(params: {
	readonly inputPath: string;
	readonly mapping: RuntimePathMapping;
}): RuntimePathRootMatch | undefined {
	const matches = params.mapping.roots.flatMap((root): RuntimePathRootMatch[] => {
		const guestRoot =
			root.guestRoot === undefined ? undefined : normalizeRoot(root.guestRoot);
		const hostRoot = root.hostRoot === undefined ? undefined : normalizeRoot(root.hostRoot);
		const rootMatches: RuntimePathRootMatch[] = [];
		if (guestRoot !== undefined && pathMatchesRoot(params.inputPath, guestRoot)) {
			rootMatches.push({ inputNamespace: 'guest', matchedRoot: guestRoot, root });
		}
		if (hostRoot !== undefined && pathMatchesRoot(params.inputPath, hostRoot)) {
			rootMatches.push({ inputNamespace: 'host', matchedRoot: hostRoot, root });
		}
		return rootMatches;
	});
	return matches.toSorted((left, right) => right.matchedRoot.length - left.matchedRoot.length)[0];
}

export function translateRuntimePath(input: TranslateRuntimePathInput): TranslateRuntimePathResult {
	if (!input.inputPath.startsWith('/')) {
		return errorResult({
			code: 'path-not-absolute',
			inputPath: input.inputPath,
			mapping: input.mapping,
			message: `Path '${input.inputPath}' must be absolute.`,
			purpose: input.purpose,
		});
	}
	if (pathContainsParentTraversal(input.inputPath)) {
		return errorResult({
			code: 'path-parent-traversal',
			inputPath: input.inputPath,
			mapping: input.mapping,
			message: `Path '${input.inputPath}' must not contain '..' segments.`,
			purpose: input.purpose,
		});
	}
	const normalizedInputPath = normalizeAbsolutePath(input.inputPath);
	const match = findBestRootMatch({
		inputPath: normalizedInputPath,
		mapping: input.mapping,
	});
	if (!match) {
		return errorResult({
			code: 'unknown-runtime-path',
			inputPath: normalizedInputPath,
			mapping: input.mapping,
			message: `Path '${normalizedInputPath}' is not part of runtime path mapping '${input.mapping.id}'.`,
			purpose: input.purpose,
		});
	}
	const relativePath = relativePathForRoot(normalizedInputPath, match.matchedRoot);
	if (relativePath === '' && !match.root.rootPathAllowed) {
		return errorResult({
			code: 'root-path-not-allowed',
			inputPath: normalizedInputPath,
			mapping: input.mapping,
			message: `Path '${normalizedInputPath}' matched ${match.root.guidanceLabel}, but the root itself is not allowed for ${input.purpose}.`,
			purpose: input.purpose,
		});
	}
	if (!match.root.capabilities[input.purpose]) {
		return errorResult({
			code: 'purpose-not-allowed',
			inputPath: normalizedInputPath,
			mapping: input.mapping,
			message: `Path '${normalizedInputPath}' matched ${match.root.guidanceLabel} but cannot be used for ${input.purpose}.`,
			purpose: input.purpose,
		});
	}
	const guestRoot = match.root.guestRoot === undefined ? undefined : normalizeRoot(match.root.guestRoot);
	const hostRoot = match.root.hostRoot === undefined ? undefined : normalizeRoot(match.root.hostRoot);
	return {
		ok: true,
		value: {
			backing: match.root.backing,
			capabilities: match.root.capabilities,
			...(guestRoot !== undefined ? { guestPath: joinRootAndRelative(guestRoot, relativePath) } : {}),
			...(guestRoot !== undefined ? { guestRoot } : {}),
			hasHostBacking: hostRoot !== undefined,
			...(hostRoot !== undefined ? { hostPath: joinRootAndRelative(hostRoot, relativePath) } : {}),
			...(hostRoot !== undefined ? { hostRoot } : {}),
			inputNamespace: match.inputNamespace,
			inputPath: normalizedInputPath,
			mappingId: input.mapping.id,
			relativePath,
			rootId: match.root.id,
		},
	};
}
```

- [ ] **Step 4: Export the translator**

Modify `packages/gateway-interface/src/index.ts`:

```ts
export {
	TOOL_VM_SCRATCH_GUEST_ROOT,
	TOOL_VM_WORKSPACE_GUEST_ROOT,
	translateRuntimePath,
} from './runtime-paths/runtime-path-mapping.js';
export type {
	RuntimePathBacking,
	RuntimePathCapabilities,
	RuntimePathMapping,
	RuntimePathPurpose,
	RuntimePathRootMapping,
	RuntimePathTranslation,
	RuntimePathTranslationError,
	RuntimePathTranslationErrorCode,
	TranslateRuntimePathInput,
	TranslateRuntimePathResult,
} from './runtime-paths/runtime-path-mapping.js';
```

Place these exports after the existing Tool VM exports near `tool-vm-lease.js`.

- [ ] **Step 5: Run the translator tests**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/gateway-interface/src/index.ts packages/gateway-interface/src/runtime-paths/runtime-path-mapping.ts packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts
git commit -m "feat: add runtime path translator"
```

---

### Task 2: Add OpenClaw Tool VM Plugin Path Projection

**Files:**
- Create: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts`
- Create: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.ts`

- [ ] **Step 1: Write plugin mapping tests**

Create `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { resolveOpenClawToolVmPathIntent } from './openclaw-tool-vm-path-mapping.js';

describe('resolveOpenClawToolVmPathIntent', () => {
	it.each([
		{
			inputPath: '/zone/agents/beta',
			leaseWorkMountDir: '/zone/agents/beta',
			effectiveGuestCwd: '/workspace',
			kind: 'host-workspace-root',
		},
		{
			inputPath: '/zone/agents/beta/app',
			leaseWorkMountDir: '/zone/agents/beta',
			effectiveGuestCwd: '/workspace/app',
			hostEquivalentPath: '/zone/agents/beta/app',
			kind: 'host-workspace-subpath',
		},
		{
			inputPath: '/workspace',
			leaseWorkMountDir: '/zone/agents/beta',
			effectiveGuestCwd: '/workspace',
			hostEquivalentPath: '/zone/agents/beta',
			kind: 'workspace-root',
		},
		{
			inputPath: '/workspace/app',
			leaseWorkMountDir: '/zone/agents/beta',
			effectiveGuestCwd: '/workspace/app',
			hostEquivalentPath: '/zone/agents/beta/app',
			kind: 'workspace-subpath',
		},
		{
			inputPath: '/work',
			leaseWorkMountDir: '/zone/agents/beta',
			effectiveGuestCwd: '/work',
			kind: 'scratch-root',
		},
		{
			inputPath: '/work/tmp',
			leaseWorkMountDir: '/zone/agents/beta',
			effectiveGuestCwd: '/work/tmp',
			kind: 'scratch-subpath',
		},
	])('projects $inputPath', (expected) => {
		expect(
			resolveOpenClawToolVmPathIntent({
				agentWorkspaceDir: '/zone/agents/beta',
				inputPath: expected.inputPath,
			}),
		).toEqual({
			ok: true,
			value: expected,
		});
	});

	it('rejects cross-agent host paths with guidance', () => {
		const result = resolveOpenClawToolVmPathIntent({
			agentWorkspaceDir: '/zone/agents/beta',
			inputPath: '/zone/agents/alpha/app',
		});

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'unknown-runtime-path',
				inputPath: '/zone/agents/alpha/app',
				retryGuidance:
					'Use one of the allowed path forms for openclaw-tool-vm executionCwd: /workspace[/subpath], /zone/agents/beta[/subpath], /work[/subpath].',
			},
		});
	});

	it('rejects relative paths', () => {
		const result = resolveOpenClawToolVmPathIntent({
			agentWorkspaceDir: '/zone/agents/beta',
			inputPath: 'relative/path',
		});

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'path-not-absolute',
			},
		});
	});
});
```

- [ ] **Step 2: Run plugin mapping tests to verify failure**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts
```

Expected: FAIL with a module resolution error for `./openclaw-tool-vm-path-mapping.js`.

- [ ] **Step 3: Implement plugin mapping projection**

Create `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.ts`:

```ts
import {
	TOOL_VM_SCRATCH_GUEST_ROOT,
	TOOL_VM_WORKSPACE_GUEST_ROOT,
	translateRuntimePath,
	type RuntimePathMapping,
	type RuntimePathTranslation,
	type RuntimePathTranslationError,
} from '@agent-vm/gateway-interface';

export type OpenClawToolVmPathIntentKind =
	| 'host-workspace-root'
	| 'host-workspace-subpath'
	| 'workspace-root'
	| 'workspace-subpath'
	| 'scratch-root'
	| 'scratch-subpath';

export interface OpenClawToolVmPathIntentResolution {
	readonly effectiveGuestCwd: string;
	readonly hostEquivalentPath?: string;
	readonly kind: OpenClawToolVmPathIntentKind;
	readonly leaseWorkMountDir: string;
}

export type OpenClawToolVmPathIntentResult =
	| {
			readonly ok: true;
			readonly value: OpenClawToolVmPathIntentResolution;
	  }
	| {
			readonly ok: false;
			readonly error: RuntimePathTranslationError;
	  };

export class OpenClawToolVmPathIntentError extends Error {
	readonly details: RuntimePathTranslationError;

	constructor(details: RuntimePathTranslationError) {
		super(`${details.message} ${details.retryGuidance}`);
		this.name = 'OpenClawToolVmPathIntentError';
		this.details = details;
	}
}

function createOpenClawToolVmPathMapping(options: {
	readonly agentWorkspaceDir: string;
}): RuntimePathMapping {
	return {
		id: 'openclaw-tool-vm',
		roots: [
			{
				id: 'agent-workspace',
				guestRoot: TOOL_VM_WORKSPACE_GUEST_ROOT,
				hostRoot: options.agentWorkspaceDir,
				backing: {
					kind: 'host-realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: true,
					leaseMount: true,
				},
				rootPathAllowed: true,
				guidanceLabel: 'agent workspace',
			},
			{
				id: 'tool-vm-scratch',
				guestRoot: TOOL_VM_SCRATCH_GUEST_ROOT,
				backing: {
					kind: 'guest-rootfs-cow',
					durability: 'vm-lifetime',
				},
				capabilities: {
					executionCwd: true,
					leaseMount: false,
				},
				rootPathAllowed: true,
				guidanceLabel: 'Tool VM scratch',
			},
		],
	};
}

function kindForTranslation(translation: RuntimePathTranslation): OpenClawToolVmPathIntentKind {
	const isRoot = translation.relativePath === '';
	if (translation.rootId === 'tool-vm-scratch') {
		return isRoot ? 'scratch-root' : 'scratch-subpath';
	}
	if (translation.inputNamespace === 'host') {
		return isRoot ? 'host-workspace-root' : 'host-workspace-subpath';
	}
	return isRoot ? 'workspace-root' : 'workspace-subpath';
}

export function resolveOpenClawToolVmPathIntent(options: {
	readonly agentWorkspaceDir: string;
	readonly inputPath: string;
}): OpenClawToolVmPathIntentResult {
	const translation = translateRuntimePath({
		mapping: createOpenClawToolVmPathMapping({
			agentWorkspaceDir: options.agentWorkspaceDir,
		}),
		inputPath: options.inputPath,
		purpose: 'executionCwd',
	});
	if (!translation.ok) {
		return translation;
	}
	return {
		ok: true,
		value: {
			effectiveGuestCwd: translation.value.guestPath ?? TOOL_VM_WORKSPACE_GUEST_ROOT,
			...(translation.value.hostPath !== undefined
				? { hostEquivalentPath: translation.value.hostPath }
				: {}),
			kind: kindForTranslation(translation.value),
			leaseWorkMountDir: translation.value.hostRoot ?? options.agentWorkspaceDir,
		},
	};
}

export function assertOpenClawToolVmPathIntent(options: {
	readonly agentWorkspaceDir: string;
	readonly inputPath: string;
}): OpenClawToolVmPathIntentResolution {
	const result = resolveOpenClawToolVmPathIntent(options);
	if (!result.ok) {
		throw new OpenClawToolVmPathIntentError(result.error);
	}
	return result.value;
}
```

- [ ] **Step 4: Run plugin mapping tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts
git commit -m "feat: add openclaw tool vm path mapping"
```

---

### Task 3: Use Plugin Mapping At Lease And Exec Boundaries

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts`
- Test: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`

- [ ] **Step 1: Add failing integration tests for cwd aliases and cache identity**

Add these tests to `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts` near the existing lease request tests:

`scopeKey` remains in these factory inputs only because OpenClaw's sandbox backend API supplies it. These tests must prove the plugin discards it before calling the controller.

```ts
it('normalizes /workspace subpaths before requesting a controller lease', async () => {
	const leaseClient = createFakeLeaseClient({
		lease: {
			...fakeLease,
			workdir: '/workspace',
		},
	});
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			...fakeDependencies,
			createLeaseClient: () => leaseClient,
		},
	);

	const handle = await factory({
		agentWorkspaceDir: '/zone/agents/beta',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:subagent:child',
		sessionKey: 'agent:beta:subagent:child',
		workspaceDir: '/workspace/app',
	});

	expect(leaseClient.requestLease).toHaveBeenCalledWith(
		expect.objectContaining({
			agentId: 'beta',
			agentWorkspaceDir: '/zone/agents/beta',
			workMountDir: '/zone/agents/beta',
			zoneId: 'shravan',
		}),
	);
	expect(handle.workdir).toBe('/workspace/app');
});

it('normalizes /work scratch cwd without sending /work as lease workMountDir', async () => {
	const leaseClient = createFakeLeaseClient({
		lease: {
			...fakeLease,
			workdir: '/workspace',
		},
	});
	const buildExecSpec = vi.fn(fakeDependencies.buildExecSpec);
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			...fakeDependencies,
			buildExecSpec,
			createLeaseClient: () => leaseClient,
		},
	);

	const handle = await factory({
		agentWorkspaceDir: '/zone/agents/beta',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:subagent:child',
		sessionKey: 'agent:beta:subagent:child',
		workspaceDir: '/work/tmp',
	});
	await handle.buildExecSpec({
		command: 'pwd',
		env: {},
		usePty: false,
	});

	expect(leaseClient.requestLease).toHaveBeenCalledWith(
		expect.objectContaining({
			workMountDir: '/zone/agents/beta',
		}),
	);
	expect(handle.workdir).toBe('/work/tmp');
	expect(buildExecSpec).toHaveBeenCalledWith(
		expect.objectContaining({
			workdir: '/work/tmp',
		}),
	);
});

it('reuses one cached lease for the same agent when only cwd intent differs', async () => {
	const leaseClient = createFakeLeaseClient({
		lease: {
			...fakeLease,
			workdir: '/workspace',
		},
	});
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			...fakeDependencies,
			createLeaseClient: () => leaseClient,
		},
	);

	const firstHandle = await factory({
		agentWorkspaceDir: '/zone/agents/beta',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:discord:channel:123',
		sessionKey: 'agent:beta:discord:channel:123',
		workspaceDir: '/workspace/app',
	});
	const secondHandle = await factory({
		agentWorkspaceDir: '/zone/agents/beta',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:subagent:child',
		sessionKey: 'agent:beta:subagent:child',
		workspaceDir: '/work/tmp',
	});

	expect(secondHandle).not.toBe(firstHandle);
	expect(firstHandle.runtimeId).toBe(secondHandle.runtimeId);
	expect(firstHandle.workdir).toBe('/workspace/app');
	expect(secondHandle.workdir).toBe('/work/tmp');
	expect(leaseClient.requestLease).toHaveBeenCalledTimes(1);
	expect(leaseClient.renewLease).toHaveBeenCalledTimes(1);
	});
```

Use the local fixture helper names already present in this file. If the current file uses different helper names than `createFakeLeaseClient`, `fakeLease`, `fakeDependencies`, or `gondolinSandboxConfig`, adapt only the names, not the assertions.

- [ ] **Step 2: Run the failing plugin integration tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts -t "normalizes /workspace|normalizes /work|reuses one cached lease"
```

Expected: FAIL because the plugin currently sends `params.workspaceDir` directly as `workMountDir`, returns `lease.workdir` as handle workdir, and returns the cached handle instead of rebuilding a per-call handle with the current cwd intent.

- [ ] **Step 3: Update plugin cache key and handle state**

Modify `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`.

Import the mapping helper:

```ts
import { assertOpenClawToolVmPathIntent } from './openclaw-tool-vm-path-mapping.js';
```

Replace `agentLeaseCacheKey` with:

```ts
function agentLeaseCacheKey(params: {
	readonly agentId: string;
	readonly zoneId: string;
}): string {
	return [params.zoneId, params.agentId].join('\0');
}
```

Inside the factory, resolve the path before computing the cache key:

```ts
const pathIntent = assertOpenClawToolVmPathIntent({
	agentWorkspaceDir: params.agentWorkspaceDir,
	inputPath: params.workspaceDir,
});
const cacheKey = agentLeaseCacheKey({
	agentId,
	zoneId: options.zoneId,
});
```

Do not stringify path translation errors at this boundary. `assertOpenClawToolVmPathIntent` throws `OpenClawToolVmPathIntentError` with structured `details`, so callers and tests can inspect `code`, `allowedPathForms`, `mappingId`, `purpose`, and `retryGuidance`.

Change the controller request:

```ts
const leaseResponse = await leaseClient.requestLease({
	agentId,
	agentWorkspaceDir: params.agentWorkspaceDir,
	profileId,
	sessionKey: params.sessionKey,
	workMountDir: pathIntent.leaseWorkMountDir,
	zoneId: options.zoneId,
});
```

Cache the lease, not the handle. The lease identity is agent-scoped; the effective cwd is request-local execution intent:

```ts
export interface CachedAgentLeaseEntry {
	readonly lease: ToolVmSshLease;
}
```

```ts
agentLeaseCache.set(cacheKey, { lease });
```

On cache hit, renew/probe the cached lease and continue to the handle creation below. Do not `return cachedEntry.handle`; there is no cached handle after this change.

Pass the current effective cwd into the new handle for this factory call:

```ts
const handle = createSandboxBackendHandle({
	cfg: params.cfg,
	controllerUrl: options.controllerUrl,
	createFsBridgeBuilder: dependencies.createFsBridgeBuilder,
	effectiveGuestCwd: pathIntent.effectiveGuestCwd,
	lease,
	leaseClient,
	runRemoteShellScript: dependencies.runRemoteShellScript,
	buildExecSpec: dependencies.buildExecSpec,
	sessionKey: params.sessionKey,
	zoneId: options.zoneId,
});
```

Add `effectiveGuestCwd` to `createSandboxBackendHandle` options:

```ts
readonly effectiveGuestCwd: string;
```

Use it in the handle:

```ts
const createFsBridge = options.createFsBridgeBuilder?.({
	remoteAgentWorkspaceDir: options.lease.workdir,
	remoteWorkspaceDir: options.effectiveGuestCwd,
	runRemoteShellScript: boundRunRemoteShellScript,
});
```

```ts
workdir: options.effectiveGuestCwd,
```

```ts
workdir: execParams.workdir ?? options.effectiveGuestCwd,
```

Keep `remoteAgentWorkspaceDir` as `options.lease.workdir` because the lease response is the mounted workspace root, while `remoteWorkspaceDir` is the selected cwd/workspace intent.

- [ ] **Step 4: Run plugin integration tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts -t "normalizes /workspace|normalizes /work|reuses one cached lease"
```

Expected: PASS.

- [ ] **Step 5: Run all plugin tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts
git commit -m "fix: normalize openclaw tool vm cwd intents"
```

---

### Task 4: Reuse Translator In Controller Lease Path Resolver

**Files:**
- Create: `packages/agent-vm/src/controller/leases/openclaw-gateway-lease-path-mapping.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts`
- Test: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts`

- [ ] **Step 1: Add a test that controller rejects Tool VM guest paths with structured kinds**

Add to `packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts`:

```ts
it.each(['/workspace', '/workspace/app', '/work', '/work/tmp'])(
	'rejects Tool VM guest path %s as controller lease workMountDir',
	async (workMountDir) => {
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir,
				zone,
			}),
		).rejects.toMatchObject({
			kind: 'outside-allowed-roots',
		} satisfies Partial<LeaseWorkMountValidationError>);
	},
);
```

This proves the controller is still a hard guard if the plugin fails to normalize.

- [ ] **Step 2: Run the targeted controller resolver tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts
```

Expected: PASS before refactor. This is a characterization test for behavior that must survive the refactor.

- [ ] **Step 3: Add controller mapping builder**

Create `packages/agent-vm/src/controller/leases/openclaw-gateway-lease-path-mapping.ts`:

```ts
import path from 'node:path';

import type { RuntimePathMapping } from '@agent-vm/gateway-interface';

import { OPENCLAW_ZONE_FILES_GUEST_ROOT } from '../zone-git/zone-git-paths.js';

export const OPENCLAW_STATE_VM_ROOT = '/home/openclaw/.openclaw/state';
export const OPENCLAW_STATE_SANDBOXES_VM_ROOT = `${OPENCLAW_STATE_VM_ROOT}/sandboxes`;

export function createOpenClawGatewayLeasePathMapping(options: {
	readonly stateDir: string;
	readonly zoneFilesDir: string;
}): RuntimePathMapping {
	return {
		id: 'openclaw-gateway-lease',
		roots: [
			{
				id: 'openclaw-sandboxes',
				guestRoot: OPENCLAW_STATE_SANDBOXES_VM_ROOT,
				hostRoot: path.join(options.stateDir, 'sandboxes'),
				backing: {
					kind: 'host-realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: false,
					leaseMount: true,
				},
				rootPathAllowed: false,
				guidanceLabel: 'OpenClaw sandbox work directory',
			},
			{
				id: 'zone-files',
				guestRoot: OPENCLAW_ZONE_FILES_GUEST_ROOT,
				hostRoot: options.zoneFilesDir,
				backing: {
					kind: 'host-realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: false,
					leaseMount: true,
				},
				rootPathAllowed: false,
				guidanceLabel: 'OpenClaw zone files',
			},
		],
	};
}
```

- [ ] **Step 4: Refactor `lease-work-mount-paths.ts` to use the mapping**

In `packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts`, import:

```ts
import { translateRuntimePath } from '@agent-vm/gateway-interface';
import {
	OPENCLAW_STATE_SANDBOXES_VM_ROOT,
	createOpenClawGatewayLeasePathMapping,
} from './openclaw-gateway-lease-path-mapping.js';
```

Remove the local `OPENCLAW_STATE_VM_ROOT`, `OPENCLAW_STATE_SANDBOXES_VM_ROOT`, and `mapGuestPathToHostPath` definitions.

Extend `LeaseWorkMountValidationError` so translation guidance can cross the resolver/HTTP boundary without duplicating strings:

```ts
interface LeaseWorkMountValidationErrorOptions extends ErrorOptions {
	readonly guidance?: string;
}

export class LeaseWorkMountValidationError extends Error {
	readonly guidance?: string;
	readonly kind: LeaseWorkMountValidationErrorKind;

	constructor(
		kind: LeaseWorkMountValidationErrorKind,
		message: string,
		options?: LeaseWorkMountValidationErrorOptions,
	) {
		super(message, options);
		this.name = 'LeaseWorkMountValidationError';
		this.guidance = options?.guidance;
		this.kind = kind;
	}
}
```

Inside `resolveLeaseWorkMountDir`, replace the `hostWorkMountDir` computation with:

```ts
const translation = translateRuntimePath({
	mapping: createOpenClawGatewayLeasePathMapping({
		stateDir: options.zone.gateway.stateDir,
		zoneFilesDir: options.zone.gateway.zoneFilesDir,
	}),
	inputPath: options.workMountDir,
	purpose: 'leaseMount',
});
if (!translation.ok) {
	const kind =
		translation.error.code === 'root-path-not-allowed'
			? 'root-mount-target'
			: 'outside-allowed-roots';
	throw new LeaseWorkMountValidationError(
		kind,
		translation.error.message,
		{ guidance: translation.error.retryGuidance },
	);
}
const hostWorkMountDir = translation.value.hostPath;
if (!hostWorkMountDir) {
	throw new LeaseWorkMountValidationError(
		'outside-allowed-roots',
		`Lease workMountDir '${options.workMountDir}' must resolve to a host-backed path.`,
	);
}
```

Keep all existing `realpath` validation and zone-git logic. For the zone-git condition, use the existing normalized path:

```ts
normalizedWorkMountDir.startsWith(`${OPENCLAW_ZONE_FILES_VM_ROOT}/`)
```

- [ ] **Step 5: Run controller resolver tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/agent-vm/src/controller/leases/openclaw-gateway-lease-path-mapping.ts packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts
git commit -m "refactor: share openclaw lease path translation"
```

---

### Task 5: Surface Actionable Path Errors At HTTP Boundary

**Files:**
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Test: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`

- [ ] **Step 1: Write failing HTTP guidance test**

Add to `packages/agent-vm/src/controller/http/controller-http-routes.test.ts` near the unsafe workMountDir tests:

```ts
it('returns retry guidance when lease workMountDir is a Tool VM guest path', async () => {
	const app = createControllerAppForTest({
		resolveLeaseWorkMountDir: async () => {
			throw new LeaseWorkMountValidationError(
				'outside-allowed-roots',
				"Path '/work/tmp' matched Tool VM scratch but cannot be used for leaseMount.",
				{
					guidance:
						'Use one of the allowed path forms for openclaw-gateway-lease leaseMount: /zone/<child>, /home/openclaw/.openclaw/state/sandboxes/<child>.',
				},
			);
		},
	});

	const response = await app.request('/lease', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			...validLeaseCreateRequest,
			workMountDir: '/work/tmp',
		}),
	});

	await expect(response.json()).resolves.toMatchObject({
		error: 'workMountDir outside allowed roots',
		guidance: expect.stringContaining('/zone/<child>'),
	});
	expect(response.status).toBe(400);
});
```

Use the actual local helper names in this test file if they differ from `createControllerAppForTest` or `validLeaseCreateRequest`.

- [ ] **Step 2: Run failing HTTP guidance test**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts -t "returns retry guidance when lease workMountDir is a Tool VM guest path"
```

Expected: FAIL because the response does not yet include the new guidance field.

- [ ] **Step 3: Add structured guidance to `LeaseWorkMountValidationError` response**

In `packages/agent-vm/src/controller/http/controller-http-routes.ts`, inside the `catch (error)` branch for `LeaseWorkMountValidationError`, return:

```ts
return context.json(
	{
		error:
			error.kind === 'outside-allowed-roots'
				? 'workMountDir outside allowed roots'
				: error.kind,
		...(error.guidance !== undefined ? { guidance: error.guidance } : {}),
		message: error.message,
	},
	400,
);
```

- [ ] **Step 4: Run HTTP guidance test**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts -t "returns retry guidance when lease workMountDir is a Tool VM guest path"
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/agent-vm/src/controller/http/controller-http-routes.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
git commit -m "fix: return lease path retry guidance"
```

---

### Task 6: Add Hermetic Plugin Smoke For Subagent Cwd Matrix

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.smoke.test.ts`

- [ ] **Step 1: Add failing smoke coverage for `/workspace` and `/work` cwd aliases**

Add to `packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.smoke.test.ts`:

`scopeKey` remains in this smoke input only because OpenClaw's sandbox backend API supplies it. The recorded controller request must never include it.

```ts
it('normalizes Tool VM guest cwd aliases without forking the agent lease', async () => {
	const leaseClient = createRecordingLeaseClient({
		lease: buildToolVmLease({
			agentId: 'beta',
			leaseId: '018f70d2-4c1f-7b7a-9b8a-111111111111',
			workdir: '/workspace',
		}),
	});
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			...buildSmokeBackendDependencies(),
			createLeaseClient: () => leaseClient,
		},
	);

	const workspaceHandle = await factory({
		agentWorkspaceDir: '/zone/agents/beta',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:discord:channel:123',
		sessionKey: 'agent:beta:discord:channel:123',
		workspaceDir: '/workspace/app',
	});
	const scratchHandle = await factory({
		agentWorkspaceDir: '/zone/agents/beta',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:subagent:child',
		sessionKey: 'agent:beta:subagent:child',
		workspaceDir: '/work/tmp',
	});

	expect(scratchHandle).toBe(workspaceHandle);
	expect(leaseClient.requests).toEqual([
		expect.objectContaining({
			agentId: 'beta',
			agentWorkspaceDir: '/zone/agents/beta',
			workMountDir: '/zone/agents/beta',
			zoneId: 'shravan',
		}),
	]);
	expect(leaseClient.requests[0]).not.toHaveProperty('scopeKey');
	expect(workspaceHandle.workdir).toBe('/workspace/app');
});
```

If this smoke file already has a recording fake lease client, reuse it and preserve its request-array naming.

- [ ] **Step 2: Run the smoke test and verify failure**

Run:

```bash
pnpm vitest run --config vitest.smoke.config.ts packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.smoke.test.ts -t "normalizes Tool VM guest cwd aliases"
```

Expected: FAIL until Task 3 is implemented and until the smoke fake expects the new request shape.

- [ ] **Step 3: Adjust smoke fake helpers to the new request shape**

Make the smoke fake request type match the plugin request body after this plan:

```ts
interface RecordedLeaseRequest {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly profileId?: string;
	readonly sessionKey: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}
```

The fake must reject extra legacy fields:

```ts
expect(request).not.toHaveProperty('scopeKey');
expect(request).not.toHaveProperty('sandbox');
expect(request).not.toHaveProperty('workspaceDir');
```

- [ ] **Step 4: Run the smoke test**

Run:

```bash
pnpm vitest run --config vitest.smoke.config.ts packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.smoke.test.ts -t "normalizes Tool VM guest cwd aliases"
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.smoke.test.ts
git commit -m "test: smoke tool vm cwd path aliases"
```

---

### Task 7: Update Docs With Code Ownership And Runtime Standards

**Files:**
- Modify: `docs/architecture/storage-model.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Test: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Update storage model with translator ownership**

In `docs/architecture/storage-model.md`, add this under `Lease Path Vocabulary`:

```markdown
Runtime path translation is implemented as a shared pure translator in
`@agent-vm/gateway-interface`. The shared code owns path mechanics: absolute
path normalization, parent-traversal rejection, longest-root matching, relative
path calculation, guest-to-host and host-to-guest mapping, storage backing
classification, and structured retry guidance.

Runtime packages inject their own mapping facts. The OpenClaw plugin injects the
Tool VM mapping where `/workspace` is the RealFS workspace mount and `/work` is
Tool VM rootfs/COW scratch. The controller injects the OpenClaw gateway lease
mapping where `/zone` maps to `zoneFilesDir` and
`/home/openclaw/.openclaw/state/sandboxes` maps to `stateDir/sandboxes`.
```

- [ ] **Step 2: Update OpenClaw gateway doc with plugin/controller split**

In `docs/architecture/openclaw-gateway.md`, add this in the Sandbox Plugin section:

```markdown
The OpenClaw plugin normalizes workspace/cwd intent before calling the
controller. Known Tool VM guest paths are allowed as intent: `/workspace` maps
to the mounted agent workspace, while `/work` stays Tool VM rootfs/COW scratch.
The plugin sends the controller only the lease mount source and keeps the
effective guest cwd on the backend handle for SSH execution.

The controller remains the security boundary for host mounts. It accepts
controller-supported OpenClaw gateway paths such as `/zone/<child>` and
`/home/openclaw/.openclaw/state/sandboxes/<child>`, translates them to host
paths, and proves the resolved path is inside the configured allowed roots
before booting a Tool VM.
```

- [ ] **Step 3: Update generated manual template**

In `packages/agent-vm/src/cli/manual-templates.ts`, update the runtime paths manual text so it states the current split:

```markdown
The OpenClaw plugin may accept Tool VM guest cwd intent such as `/workspace`,
`/workspace/<child>`, `/work`, or `/work/<child>`. The plugin translates that
intent before it calls the controller.

The controller `/lease workMountDir` is stricter: it accepts only
controller-supported OpenClaw gateway paths such as `/zone/<child>` or
`/home/openclaw/.openclaw/state/sandboxes/<child>`. Direct Tool VM guest paths
such as `/workspace` and `/work` are rejected at the controller boundary.
```

Keep this concise; generated manuals are operational guidance, not the full architecture doc.

- [ ] **Step 4: Update generated manual tests**

In `packages/agent-vm/src/cli/manual-templates.test.ts`, add or update assertions for the generated runtime paths manual:

```ts
expect(runtimePathsManual).toContain('The OpenClaw plugin may accept Tool VM guest cwd intent');
expect(runtimePathsManual).toContain('The controller `/lease workMountDir` is stricter');
expect(runtimePathsManual).toContain('Direct Tool VM guest paths such as `/workspace` and `/work` are rejected at the controller boundary');
```

Use the local variable/helper names already present in `manual-templates.test.ts`.

- [ ] **Step 5: Run docs grep checks**

Run:

```bash
rg -n "Tool VM guest paths are rejected|rejects /workspace|/workMountDir = /work|workspaceDir.*workMountDir" docs packages/agent-vm/src/cli/manual-templates.ts
```

Expected: no result that claims `/workspace` or `/work` are always rejected at the plugin boundary. Results that say the controller rejects guest paths in `/lease workMountDir` are acceptable.

- [ ] **Step 6: Run manual template tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add docs/architecture/storage-model.md docs/architecture/openclaw-gateway.md packages/agent-vm/src/cli/manual-templates.ts packages/agent-vm/src/cli/manual-templates.test.ts
git commit -m "docs: describe runtime path mapping ownership"
```

---

### Task 8: Full Verification

**Files:**
- No source edits unless verification finds a regression.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run plugin package tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src
```

Expected: PASS.

- [ ] **Step 3: Run agent-vm controller targeted tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run smoke tests**

Run:

```bash
mise exec -- pnpm test:smoke
```

Expected: PASS, with live Gondolin/OpenClaw tests skipped unless required env vars are set.

- [ ] **Step 5: Run full quality gate**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 6: Run broader tests if branch is intended for PR**

Run:

```bash
pnpm test:unit
pnpm test:integration
pnpm build
```

Expected: PASS.

- [ ] **Step 7: Final commit if verification required fixes**

If verification required fixes, commit them:

```bash
git status --short
git add <changed-files>
git commit -m "fix: stabilize runtime path mapping"
```

Expected: the final `git status --short` is empty after the commit.

---

## Self-Review

Spec coverage:

- One shared translator: Task 1.
- Runtime-specific injected mappings: Tasks 2 and 4.
- Plugin handles `/workspace` and `/work`: Tasks 2, 3, and 6.
- `/work` is scratch cwd, not lease mount source: Tasks 1, 2, 3, and 6.
- Controller remains host mount security boundary: Task 4.
- Structured retry guidance: Tasks 1 and 5.
- No duplicated path matrix: Tasks 1, 2, and 4 split generic mechanics from injected mapping facts.
- Runtime standards differ by gateway/runtime: docs in Task 7 and worker explicitly excluded from first implementation.

Placeholder scan:

- The plan contains no forbidden placeholder tokens or placeholder implementation steps.
- Every code step names concrete files and shows the code shape to add.
- Where existing test helper names may differ, the expected assertions are fully specified and the only allowed adaptation is fixture naming.

Type consistency:

- `RuntimePathMapping`, `RuntimePathRootMapping`, `RuntimePathBacking`, `RuntimePathCapabilities`, `RuntimePathTranslation`, and `RuntimePathTranslationError` are defined in Task 1 and reused consistently.
- Plugin projection returns `OpenClawToolVmPathIntentResolution` with `leaseWorkMountDir` and `effectiveGuestCwd`, and Task 3 uses those exact names.
- Controller mapping builder returns `RuntimePathMapping`, and Task 4 uses `translateRuntimePath` with `purpose: 'leaseMount'`.
