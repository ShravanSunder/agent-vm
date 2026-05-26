# Bidirectional Runtime Path Translator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove a pure bidirectional runtime path translator so OpenClaw/Gondolin plugin code can convert Tool VM guest paths like `/workspace` into valid controller lease sources like `/zone/agents/beta`, and controller code can convert OpenClaw/Gondolin paths into host backing paths without confusing path languages.

**Architecture:** `@agent-vm/gateway-interface` owns the pure translator and typed path-land vocabulary. OpenClaw plugin code injects the agent-specific mapping and translates Tool VM/OpenClaw cwd intent into `{ leaseWorkMountDir, effectiveGuestCwd }`; controller code injects zone runtime mapping and translates controller lease mounts into host backing paths. Tests follow the pyramid: pure unit tests for translator rules, plugin/controller integration tests for request contracts, and a real OpenClaw subagent E2E smoke that proves the beta failure path.

**Tech Stack:** TypeScript, Vitest, Zod-adjacent explicit types, Node 24, pnpm, OpenClaw sandbox backend plugin, agent-vm controller, Gondolin smoke harness.

---

## Current Failure Model

The previous runtime path mapper exists, but it assumes `agentWorkspaceDir` is already the canonical OpenClaw/Gondolin source path.

That assumption is false in the real beta subagent flow:

```text
OpenClaw parent Tool VM context:
  workspaceDir = /workspace

OpenClaw sessions_spawn same-agent subagent:
  inherits opts.workspaceDir

OpenClaw sandbox context for child:
  agentWorkspaceDir = /workspace
  workspaceDir      = /workspace

Current plugin mapper:
  source root = params.agentWorkspaceDir = /workspace
  input path  = params.workspaceDir      = /workspace
  output      = workMountDir            = /workspace

Controller:
  rejects /workspace for openclaw-gateway-lease
```

The controller is correct to reject `/workspace`. `/workspace` is a Tool VM guest path. The plugin must translate it before the controller sees it.

## Mistakes This Plan Must Not Repeat

This section is part of the technical spec because these were not process nits; they were model failures that created the current bug.

```text
Mistake 1: Calling integration proof "smoke"
  What happened:
    The previous work treated repo smoke harness and plugin-level tests as enough.

  Why it was wrong:
    The real bug lived across OpenClaw parent -> subagent -> backend factory
    -> plugin -> controller -> Tool VM. Unit and integration tests did not
    exercise that full path.

  Requirement:
    A smoke test for this work means real E2E, or an explicitly documented
    manual beta E2E proof with commands, logs, and pass/fail evidence.

Mistake 2: Testing only canonical agentWorkspaceDir
  What happened:
    Tests covered agentWorkspaceDir=/zone/agents/beta and workspaceDir=/workspace.

  Why it was wrong:
    Beta proved OpenClaw can pass agentWorkspaceDir=/workspace and
    workspaceDir=/workspace after subagent inheritance.

  Requirement:
    The poisoned-root permutation is the acceptance case:
      agentId=beta
      agentWorkspaceDir=/workspace
      workspaceDir=/workspace
    must produce:
      controller agentWorkspaceDir=/zone/agents/beta
      controller workMountDir=/zone/agents/beta
      Tool VM effective cwd=/workspace

Mistake 3: Treating the mapper as one-directional
  What happened:
    The mapper mostly handled "guest cwd plus already-known source root".

  Why it was wrong:
    The system needs a path-language translator. Callers need to project
    between Tool VM guest, OpenClaw/Gondolin gateway, and controller-host
    locations deliberately.

  Requirement:
    The generic translator must support both directions between declared
    path namespaces, with injected mappings and no filesystem side effects.

Mistake 4: Letting controller boundary compensate for plugin leakage
  What happened:
    The controller correctly rejected /workspace, but the previous proof did
    not guarantee the plugin would never send it.

  Why it was wrong:
    The controller is the security boundary. It should reject guest paths.
    The plugin is the adapter boundary. It should translate guest paths.

  Requirement:
    Controller rejection stays. Plugin canonicalization and translation are
    the fix.

Mistake 5: Not validating the goal with subagents
  What happened:
    Same-agent lease reuse was tested, but not through the real OpenClaw
    subagent creation flow.

  Why it was wrong:
    The user-visible failure is subagent runtime failure, not just a bad
    function output.

  Requirement:
    The goal is not met until a same-agent subagent runs successfully and
    proves no /workspace lease mount reaches the controller.
```

## Required Mental Model

```text
┌──────────────────────┬───────────────────────────────┬──────────────────────┐
│ Path land             │ Examples                      │ Owner at boundary    │
├──────────────────────┼───────────────────────────────┼──────────────────────┤
│ tool-vm-guest         │ /workspace, /workspace/app,   │ Tool VM command cwd  │
│                       │ /work/tmp                     │                      │
├──────────────────────┼───────────────────────────────┼──────────────────────┤
│ openclaw-gateway      │ /zone/agents/beta,            │ Plugin lease request │
│                       │ /home/openclaw/.openclaw/     │                      │
│                       │ state/sandboxes/<child>       │                      │
├──────────────────────┼───────────────────────────────┼──────────────────────┤
│ controller-host       │ ~/.agent-vm/state/<zone>/..., │ Controller backing   │
│                       │ <zoneFilesDir>/agents/beta    │ path after realpath  │
└──────────────────────┴───────────────────────────────┴──────────────────────┘
```

The pure translator must be able to answer both directions:

```text
tool-vm-guest    /workspace/app
  -> openclaw-gateway /zone/agents/beta

openclaw-gateway /zone/agents/beta/app
  -> tool-vm-guest    /workspace/app

openclaw-gateway /zone/agents/beta
  -> controller-host  <zoneFilesDir>/agents/beta
```

The translator does not discover runtime roots. Callers inject the mapping.

## File Structure

### Generic Pure Translator

- Modify: `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.ts`
  - Replace the misleading two-slot `guestRoot` / `hostRoot` model with a namespace-based root model.
  - Keep the translator pure: no filesystem, no process state, no OpenClaw imports.
  - Support explicit source and target namespaces.
  - Preserve structured errors and guidance.

- Modify: `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts`
  - Unit test bidirectional translation, target capabilities, exact root rules, invalid roots, parent traversal, and unknown path failures.

- Modify: `packages/gateway-interface/src/index.ts`
  - Export new path namespace/types/helpers.

### OpenClaw Plugin Mapping

- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.ts`
  - Use the generic translator with `tool-vm-guest` and `openclaw-gateway` locations.
  - Return both `leaseWorkMountDir` and `effectiveGuestCwd`.
  - Accept a canonical `agentWorkspaceSourceDir`, not blindly `params.agentWorkspaceDir`.

- Create: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-agent-workspace-source.ts`
  - Resolve canonical OpenClaw/Gondolin workspace source for `agentId`.
  - If OpenClaw passes `/workspace` or `/work` as `agentWorkspaceDir`, treat it as guest-land leakage and resolve from runtime config.
  - If runtime config cannot provide a canonical source, throw a clear structured error.

- Create: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-agent-workspace-source.test.ts`
  - Unit test exact beta poisoned-root case and config fallback rules.

- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
  - Call the canonical workspace resolver before path translation.
  - Cache compatibility uses canonical workspace source, not raw `params.agentWorkspaceDir`.
  - Controller request sends canonical `agentWorkspaceDir` and translated `workMountDir`.

- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts`
  - Add a runtime config provider dependency if needed by the factory.

- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
  - Pass `api.runtime.config.current() ?? api.config` into the backend factory as the runtime config provider.

- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`
  - Add integration tests proving the real beta poisoned-root input produces a valid `/zone/...` lease request.

- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.test.ts`
  - Add agent/subagent permutations with cwd set and cwd unset.

### Controller Mapping

- Modify: `packages/agent-vm/src/controller/leases/openclaw-gateway-lease-path-mapping.ts`
  - Build controller mapping using the new namespace translator:
    `openclaw-gateway -> controller-host`.

- Modify: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts`
  - Keep controller rejection for `/workspace` and `/work`.
  - Preserve realpath validation as the security boundary.
  - Use structured translator errors instead of collapsing all failures to one kind.

- Modify: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts`
  - Unit/integration tests for each translator error code and accepted `/zone/<child>` / sandbox child paths.

### Real E2E Smoke

- Create: `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.smoke.test.ts`
  - Boot real smoke controller + OpenClaw gateway when `AGENT_VM_OPENCLAW_SMOKE=1`.
  - Trigger real OpenClaw subagent spawn from a parent context where cwd is `/workspace`.
  - Assert child output returns.
  - Assert no controller lease request contains `workMountDir: "/workspace"`.
  - Assert only one agent-level lease exists for the same agent.

- Modify: `packages/agent-vm/src/integration-tests/smoke-harness.ts`
  - Add a helper for invoking OpenClaw gateway tools/messages needed by the subagent smoke.
  - Add controller lease request observation if not already exposed by existing harness hooks.

- Modify: `AGENTS.md`
  - Define test taxonomy:
    - unit = pure logic
    - integration = package/controller boundary
    - smoke = real E2E or explicitly manual E2E
  - State that OpenClaw subagent lease changes require the subagent E2E smoke or a documented manual beta E2E proof.

---

## Task 0: Adversarial Plan Review Before Implementation

**Files:**
- Review only: `docs/superpowers/plans/2026-05-26-bidirectional-runtime-path-translator.md`
- Review only: `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.ts`
- Review only: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.ts`
- Review only: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
- Review only: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts`
- Review only: `packages/agent-vm/src/integration-tests/smoke-harness.ts`
- Review only: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/sandbox/context.ts`
- Review only: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/tools/sessions-spawn-tool.ts`
- Review only: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/agent-scope-config.ts`

- [ ] **Step 1: Send adversarial review prompt**

Use this exact prompt for a reviewer agent:

```text
You are reviewing an implementation plan after a failed prior PR.

Be adversarial. Do not be agreeable. Your job is to find where this
plan would still fail beta.

Plan:
  /Users/shravansunder/Documents/dev/project-dev/agent-vm/docs/superpowers/plans/2026-05-26-bidirectional-runtime-path-translator.md

Current code to inspect:
  /Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/gateway-interface/src/runtime-paths/runtime-path-mapping.ts
  /Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.ts
  /Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts
  /Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts
  /Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/integration-tests/smoke-harness.ts

OpenClaw upstream code to inspect:
  /Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/sandbox/context.ts
  /Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/tools/sessions-spawn-tool.ts
  /Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/agent-scope-config.ts

Known beta failure shape:
  agentId=beta
  agentWorkspaceDir=/workspace
  workspaceDir=/workspace
  controller rejects workMountDir=/workspace

Questions:
  1. Does the plan truly make path translation bidirectional across Tool VM guest,
     OpenClaw/Gondolin gateway, and controller-host path languages?
  2. Does it prove the real subagent path, not just plugin unit behavior?
  3. Does it keep the controller security boundary intact?
  4. Does it keep leases per zoneId + agentId only, with no scope/cwd/path identity leak?
  5. Does the test pyramid have useful unit, integration, and real E2E smoke coverage?
  6. Where can stale config, missing config, /work, /workspace subpaths, or cross-agent
     paths still break?
  7. Are any tests mislabeled as smoke when they are really unit/integration tests?

Return:
  - P0/P1/P2 findings first
  - exact file/section references
  - whether the plan is executable as written
  - the minimum changes required before implementation
```

- [ ] **Step 2: Update the plan from valid findings**

Do not blindly accept review comments. For each finding:

```text
if finding is code-grounded and valid:
  update this plan before Task 1

if finding contradicts current code:
  reject it with file/line evidence in the implementation notes

if finding is a broader design concern:
  decide whether it blocks this fix or belongs in a follow-up
```

- [ ] **Step 3: Commit review-driven plan corrections**

```bash
git add docs/superpowers/plans/2026-05-26-bidirectional-runtime-path-translator.md
git commit -m "docs: harden bidirectional runtime path translator plan"
```

### Review Corrections Applied Before Implementation

The first adversarial pass found execution blockers in this plan. The implementation tasks below must reflect these corrections before any source edit starts:

```text
Correction 1: OpenClaw sandbox paths are not a generic target-namespace case.
  A path under /home/openclaw/.openclaw/state/sandboxes/<child> is already an
  OpenClaw gateway path. The plugin must preserve that existing behavior:
    leaseWorkMountDir = sandbox child root
    effectiveGuestCwd = /workspace/<relative child path>
  Do not require the openclaw-sandboxes root to have a direct tool-vm-guest
  location. Handle it as a sandbox-child intent before the generic target
  projection.

Correction 2: Canonical agent workspace resolution must mirror OpenClaw.
  Do not hardcode "main" as the default agent. Resolve the default agent the
  same way OpenClaw does:
    agents.list[].default true wins,
    otherwise the first listed agent,
    otherwise "main".
  Then mirror resolveAgentWorkspaceDir:
    explicit agent workspace,
    default agent defaults.workspace,
    non-default defaults.workspace/<agentId>,
    default state workspace,
    stateDir/workspace-<agentId>.

Correction 3: Sandbox-root leakage is also poisoned agentWorkspaceDir input.
  If params.agentWorkspaceDir is /workspace, /work, or
  /home/openclaw/.openclaw/state/sandboxes/<child>, it is not the canonical
  agent workspace source. Resolve canonical source from agentId + OpenClaw
  runtime config before cache compatibility and before requestLease.

Correction 4: Smoke code must use current harness APIs.
  Use createGatewayApiClient from agent-vm's gateway-api-client module, use
  harness.runtime.zones[0]?.gateway?.ingress, call getOpenClawSmokeZone with
  the current signature, and call startSmokeControllerRuntime with
  { secrets, startOptions, startGatewayZone? }.

Correction 5: Controller tests must use current resolveLeaseWorkMountDir API.
  The signature is { runtimeDir, workMountDir, zone }. New translator error
  codes must be explicitly mapped to current LeaseWorkMountValidationError
  kinds instead of falling through or relying on stale names.

Correction 6: E2E proof must name the actual mechanism for each path case.
  The default subagent runtime inherits opts.workspaceDir; ACP forwards cwd.
  The smoke must prove the real same-agent subagent failure path, and the
  verification matrix must not pretend unit/integration tests are smoke.

Correction 7: Manual beta proof must refresh runtime status first.
  Before diagnosing lease failures from beta, publish or refresh
  /zones/:zoneId/openclaw-runtime-status so openclaw-runtime-status-unavailable
  is not confused with path translation failure.
```

---

## Task 1: Replace Two-Slot Runtime Mapping With Namespace Translator

**Files:**
- Modify: `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.ts`
- Modify: `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts`
- Modify: `packages/gateway-interface/src/index.ts`

- [ ] **Step 1: Write failing translator tests**

Add these tests to `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
	translateRuntimePath,
	type RuntimePathMapping,
} from './runtime-path-mapping.js';

const openClawMapping = {
	id: 'openclaw-tool-vm',
	roots: [
		{
			id: 'agent-workspace',
			backing: {
				kind: 'realfs',
				durability: 'durable',
				backup: 'included',
			},
			locations: {
				'tool-vm-guest': '/workspace',
				'openclaw-gateway': '/zone/agents/beta',
				'controller-host': '/tmp/agent-vm-zone-files/agents/beta',
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
			backing: {
				kind: 'guest-rootfs-cow',
				durability: 'vm-lifetime',
			},
			locations: {
				'tool-vm-guest': '/work',
			},
			capabilities: {
				executionCwd: true,
				leaseMount: false,
			},
			rootPathAllowed: true,
			guidanceLabel: 'Tool VM scratch',
		},
	],
} satisfies RuntimePathMapping;

describe('translateRuntimePath namespace mapping', () => {
	it('translates Tool VM workspace cwd to OpenClaw lease source', () => {
		expect(
			translateRuntimePath({
				inputPath: '/workspace/app',
				mapping: openClawMapping,
				purpose: 'executionCwd',
				sourceNamespace: 'tool-vm-guest',
				targetNamespace: 'openclaw-gateway',
			}),
		).toMatchObject({
			ok: true,
			value: {
				inputNamespace: 'tool-vm-guest',
				outputNamespace: 'openclaw-gateway',
				inputPath: '/workspace/app',
				outputPath: '/zone/agents/beta/app',
				relativePath: 'app',
				rootId: 'agent-workspace',
			},
		});
	});

	it('translates OpenClaw source back to Tool VM guest cwd', () => {
		expect(
			translateRuntimePath({
				inputPath: '/zone/agents/beta/app',
				mapping: openClawMapping,
				purpose: 'executionCwd',
				sourceNamespace: 'openclaw-gateway',
				targetNamespace: 'tool-vm-guest',
			}),
		).toMatchObject({
			ok: true,
			value: {
				inputNamespace: 'openclaw-gateway',
				outputNamespace: 'tool-vm-guest',
				outputPath: '/workspace/app',
				relativePath: 'app',
				rootId: 'agent-workspace',
			},
		});
	});

	it('rejects translating scratch to a lease mount because scratch has no OpenClaw lease source', () => {
		expect(
			translateRuntimePath({
				inputPath: '/work/tmp',
				mapping: openClawMapping,
				purpose: 'leaseMount',
				sourceNamespace: 'tool-vm-guest',
				targetNamespace: 'openclaw-gateway',
			}),
		).toMatchObject({
			ok: false,
			error: {
				code: 'purpose-not-allowed',
				inputPath: '/work/tmp',
			},
		});
	});

	it('rejects parent traversal before normalization', () => {
		expect(
			translateRuntimePath({
				inputPath: '/workspace/../secrets',
				mapping: openClawMapping,
				purpose: 'executionCwd',
				sourceNamespace: 'tool-vm-guest',
				targetNamespace: 'openclaw-gateway',
			}),
		).toMatchObject({
			ok: false,
			error: {
				code: 'path-parent-traversal',
			},
		});
	});
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts
```

Expected: FAIL because `sourceNamespace`, `targetNamespace`, `locations`, and `outputPath` are not implemented.

- [ ] **Step 3: Implement namespace translator**

Replace the root model in `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.ts` with this shape:

```ts
export type RuntimePathNamespace =
	| 'tool-vm-guest'
	| 'openclaw-gateway'
	| 'controller-host';

export type RuntimePathPurpose = 'executionCwd' | 'leaseMount';

export interface RuntimePathCapabilities {
	readonly executionCwd: boolean;
	readonly leaseMount: boolean;
}

export type RuntimePathBacking =
	| {
			readonly kind: 'realfs';
			readonly durability: 'durable' | 'runtime' | 'cache';
			readonly backup: 'included' | 'excluded';
	  }
	| {
			readonly kind: 'guest-rootfs-cow';
			readonly durability: 'vm-lifetime';
	  };

export interface RuntimePathRootMapping {
	readonly backing: RuntimePathBacking;
	readonly capabilities: RuntimePathCapabilities;
	readonly guidanceLabel: string;
	readonly id: string;
	readonly locations: Partial<Record<RuntimePathNamespace, string>>;
	readonly rootPathAllowed: boolean;
	readonly showInGuidance?: Partial<Record<RuntimePathNamespace, boolean>>;
}

export interface RuntimePathMapping {
	readonly id: string;
	readonly roots: readonly RuntimePathRootMapping[];
}

export interface TranslateRuntimePathInput {
	readonly inputPath: string;
	readonly mapping: RuntimePathMapping;
	readonly purpose: RuntimePathPurpose;
	readonly sourceNamespace?: RuntimePathNamespace;
	readonly targetNamespace: RuntimePathNamespace;
}

export interface RuntimePathTranslation {
	readonly backing: RuntimePathBacking;
	readonly capabilities: RuntimePathCapabilities;
	readonly inputNamespace: RuntimePathNamespace;
	readonly inputPath: string;
	readonly mappingId: string;
	readonly outputNamespace: RuntimePathNamespace;
	readonly outputPath: string;
	readonly relativePath: string;
	readonly rootId: string;
}
```

Keep these existing helpers, updated for `locations`:

```ts
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
```

Implement matching by namespace:

```ts
interface RuntimePathRootMatch {
	readonly inputNamespace: RuntimePathNamespace;
	readonly matchedRoot: string;
	readonly root: RuntimePathRootMapping;
}

function findBestRootMatch(params: {
	readonly inputPath: string;
	readonly mapping: RuntimePathMapping;
	readonly sourceNamespace?: RuntimePathNamespace;
}): RuntimePathRootMatch | undefined {
	const matches = params.mapping.roots.flatMap((root): RuntimePathRootMatch[] =>
		Object.entries(root.locations).flatMap(([namespace, rootPath]) => {
			if (rootPath === undefined) {
				return [];
			}
			const inputNamespace = namespace as RuntimePathNamespace;
			if (
				params.sourceNamespace !== undefined &&
				inputNamespace !== params.sourceNamespace
			) {
				return [];
			}
			const normalizedRoot = normalizeRoot(rootPath);
			return pathMatchesRoot(params.inputPath, normalizedRoot)
				? [{ inputNamespace, matchedRoot: normalizedRoot, root }]
				: [];
		}),
	);
	return matches.toSorted((left, right) => right.matchedRoot.length - left.matchedRoot.length)[0];
}
```

In `translateRuntimePath`, after matching:

```ts
const targetRoot = match.root.locations[input.targetNamespace];
if (targetRoot === undefined) {
	return errorResult({
		code: 'target-namespace-not-available',
		inputPath: normalizedInputPath,
		mapping: input.mapping,
		message: `Path '${normalizedInputPath}' matched ${match.root.guidanceLabel}, but '${input.targetNamespace}' is not available for that root.`,
		purpose: input.purpose,
	});
}

return {
	ok: true,
	value: {
		backing: match.root.backing,
		capabilities: match.root.capabilities,
		inputNamespace: match.inputNamespace,
		inputPath: normalizedInputPath,
		mappingId: input.mapping.id,
		outputNamespace: input.targetNamespace,
		outputPath: joinRootAndRelative(normalizeRoot(targetRoot), relativePath),
		relativePath,
		rootId: match.root.id,
	},
};
```

Add `'target-namespace-not-available'` to `RuntimePathTranslationErrorCode`.

- [ ] **Step 4: Run unit tests and verify they pass**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-interface/src/runtime-paths/runtime-path-mapping.ts packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts packages/gateway-interface/src/index.ts
git commit -m "refactor: make runtime path mapping namespace based"
```

---

## Task 2: Add Canonical OpenClaw Agent Workspace Source Resolver

**Files:**
- Create: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-agent-workspace-source.ts`
- Create: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-agent-workspace-source.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-gondolin-contract.ts`

- [ ] **Step 1: Write failing resolver tests**

Create `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-agent-workspace-source.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
	resolveOpenClawAgentWorkspaceSource,
} from './openclaw-agent-workspace-source.js';

describe('resolveOpenClawAgentWorkspaceSource', () => {
	it('uses the configured agent workspace when OpenClaw leaks /workspace as agentWorkspaceDir', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: {
					agents: {
						list: [{ id: 'beta', workspace: '/zone/agents/beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toEqual({
			kind: 'configured-agent-workspace',
			sourceDir: '/zone/agents/beta',
		});
	});

	it('uses the configured agent workspace when OpenClaw leaks a sandbox child path as agentWorkspaceDir', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: {
					agents: {
						list: [{ id: 'beta', workspace: '/zone/agents/beta' }],
					},
				},
				paramsAgentWorkspaceDir:
					'/home/openclaw/.openclaw/state/sandboxes/child-session/work',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toEqual({
			kind: 'configured-agent-workspace',
			sourceDir: '/zone/agents/beta',
		});
	});

	it('uses the configured agent workspace when OpenClaw leaks its implicit default workspace as agentWorkspaceDir', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: {
					agents: {
						list: [{ id: 'beta', workspace: '/zone/agents/beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toEqual({
			kind: 'configured-agent-workspace',
			sourceDir: '/zone/agents/beta',
		});
	});

	it('uses defaults workspace plus agent id for non-default agents without explicit workspace', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: {
					agents: {
						list: [{ id: 'primary', default: true }, { id: 'beta' }],
						defaults: { workspace: '/zone/agents' },
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toEqual({
			kind: 'default-workspace-child',
			sourceDir: '/zone/agents/beta',
		});
	});

	it('uses defaults workspace itself for the OpenClaw default agent even when the id is not main', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'primary',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: {
					agents: {
						list: [{ id: 'primary', default: true }, { id: 'beta' }],
						defaults: { workspace: '/zone/agents/default' },
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toEqual({
			kind: 'default-agent-workspace',
			sourceDir: '/zone/agents/default',
		});
	});

	it('mirrors OpenClaw stateDir fallback for non-default agents', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: {
					agents: {
						list: [{ id: 'primary', default: true }, { id: 'beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toEqual({
			kind: 'state-workspace-child',
			sourceDir: '/home/openclaw/.openclaw/state/workspace-beta',
		});
	});

	it('rejects default-agent state workspace fallback because it is not controller lease backed', () => {
		expect(() =>
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'primary',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: {
					agents: {
						list: [{ id: 'primary', default: true }, { id: 'beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toThrow(/configure agents\.list\[\]\.workspace or agents\.defaults\.workspace/u);
	});

	it('keeps a non-guest absolute OpenClaw source path when config is unavailable', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: undefined,
				paramsAgentWorkspaceDir: '/zone/agents/beta',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toEqual({
			kind: 'sdk-agent-workspace',
			sourceDir: '/zone/agents/beta',
		});
	});

	it('uses OpenClaw stateDir fallback when guest leakage arrives without explicit workspace config', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: undefined,
				paramsAgentWorkspaceDir: '/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toEqual({
			kind: 'state-workspace-child',
			sourceDir: '/home/openclaw/.openclaw/state/workspace-beta',
		});
	});

	it('uses OpenClaw stateDir fallback when implicit default workspace leakage arrives without explicit workspace config', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: undefined,
				paramsAgentWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toEqual({
			kind: 'state-workspace-child',
			sourceDir: '/home/openclaw/.openclaw/state/workspace-beta',
		});
	});

	it('rejects configured agent workspaces under OpenClaw implicit default workspace', () => {
		expect(() =>
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: {
					agents: {
						list: [
							{
								id: 'beta',
								workspace: '/home/openclaw/.openclaw/workspace',
							},
						],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toThrow(/must resolve to a controller lease-backed OpenClaw\\/Gondolin source path/u);
	});

	it('rejects default workspaces under OpenClaw implicit profile workspace', () => {
		expect(() =>
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: {
					agents: {
						defaults: {
							workspace: '/home/openclaw/.openclaw/workspace-profile',
						},
						list: [{ id: 'primary', default: true }, { id: 'beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toThrow(/must resolve to a controller lease-backed OpenClaw\\/Gondolin source path/u);
	});

	it('rejects base implicit workspace when the active OpenClaw profile default workspace is profile-specific', () => {
		expect(() =>
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace-beta',
				openClawConfig: {
					agents: {
						list: [
							{
								id: 'beta',
								workspace: '/home/openclaw/.openclaw/workspace',
							},
						],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toThrow(/must resolve to a controller lease-backed OpenClaw\\/Gondolin source path/u);
	});

	it('rejects base implicit defaults workspace when the active OpenClaw profile default workspace is profile-specific', () => {
		expect(() =>
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace-beta',
				openClawConfig: {
					agents: {
						defaults: {
							workspace: '/home/openclaw/.openclaw/workspace',
						},
						list: [{ id: 'primary', default: true }, { id: 'beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toThrow(/must resolve to a controller lease-backed OpenClaw\\/Gondolin source path/u);
	});

	it('rejects /work as a canonical workspace source', () => {
		expect(() =>
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				openClawConfig: {
					agents: { list: [{ id: 'beta', workspace: '/work' }] },
				},
				paramsAgentWorkspaceDir: '/workspace',
				stateDir: '/home/openclaw/.openclaw/state',
			}),
		).toThrow(/must resolve to an OpenClaw\\/Gondolin source path/u);
	});
});
```

- [ ] **Step 2: Run resolver tests and verify they fail**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-agent-workspace-source.test.ts
```

Expected: FAIL because the file does not exist.

- [ ] **Step 3: Implement resolver**

Create `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-agent-workspace-source.ts`:

```ts
import path from 'node:path/posix';

import {
	OPENCLAW_STATE_SANDBOXES_VM_ROOT,
	TOOL_VM_SCRATCH_GUEST_ROOT,
	TOOL_VM_WORKSPACE_GUEST_ROOT,
} from '@agent-vm/gateway-interface';

import { normalizeOpenClawAgentId } from '../openclaw-gondolin-contract.js';

export interface OpenClawAgentWorkspaceConfig {
	readonly agents?: {
		readonly defaults?: {
			readonly workspace?: unknown;
		};
		readonly list?: readonly unknown[];
	};
}

export type OpenClawAgentWorkspaceSourceKind =
	| 'configured-agent-workspace'
	| 'default-agent-workspace'
	| 'default-workspace-child'
	| 'sdk-agent-workspace'
	| 'state-workspace-child';

export interface OpenClawAgentWorkspaceSource {
	readonly kind: OpenClawAgentWorkspaceSourceKind;
	readonly sourceDir: string;
}

export class OpenClawAgentWorkspaceSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OpenClawAgentWorkspaceSourceError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAbsolutePosixPath(inputPath: string): string {
	const segments = inputPath.split('/').filter((segment) => segment !== '' && segment !== '.');
	return `/${segments.join('/')}`;
}

function containsParentTraversal(inputPath: string): boolean {
	return inputPath.split(/\/+/u).includes('..');
}

function pathIsInsideOrEqual(inputPath: string, rootPath: string): boolean {
	return inputPath === rootPath || inputPath.startsWith(`${rootPath}/`);
}

function resolveUserPathLikeOpenClaw(inputPath: string): string {
	const trimmedPath = inputPath.trim();
	const homeDirectory = process.env.HOME?.trim();
	if (trimmedPath === '~' && homeDirectory) {
		return homeDirectory;
	}
	if (trimmedPath.startsWith('~/') && homeDirectory) {
		return path.resolve(path.join(homeDirectory, trimmedPath.slice(2)));
	}
	return path.resolve(trimmedPath);
}

function isRuntimePathLeak(inputPath: string, defaultWorkspaceDir: string | undefined): boolean {
	const normalized = normalizeAbsolutePosixPath(inputPath);
	const normalizedDefaultWorkspace =
		defaultWorkspaceDir === undefined
			? undefined
			: normalizeAbsolutePosixPath(resolveUserPathLikeOpenClaw(defaultWorkspaceDir));
	const implicitWorkspaceFamilyRoot =
		normalizedDefaultWorkspace === undefined
			? undefined
			: normalizedDefaultWorkspace.replace(/(?:-[^/]+)?$/u, '');
	return (
		normalized === TOOL_VM_WORKSPACE_GUEST_ROOT ||
		normalized.startsWith(`${TOOL_VM_WORKSPACE_GUEST_ROOT}/`) ||
		normalized === TOOL_VM_SCRATCH_GUEST_ROOT ||
		normalized.startsWith(`${TOOL_VM_SCRATCH_GUEST_ROOT}/`) ||
		normalized === OPENCLAW_STATE_SANDBOXES_VM_ROOT ||
		normalized.startsWith(`${OPENCLAW_STATE_SANDBOXES_VM_ROOT}/`) ||
		(normalizedDefaultWorkspace !== undefined &&
			(pathIsInsideOrEqual(normalized, normalizedDefaultWorkspace) ||
				normalized.startsWith(`${normalizedDefaultWorkspace}-`))) ||
		(implicitWorkspaceFamilyRoot !== undefined &&
			(pathIsInsideOrEqual(normalized, implicitWorkspaceFamilyRoot) ||
				normalized.startsWith(`${implicitWorkspaceFamilyRoot}-`)))
	);
}

function assertCanonicalSourcePath(inputPath: string, context: string): string {
	if (
		inputPath.trim() === '' ||
		!inputPath.startsWith('/') ||
		containsParentTraversal(inputPath)
	) {
		throw new OpenClawAgentWorkspaceSourceError(
			`${context} must be an absolute path without parent traversal.`,
		);
	}
	const normalized = normalizeAbsolutePosixPath(inputPath);
	if (
		normalized === '/' ||
		normalized === TOOL_VM_WORKSPACE_GUEST_ROOT ||
		normalized.startsWith(`${TOOL_VM_WORKSPACE_GUEST_ROOT}/`) ||
		normalized === TOOL_VM_SCRATCH_GUEST_ROOT ||
		normalized.startsWith(`${TOOL_VM_SCRATCH_GUEST_ROOT}/`)
	) {
		throw new OpenClawAgentWorkspaceSourceError(
			`${context} must resolve to an OpenClaw/Gondolin source path, not Tool VM guest path '${normalized}'.`,
		);
	}
	return normalized;
}

function assertLeaseBackedSourcePath(
	inputPath: string,
	context: string,
	defaultWorkspaceDir: string | undefined,
): string {
	const normalized = assertCanonicalSourcePath(inputPath, context);
	if (isRuntimePathLeak(normalized, defaultWorkspaceDir)) {
		throw new OpenClawAgentWorkspaceSourceError(
			`${context} must resolve to a controller lease-backed OpenClaw/Gondolin source path, not OpenClaw runtime fallback path '${normalized}'.`,
		);
	}
	return normalized;
}

function readWorkspace(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function findAgentEntry(
	config: OpenClawAgentWorkspaceConfig | undefined,
	agentId: string,
): Record<string, unknown> | undefined {
	return config?.agents?.list
		?.filter(isRecord)
		.find((entry) => normalizeOpenClawAgentId(String(entry.id ?? '')) === agentId);
}

function resolveDefaultAgentId(config: OpenClawAgentWorkspaceConfig | undefined): string {
	const entries = config?.agents?.list?.filter(isRecord) ?? [];
	const defaultEntry = entries.find((entry) => entry.default === true);
	const fallbackEntry = defaultEntry ?? entries[0];
	return normalizeOpenClawAgentId(String(fallbackEntry?.id ?? 'main'));
}

export function resolveOpenClawAgentWorkspaceSource(options: {
	readonly agentId: string;
	readonly defaultWorkspaceDir: string | undefined;
	readonly openClawConfig: OpenClawAgentWorkspaceConfig | undefined;
	readonly paramsAgentWorkspaceDir: string;
	readonly stateDir: string | undefined;
}): OpenClawAgentWorkspaceSource {
	const agentId = normalizeOpenClawAgentId(options.agentId);
	const agentEntry = findAgentEntry(options.openClawConfig, agentId);
	const agentWorkspace = readWorkspace(agentEntry?.workspace);
	if (agentWorkspace !== undefined) {
		return {
			kind: 'configured-agent-workspace',
			sourceDir: assertLeaseBackedSourcePath(
				agentWorkspace,
				`agents.list workspace for '${agentId}'`,
				options.defaultWorkspaceDir,
			),
		};
	}

	const defaultsWorkspace = readWorkspace(options.openClawConfig?.agents?.defaults?.workspace);
	if (defaultsWorkspace !== undefined) {
		const defaultsRoot = assertLeaseBackedSourcePath(
			defaultsWorkspace,
			'agents.defaults.workspace',
			options.defaultWorkspaceDir,
		);
		const defaultAgentId = resolveDefaultAgentId(options.openClawConfig);
		return {
			kind:
				agentId === defaultAgentId ? 'default-agent-workspace' : 'default-workspace-child',
			sourceDir: agentId === defaultAgentId ? defaultsRoot : path.join(defaultsRoot, agentId),
		};
	}

	if (!isRuntimePathLeak(options.paramsAgentWorkspaceDir, options.defaultWorkspaceDir)) {
		return {
			kind: 'sdk-agent-workspace',
			sourceDir: assertCanonicalSourcePath(
				options.paramsAgentWorkspaceDir,
				'OpenClaw backend agentWorkspaceDir',
			),
		};
	}

	const stateRoot =
		options.stateDir === undefined
			? undefined
			: assertCanonicalSourcePath(options.stateDir, 'OpenClaw stateDir');
	if (stateRoot === undefined) {
		throw new OpenClawAgentWorkspaceSourceError(
			`OpenClaw provided agentWorkspaceDir '${options.paramsAgentWorkspaceDir}' for agent '${agentId}', which is a runtime path. Provide an OpenClaw stateDir provider or configure agents.list[].workspace.`,
		);
	}
	const defaultAgentId = resolveDefaultAgentId(options.openClawConfig);
	if (agentId === defaultAgentId) {
		throw new OpenClawAgentWorkspaceSourceError(
			`OpenClaw provided agentWorkspaceDir '${options.paramsAgentWorkspaceDir}' for default agent '${agentId}', but OpenClaw's implicit default workspace is not controller lease backed; configure agents.list[].workspace or agents.defaults.workspace for managed Gondolin agents.`,
		);
	}
	return {
		kind: 'state-workspace-child',
		sourceDir: path.join(stateRoot, `workspace-${agentId}`),
	};
}
```

- [ ] **Step 4: Run resolver tests and verify they pass**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-agent-workspace-source.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-agent-workspace-source.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-agent-workspace-source.test.ts
git commit -m "feat: resolve canonical openclaw agent workspace source"
```

---

## Task 3: Wire Canonical Source Into Plugin Lease Factory

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.test.ts`

- [ ] **Step 1: Write failing plugin integration test for beta poisoned root**

Add this test to `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`:

```ts
it('canonicalizes leaked /workspace agentWorkspaceDir before requesting a lease', async () => {
	const requestLease = vi.fn(async (_request: Parameters<LeaseClient['requestLease']>[0]) =>
		createLeaseResponse('01890f00-0000-7000-8000-000000000123', {
			agentId: 'beta',
		}),
	);
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			openClawRuntimeConfigProvider: () => ({
				agents: {
					list: [{ id: 'beta', workspace: '/zone/agents/beta' }],
				},
			}),
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
				peekLease: async () => createLeasePeekResponse(),
				releaseLease: async () => {},
				renewLease: async () => createLeaseResponse('01890f00-0000-7000-8000-000000000123'),
				requestLease,
			}),
			runRemoteShellScript: vi.fn(),
		},
	);

	const handle = await factory({
		agentWorkspaceDir: '/workspace',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:subagent:child',
		sessionKey: 'agent:beta:subagent:child',
		workspaceDir: '/workspace',
	});

	expect(handle.workdir).toBe('/workspace');
	expect(requestLease).toHaveBeenCalledWith(
		expect.objectContaining({
			agentId: 'beta',
			agentWorkspaceDir: '/zone/agents/beta',
			sessionKey: 'agent:beta:subagent:child',
			workMountDir: '/zone/agents/beta',
			zoneId: 'shravan',
		}),
	);
	expect(requestLease.mock.calls[0]?.[0]).not.toHaveProperty('scopeKey');
	expect(requestLease.mock.calls[0]?.[0]).not.toHaveProperty('sandbox');
	expect(requestLease.mock.calls[0]?.[0]).not.toHaveProperty('workspaceDir');
});
```

- [ ] **Step 2: Write failing subpath and scratch permutation tests**

Add two more tests beside the previous test:

```ts
it('keeps /workspace subpath as effective guest cwd while leasing the agent root', async () => {
	const requestLease = vi.fn(async () => createLeaseResponse('01890f00-0000-7000-8000-000000000124'));
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			openClawRuntimeConfigProvider: () => ({
				agents: { list: [{ id: 'beta', workspace: '/zone/agents/beta' }] },
			}),
			zoneId: 'shravan',
		},
		createBackendDependenciesForTest({ requestLease }),
	);

	const handle = await factory({
		agentWorkspaceDir: '/workspace',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:subagent:child',
		sessionKey: 'agent:beta:subagent:child',
		workspaceDir: '/workspace/app',
	});

	expect(handle.workdir).toBe('/workspace/app');
	expect(requestLease.mock.calls[0]?.[0]).toMatchObject({
		agentWorkspaceDir: '/zone/agents/beta',
		workMountDir: '/zone/agents/beta',
	});
});

it('keeps /work scratch as effective guest cwd while leasing the agent workspace root', async () => {
	const requestLease = vi.fn(async () => createLeaseResponse('01890f00-0000-7000-8000-000000000125'));
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			openClawRuntimeConfigProvider: () => ({
				agents: { list: [{ id: 'beta', workspace: '/zone/agents/beta' }] },
			}),
			zoneId: 'shravan',
		},
		createBackendDependenciesForTest({ requestLease }),
	);

	const handle = await factory({
		agentWorkspaceDir: '/workspace',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:subagent:child',
		sessionKey: 'agent:beta:subagent:child',
		workspaceDir: '/work/tmp',
	});

	expect(handle.workdir).toBe('/work/tmp');
	expect(requestLease.mock.calls[0]?.[0]).toMatchObject({
		agentWorkspaceDir: '/zone/agents/beta',
		workMountDir: '/zone/agents/beta',
	});
});
```

Add the sandbox-root leakage regression too:

```ts
it('canonicalizes sandbox child agentWorkspaceDir before cache compatibility', async () => {
	const requestLease = vi.fn(async () => createLeaseResponse('01890f00-0000-7000-8000-000000000126'));
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			openClawRuntimeConfigProvider: () => ({
				agents: { list: [{ id: 'beta', workspace: '/zone/agents/beta' }] },
			}),
			zoneId: 'shravan',
		},
		createBackendDependenciesForTest({ requestLease }),
	);

	const handle = await factory({
		agentWorkspaceDir: '/home/openclaw/.openclaw/state/sandboxes/child-123/work',
		cfg: gondolinSandboxConfig(),
		scopeKey: 'agent:beta:subagent:child',
		sessionKey: 'agent:beta:subagent:child',
		workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/child-123/work/project',
	});

	expect(handle.workdir).toBe('/workspace/work/project');
	expect(requestLease.mock.calls[0]?.[0]).toMatchObject({
		agentWorkspaceDir: '/zone/agents/beta',
		workMountDir: '/home/openclaw/.openclaw/state/sandboxes/child-123',
	});
});
```

If `createBackendDependenciesForTest` does not exist, create it in the test file:

```ts
function createBackendDependenciesForTest(options: {
	readonly requestLease: LeaseClient['requestLease'];
}): CreateBackendDependencies {
	return {
		buildExecSpec: vi.fn(async () => ({
			argv: ['ssh'],
			env: {},
			stdinMode: 'pipe-open' as const,
		})),
		createLeaseClient: () => ({
			...createActiveUseLeaseClientMethods(),
			peekLease: async () => createLeasePeekResponse(),
			releaseLease: async () => {},
			renewLease: async () => createLeaseResponse('01890f00-0000-7000-8000-000000000125'),
			requestLease: options.requestLease,
		}),
		runRemoteShellScript: vi.fn(),
	};
}
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts
```

Expected: FAIL because `openClawRuntimeConfigProvider` is not accepted and the factory still uses raw `params.agentWorkspaceDir`.

- [ ] **Step 4: Add runtime config provider option**

In `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts`, add:

```ts
export type OpenClawRuntimeConfigProvider = () => Record<string, unknown> | undefined;
```

In `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`, import resolver:

```ts
import { resolveOpenClawAgentWorkspaceSource } from './openclaw-agent-workspace-source.js';
```

Add option:

```ts
readonly openClawDefaultWorkspaceDirProvider?: () => string | undefined;
readonly openClawRuntimeConfigProvider?: () => Record<string, unknown> | undefined;
readonly openClawStateDirProvider?: () => string | undefined;
```

Before path intent:

```ts
const defaultWorkspaceDir =
	options.openClawDefaultWorkspaceDirProvider?.() ?? defaultOpenClawWorkspaceDir();
const equivalentAgentWorkspaceDirs =
	defaultWorkspaceDir === undefined ? [] : [defaultWorkspaceDir];
const workspaceSource = resolveOpenClawAgentWorkspaceSource({
	agentId,
	defaultWorkspaceDir,
	openClawConfig: options.openClawRuntimeConfigProvider?.(),
	paramsAgentWorkspaceDir: params.agentWorkspaceDir,
	stateDir: options.openClawStateDirProvider?.(),
});
const pathIntent = assertOpenClawToolVmPathIntent({
	agentWorkspaceDir: workspaceSource.sourceDir,
	equivalentAgentWorkspaceDirs,
	inputPath: params.workspaceDir,
});
```

Change requested cache entry:

```ts
const requestedCacheEntry = {
	agentWorkspaceDir: workspaceSource.sourceDir,
	leaseWorkMountDir: pathIntent.leaseWorkMountDir,
	profileId,
} satisfies CachedAgentLeaseCompatibility;
```

Change request body:

```ts
const leaseResponse = await leaseClient.requestLease({
	agentId,
	agentWorkspaceDir: workspaceSource.sourceDir,
	profileId,
	sessionKey: params.sessionKey,
	workMountDir: pathIntent.leaseWorkMountDir,
	zoneId: options.zoneId,
});
```

The key point is that the resolver call includes the OpenClaw state/workspace fallback inputs that mirror upstream OpenClaw:

```ts
const workspaceSource = resolveOpenClawAgentWorkspaceSource({
	agentId,
	defaultWorkspaceDir,
	openClawConfig: options.openClawRuntimeConfigProvider?.(),
	paramsAgentWorkspaceDir: params.agentWorkspaceDir,
	stateDir: options.openClawStateDirProvider?.(),
});
```

When present, the same `defaultWorkspaceDir` must also be passed to `assertOpenClawToolVmPathIntent` as an equivalent agent workspace dir. That lets `/home/openclaw/.openclaw/workspace` and profile-specific variants translate to the correct Tool VM guest cwd while keeping the controller lease mount anchored to `workspaceSource.sourceDir`.

In production registration, those providers are derived from the OpenClaw runtime process environment using the same semantics as upstream:

```text
openClawStateDirProvider:
  OPENCLAW_STATE_DIR when set, otherwise ~/.openclaw/state inside the gateway process

openClawDefaultWorkspaceDirProvider:
  ~/.openclaw/workspace by default
  ~/.openclaw/workspace-<profile> when OPENCLAW_PROFILE is set and not "default"
```

Do not use these fallback paths to create a second lease identity or controller mount. They only recover the canonical OpenClaw source path when OpenClaw leaks a guest/sandbox/default runtime path at the SDK boundary.

- [ ] **Step 5: Wire registration provider**

In `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`, when calling `createGondolinSandboxBackendFactory`, pass:

```ts
openClawRuntimeConfigProvider: () => api.runtime?.config?.current?.() ?? api.config,
```

Keep existing `openClawRuntimeStatusProvider: buildRuntimeStatus`.

- [ ] **Step 6: Run plugin tests and verify they pass**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts
git commit -m "fix: canonicalize openclaw agent workspace before lease mapping"
```

---

## Task 4: Move Plugin Path Intent Onto Namespace Translator

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts`

- [ ] **Step 1: Add failing bidirectional intent tests**

Add to `packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts`:

```ts
it('translates canonical source subpaths back to Tool VM guest cwd', () => {
	expect(
		resolveOpenClawToolVmPathIntent({
			agentWorkspaceDir: '/zone/agents/beta',
			inputPath: '/zone/agents/beta/app',
		}),
	).toEqual({
		ok: true,
		value: {
			effectiveGuestCwd: '/workspace/app',
			hostEquivalentPath: '/zone/agents/beta/app',
			kind: 'host-workspace-subpath',
			leaseWorkMountDir: '/zone/agents/beta',
		},
	});
});
```

Also add:

```ts
it('does not use /work as a lease mount but preserves it as cwd', () => {
	expect(
		resolveOpenClawToolVmPathIntent({
			agentWorkspaceDir: '/zone/agents/beta',
			inputPath: '/work/tmp',
		}),
	).toEqual({
		ok: true,
		value: {
			effectiveGuestCwd: '/work/tmp',
			kind: 'scratch-subpath',
			leaseWorkMountDir: '/zone/agents/beta',
		},
	});
});
```

Also preserve the existing OpenClaw sandbox-child behavior:

```ts
it('maps OpenClaw sandbox child paths to a sandbox lease root and Tool VM workspace cwd', () => {
	expect(
		resolveOpenClawToolVmPathIntent({
			agentWorkspaceDir: '/zone/agents/beta',
			inputPath: '/home/openclaw/.openclaw/state/sandboxes/child-123/project/src',
		}),
	).toEqual({
		ok: true,
		value: {
			effectiveGuestCwd: '/workspace/project/src',
			hostEquivalentPath: '/home/openclaw/.openclaw/state/sandboxes/child-123/project/src',
			kind: 'openclaw-sandbox-subpath',
			leaseWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/child-123',
		},
	});
});
```

- [ ] **Step 2: Run test and verify current behavior**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts
```

Expected: PASS or targeted failures from namespace refactor. If it passes, keep the tests as regression coverage before refactoring implementation.

- [ ] **Step 3: Refactor mapper to namespace translator**

In `openclaw-tool-vm-path-mapping.ts`, build mapping with locations:

```ts
function createOpenClawToolVmPathMapping(options: {
	readonly agentWorkspaceDir: string;
}): RuntimePathMapping {
	return {
		id: 'openclaw-tool-vm',
		roots: [
			{
				id: 'agent-workspace',
				locations: {
					'tool-vm-guest': TOOL_VM_WORKSPACE_GUEST_ROOT,
					'openclaw-gateway': options.agentWorkspaceDir,
				},
				backing: {
					kind: 'realfs',
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
				locations: {
					'tool-vm-guest': TOOL_VM_SCRATCH_GUEST_ROOT,
				},
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
				id: 'openclaw-sandboxes',
				locations: {
					'openclaw-gateway': OPENCLAW_STATE_SANDBOXES_VM_ROOT,
				},
				backing: {
					kind: 'realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: true,
					leaseMount: true,
				},
				rootPathAllowed: false,
				guidanceLabel: 'OpenClaw sandbox work directory',
			},
		],
	};
}
```

Use two translation calls:

```ts
const cwdTranslation = translateRuntimePath({
	inputPath: options.inputPath,
	mapping,
	purpose: 'executionCwd',
	targetNamespace: 'tool-vm-guest',
});
```

Do not run that generic target projection for the `openclaw-sandboxes` root. A sandbox input has only an `openclaw-gateway` location by design. Detect it with an `openclaw-gateway` source translation first:

```ts
const gatewayTranslation = translateRuntimePath({
	inputPath: options.inputPath,
	mapping,
	purpose: 'leaseMount',
	sourceNamespace: 'openclaw-gateway',
	targetNamespace: 'openclaw-gateway',
});
if (gatewayTranslation.ok && gatewayTranslation.value.rootId === 'openclaw-sandboxes') {
	return {
		ok: true,
		value: resolveOpenClawSandboxPathIntent(gatewayTranslation.value),
	};
}
```

`resolveOpenClawSandboxPathIntent` must split the relative path at the first segment after the sandbox root:

```text
input:
  /home/openclaw/.openclaw/state/sandboxes/child-123/project/src

leaseWorkMountDir:
  /home/openclaw/.openclaw/state/sandboxes/child-123

effectiveGuestCwd:
  /workspace/project/src
```

For lease:

```ts
const leaseWorkMountDir =
	cwdTranslation.value.rootId === 'tool-vm-scratch'
		? options.agentWorkspaceDir
		: translateRuntimePath({
				inputPath: options.inputPath,
				mapping,
				purpose: 'leaseMount',
				targetNamespace: 'openclaw-gateway',
			}).value.outputPath;
```

For workspace subpaths, lease root should be the root, not `/zone/agents/beta/app`. Use `relativePath` to strip back to the matching root:

```ts
function leaseRootForTranslation(translation: RuntimePathTranslation): string {
	return translation.relativePath === ''
		? translation.outputPath
		: translation.outputPath.slice(0, -(translation.relativePath.length + 1));
}
```

- [ ] **Step 4: Run path mapper tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts
git commit -m "refactor: use namespace runtime paths for openclaw tool vm intents"
```

---

## Task 5: Move Controller Lease Mapping Onto Namespace Translator

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/openclaw-gateway-lease-path-mapping.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`

- [ ] **Step 1: Add tests for controller namespace boundary**

Add to `packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts`:

```ts
it.each(['/workspace', '/workspace/app', '/work', '/work/tmp'])(
	'rejects Tool VM guest path %s at the controller lease boundary',
	async (workMountDir) => {
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir: '/tmp/runtime',
				workMountDir,
				zone: createOpenClawZoneConfig({
					id: 'beta',
					stateDir: '/tmp/state/beta',
					zoneFilesDir: '/tmp/zone',
				}),
			}),
		).rejects.toMatchObject({
			kind: 'work-mount-unknown-runtime-path',
		});
	},
);

it('resolves /zone child path to controller host backing path', async () => {
	await expect(
		resolveLeaseWorkMountDir({
			runtimeDir: '/tmp/runtime',
			workMountDir: '/zone/agents/beta',
			zone: createOpenClawZoneConfig({
				id: 'beta',
				stateDir: '/tmp/state/beta',
				zoneFilesDir: '/tmp/zone',
			}),
		}),
	).resolves.toMatchObject({
		guestWorkdir: '/workspace',
		hostWorkMountDir: '/tmp/zone/agents/beta',
	});
});

it.each([
	['relative/path', 'work-mount-not-absolute'],
	['/zone/../etc', 'work-mount-parent-traversal'],
	['/workspace', 'work-mount-unknown-runtime-path'],
	['/zone', 'root-mount-target'],
] as const)('maps invalid workMountDir %s to %s', async (workMountDir, kind) => {
	await expect(
		resolveLeaseWorkMountDir({
			runtimeDir: '/tmp/runtime',
			workMountDir,
			zone: createOpenClawZoneConfig({
				id: 'beta',
				stateDir: '/tmp/state/beta',
				zoneFilesDir: '/tmp/zone',
			}),
		}),
	).rejects.toMatchObject({ kind });
});
```

- [ ] **Step 2: Run tests and verify behavior**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts
```

Expected: PASS before refactor or fail only where error kind names change.

- [ ] **Step 3: Refactor controller mapping**

In `openclaw-gateway-lease-path-mapping.ts`, return namespace locations:

```ts
export function createOpenClawGatewayLeasePathMapping(options: {
	readonly stateDir: string;
	readonly zoneFilesDir: string;
}): RuntimePathMapping {
	return {
		id: 'openclaw-gateway-lease',
		roots: [
			{
				backing: {
					kind: 'realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: false,
					leaseMount: true,
				},
				locations: {
					'openclaw-gateway': OPENCLAW_STATE_SANDBOXES_VM_ROOT,
					'controller-host': path.join(options.stateDir, 'sandboxes'),
				},
				guidanceLabel: 'OpenClaw sandbox work directory',
				id: 'openclaw-sandboxes',
				rootPathAllowed: false,
				showInGuidance: {
					'controller-host': false,
				},
			},
			{
				backing: {
					kind: 'realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: false,
					leaseMount: true,
				},
				locations: {
					'openclaw-gateway': OPENCLAW_ZONE_FILES_GUEST_ROOT,
					'controller-host': options.zoneFilesDir,
				},
				guidanceLabel: 'OpenClaw zone files',
				id: 'zone-files',
				rootPathAllowed: false,
				showInGuidance: {
					'controller-host': false,
				},
			},
		],
	};
}
```

In `lease-work-mount-paths.ts`, call:

```ts
const translation = translateRuntimePath({
	inputPath: workMountDir,
	mapping: createOpenClawGatewayLeasePathMapping({ stateDir, zoneFilesDir }),
	purpose: 'leaseMount',
	sourceNamespace: 'openclaw-gateway',
	targetNamespace: 'controller-host',
});
```

Use `translation.value.outputPath` for host validation.

Update the translator error map explicitly. Do not let the new namespace error fall through:

```ts
const translatorErrorKindByCode = {
	'path-not-absolute': 'work-mount-not-absolute',
	'parent-traversal': 'work-mount-parent-traversal',
	'root-path-not-allowed': 'root-mount-target',
	'target-namespace-not-available': 'work-mount-unknown-runtime-path',
	'unknown-runtime-path': 'work-mount-unknown-runtime-path',
} satisfies Record<RuntimePathTranslationErrorCode, LeaseWorkMountValidationErrorKind>;
```

- [ ] **Step 4: Run controller lease tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/leases/openclaw-gateway-lease-path-mapping.ts packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
git commit -m "refactor: translate openclaw lease paths by namespace"
```

---

## Task 6: Add Real OpenClaw Subagent Lease E2E Smoke

**Files:**
- Create: `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.smoke.test.ts`
- Modify: `packages/agent-vm/src/integration-tests/smoke-harness.ts`
- Modify: `AGENTS.md`

- [ ] **Step 1: Add smoke taxonomy to AGENTS.md**

In `AGENTS.md`, under Testing, add:

```md
### Test Taxonomy

- Unit tests prove pure logic and package-local behavior. They are not smoke tests.
- Integration tests prove package or HTTP/controller boundaries with fakes or local servers. They are not smoke tests unless they boot the real external runtime path.
- Smoke tests are real E2E or explicitly documented manual E2E. For OpenClaw/Tool VM lease changes, smoke means a real controller + OpenClaw gateway + Tool VM flow, or a recorded beta/manual run with exact commands, logs, and pass/fail evidence.
- OpenClaw subagent lease changes must prove `sessions_spawn` or ACP child creation across the full path: OpenClaw parent -> backend factory -> agent-vm plugin -> controller lease -> Tool VM command.
```

- [ ] **Step 2: Write failing E2E smoke skeleton**

Create `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.smoke.test.ts`:

```ts
/* oxlint-disable eslint/no-await-in-loop -- E2E smoke steps are sequential against live VMs */
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBuildCommand } from '../cli/build-command.js';
import {
	createGatewayApiClient,
	type GatewayApiClient,
} from '../gateway-api-client/gateway-api-client.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import {
	canRunGondolinSmoke,
	currentSmokeArchitecture,
	rebuildWorkspacePackages,
	removeSmokeTempRoot,
	scaffoldOpenClawSmokeProject,
	startSmokeControllerRuntime,
	type OpenClawSmokeProject,
	type SmokeHarnessRuntime,
	useLocalOpenClawGatewayImagePackages,
} from './smoke-harness.js';

const architecture = currentSmokeArchitecture();
const runOpenClawSubagentSmoke =
	process.env.AGENT_VM_OPENCLAW_SMOKE === '1' && (await canRunGondolinSmoke({ architecture }));
const describeOpenClawSubagentSmoke = runOpenClawSubagentSmoke ? describe : describe.skip;

function createSmokeGatewayClient(harness: SmokeHarnessRuntime): GatewayApiClient {
	const gatewayIngress = harness.runtime.zones[0]?.gateway?.ingress;
	if (!gatewayIngress) {
		throw new Error('OpenClaw subagent smoke did not expose a gateway ingress URL.');
	}
	return createGatewayApiClient({
		gatewayUrl: `http://${gatewayIngress.host}:${String(gatewayIngress.port)}`,
		token: 'subagent-lease-smoke-gateway-token',
	});
}

describeOpenClawSubagentSmoke('smoke: OpenClaw subagent Tool VM lease path', () => {
	let harness: SmokeHarnessRuntime | undefined;
	let project: OpenClawSmokeProject | undefined;
	let gatewayClient: GatewayApiClient | undefined;

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		rebuildWorkspacePackages(repoRoot);
		project = await scaffoldOpenClawSmokeProject({
			agents: ['smoke'],
			architecture,
			prefix: 'openclaw-subagent-lease-smoke-',
			zoneId: 'subagent-lease-smoke',
		});
		const systemZone = project.systemConfig.zones[0];
		if (!systemZone || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw subagent smoke project to contain an OpenClaw zone.');
		}
		await useLocalOpenClawGatewayImagePackages({
			profileName: systemZone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: project.systemConfig,
		});
		await runBuildCommand({
			forceRebuild: true,
			systemConfig: project.systemConfig,
		});
		harness = await startSmokeControllerRuntime({
			secrets: {
				GITHUB_TOKEN: 'unused-subagent-smoke-token',
				OPENCLAW_GATEWAY_TOKEN: 'subagent-lease-smoke-gateway-token',
				PERPLEXITY_API_KEY: 'unused-subagent-smoke-perplexity-token',
			},
			startOptions: {
				systemConfig: project.systemConfig,
				zoneIds: [systemZone.id],
			},
			startGatewayZone: async (startGatewayOptions) => {
				const result = await startGatewayZone(startGatewayOptions);
				result.vm.setIngressRoutes([
					{
						port: result.processSpec.guestListenPort,
						prefix: '/',
						stripPrefix: true,
					},
				]);
				return result;
			},
		});
		gatewayClient = createSmokeGatewayClient(harness);
	}, 900_000);

	afterAll(async () => {
		try {
			await harness?.close();
		} finally {
			if (project) {
				await removeSmokeTempRoot(project.tempRoot);
			}
		}
	});

	it('runs a same-agent subagent without sending /workspace as controller workMountDir', async () => {
		if (gatewayClient === undefined || harness === undefined) {
			throw new Error('Expected smoke harness to be initialized.');
		}

		const result = await gatewayClient.invokeTool({
			agentId: 'smoke',
			tool: 'sessions_spawn',
			args: {
				task: 'Print exactly SUBAGENT_LEASE_SMOKE_OK and nothing else.',
				label: 'lease-path-smoke',
				runtime: 'subagent',
				mode: 'run',
			},
		});

		expect(JSON.stringify(result)).toContain('SUBAGENT_LEASE_SMOKE_OK');

		const leaseResponse = await fetch(`${harness.controllerUrl}/leases`);
		expect(leaseResponse.ok).toBe(true);
		const leasePayload = await leaseResponse.json();
		expect(JSON.stringify(leasePayload)).toContain('"agentId":"smoke"');
		expect(JSON.stringify(leasePayload)).not.toContain('"workMountDir":"/workspace"');
	});
});
```

If `GatewayApiClient.invokeTool` does not support `sessions_spawn`, extend the harness with a helper that invokes OpenClaw tools through the same endpoint used by `openclaw-mcp-portal.smoke.test.ts`.

This smoke proves the real default `runtime="subagent"` path where OpenClaw inherits `opts.workspaceDir` from the parent. It must not be used to claim that ACP `cwd` or `/work` permutations are E2E-proven unless those flows are explicitly triggered. Cover the full matrix like this:

```text
Real E2E smoke:
  runtime=subagent
  parent Tool VM context leaks /workspace as child agentWorkspaceDir/workspaceDir
  expected child output: SUBAGENT_LEASE_SMOKE_OK

Plugin/controller integration:
  params.agentWorkspaceDir=/workspace, workspaceDir=/workspace/app
  params.agentWorkspaceDir=/workspace, workspaceDir=/work/tmp
  params.agentWorkspaceDir=/home/openclaw/.openclaw/state/sandboxes/<child>/work,
    workspaceDir=/home/openclaw/.openclaw/state/sandboxes/<child>/work/app

ACP or manual beta proof if available:
  runtime=acp with cwd=/workspace/app
  runtime=acp with cwd=/work/tmp
```

If the ACP runtime is unavailable in local smoke, record that as a manual/E2E limitation instead of calling the integration cases smoke.

- [ ] **Step 3: Run the smoke and verify it fails before the fix**

Run:

```bash
AGENT_VM_OPENCLAW_SMOKE=1 mise exec -- pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/openclaw-subagent-lease.smoke.test.ts
```

Expected before implementation: FAIL with controller 400 mentioning `/workspace`, or FAIL because smoke harness lacks the tool invocation helper. Either failure is valid red proof.

- [ ] **Step 4: Add missing smoke harness helper if needed**

If `gatewayClient.invokeTool` cannot invoke `sessions_spawn`, add to `packages/agent-vm/src/integration-tests/smoke-harness.ts`:

```ts
export async function invokeOpenClawGatewayTool(options: {
	readonly gatewayUrl: string;
	readonly token: string;
	readonly agentId: string;
	readonly tool: string;
	readonly args: Record<string, unknown>;
}): Promise<unknown> {
	const client = createGatewayApiClient({
		gatewayUrl: options.gatewayUrl,
		token: options.token,
	});
	return await client.invokeTool({
		agentId: options.agentId,
		tool: options.tool,
		args: options.args,
	});
}
```

Use that helper in the smoke test.

- [ ] **Step 5: Run E2E smoke and verify it passes**

Run:

```bash
AGENT_VM_OPENCLAW_SMOKE=1 mise exec -- pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/openclaw-subagent-lease.smoke.test.ts
```

Expected: PASS. This is the required acceptance proof. If the local machine cannot run Gondolin smoke, record that as blocked and perform the manual beta E2E in Task 7 before claiming the feature works.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md packages/agent-vm/src/integration-tests/openclaw-subagent-lease.smoke.test.ts packages/agent-vm/src/integration-tests/smoke-harness.ts
git commit -m "test: smoke openclaw subagent lease path translation"
```

---

## Task 7: Manual Beta E2E Proof

**Files:**
- Create: `docs/wip/debugging/2026-05-26-openclaw-subagent-lease-e2e.md`

- [ ] **Step 1: Create manual E2E log document**

Create `docs/wip/debugging/2026-05-26-openclaw-subagent-lease-e2e.md`:

```md
# 2026-05-26 OpenClaw Subagent Lease E2E

## Goal

Prove beta-equivalent OpenClaw parent -> subagent -> plugin -> controller lease -> Tool VM command succeeds without controller receiving `/workspace` as `workMountDir`.

## Commands

```bash
curl -sS http://127.0.0.1:18900/health
curl -sS http://127.0.0.1:18900/zones/beta/status
node --input-type=module - <<'NODE'
import { readFile } from 'node:fs/promises';
import { buildOpenClawRuntimeStatusReport } from '@agent-vm/openclaw-agent-vm-plugin';

const controllerUrl = 'http://127.0.0.1:18900';
const zoneId = 'beta';
const configPath = 'config/openclaw.json';
const config = JSON.parse(await readFile(configPath, 'utf8'));
const response = await fetch(`${controllerUrl}/zones/${zoneId}/openclaw-runtime-status`, {
	body: JSON.stringify(buildOpenClawRuntimeStatusReport({ config, zoneId })),
	headers: { 'content-type': 'application/json' },
	method: 'POST',
});
console.log(response.status, await response.text());
NODE
curl -sS http://127.0.0.1:18900/leases
```

The runtime-status POST is part of the proof. Without it, a stale
`openclaw-runtime-status-unavailable` response can mask the actual lease-path result.

Trigger through the real OpenClaw user-facing surface:

```text
Ask beta agent to spawn a same-agent subagent that prints SUBAGENT_LEASE_SMOKE_OK.
```

Then collect:

```bash
rg -n "Controller lease API returned HTTP 400|/workspace|SUBAGENT_LEASE_SMOKE_OK|sessions_spawn|subagent" ~/.agent-vm/runtime/zones/beta/logs
curl -sS http://127.0.0.1:18900/leases
```

## Pass Criteria

- Parent run starts.
- Child run starts.
- Child emits `SUBAGENT_LEASE_SMOKE_OK`.
- No fresh controller 400 for `/workspace`.
- `/leases` shows one same-agent lease for beta, not a per-subagent lease split.
```
```

- [ ] **Step 2: Run manual beta E2E**

Use the exact commands in the document. Do not paste tokens. Do not write secrets to files.

Expected: PASS with log evidence.

- [ ] **Step 3: Fill evidence**

Append exact timestamps, sanitized log lines, and command outputs to the document.

- [ ] **Step 4: Commit**

```bash
git add docs/wip/debugging/2026-05-26-openclaw-subagent-lease-e2e.md
git commit -m "docs: record openclaw subagent lease e2e proof"
```

---

## Task 8: Full Verification Gate

**Files:**
- No source edits expected.

- [ ] **Step 1: Run targeted unit and integration tests**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-agent-workspace-source.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.test.ts
pnpm vitest run packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run integration suite**

Run:

```bash
pnpm test:integration
```

Expected: PASS or documented environment-gated skips only.

- [ ] **Step 3: Run smoke suite**

Run:

```bash
mise exec -- pnpm test:smoke
```

Expected: PASS or documented environment-gated skips only.

- [ ] **Step 4: Run required OpenClaw subagent E2E smoke**

Run:

```bash
AGENT_VM_OPENCLAW_SMOKE=1 mise exec -- pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/openclaw-subagent-lease.smoke.test.ts
```

Expected: PASS. This cannot be replaced by unit or integration tests. If local VM tooling cannot run, use Task 7 manual beta E2E and mark local smoke as environment-blocked.

- [ ] **Step 5: Run quality gate**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 6: Commit any verification-only doc updates**

If Task 7 evidence was updated after tests:

```bash
git add docs/wip/debugging/2026-05-26-openclaw-subagent-lease-e2e.md
git commit -m "docs: update subagent lease e2e verification"
```

---

## Requirements Matrix

```text
Requirement                                      Unit  Integ  E2E
──────────────────────────────────────────────   ────  ─────  ───
Pure injected runtime path mapping               yes   no     no
Translate Tool VM guest -> OpenClaw source        yes   yes    yes
Translate OpenClaw source -> Tool VM guest        yes   yes    yes
Translate OpenClaw source -> controller host      yes   yes    yes
Controller rejects /workspace and /work           yes   yes    yes
Plugin handles agentWorkspaceDir=/workspace       yes   yes    yes
Same-agent subagent reuses agent lease            no    yes    yes
Smoke means real E2E or documented manual E2E     no    no     yes
No scopeKey/sandbox/workspaceDir to controller    no    yes    yes
```

## Goal Validation Gate

This plan is not successful unless all of these are true:

```text
Functional acceptance:
  - A same-agent OpenClaw subagent runs to completion.
  - The child can start from inherited /workspace.
  - The child can start from /workspace/subpath.
  - The child can start from /work scratch cwd.
  - Controller never receives /workspace or /work as workMountDir.
  - Controller still rejects direct /workspace and /work lease requests.
  - Same zoneId + agentId reuses one lease.
  - scopeKey, workspaceDir, and cwd do not become lease identity.

Pyramid acceptance:
  - Unit tests cover pure translator and canonical source resolver.
  - Integration tests cover plugin factory request body and controller lease route.
  - Smoke/E2E covers real OpenClaw subagent flow.
  - If automated E2E cannot run locally, manual beta E2E evidence is required
    before claiming the goal is met.

Release acceptance:
  - pnpm check passes.
  - pnpm test:integration passes or has documented environment skips only.
  - mise exec -- pnpm test:smoke passes or has documented environment skips only.
  - AGENT_VM_OPENCLAW_SMOKE=1 subagent lease smoke passes, or manual beta E2E
    proof is attached with logs and exact commands.
```

## Self-Review

Spec coverage:

- Bidirectional translator: Task 1, Task 4, Task 5.
- VM land to Gondolin/OpenClaw land: Task 4.
- Gondolin/OpenClaw land to host/controller land: Task 5.
- Pure mapper with injected runtime info: Task 1, Task 2, Task 4, Task 5.
- Unit/integration/E2E pyramid: Tasks 1 through 8 and Requirements Matrix.
- Real smoke is E2E: Task 6, Task 7, Task 8, AGENTS.md update.
- Beta poisoned-root case: Task 2, Task 3, Task 6, Task 7.

Placeholder scan:

- No TBD/TODO placeholders.
- All new functions referenced by later tasks are introduced in earlier tasks.
- E2E smoke includes a fallback only for a concrete helper mismatch; it still requires a real E2E proof.

Type consistency:

- Runtime path namespaces are named consistently:
  `tool-vm-guest`, `openclaw-gateway`, `controller-host`.
- Plugin canonical source is consistently called `sourceDir` or `agentWorkspaceSourceDir`.
- Controller lease source remains `workMountDir`; Tool VM command cwd remains `effectiveGuestCwd`.
