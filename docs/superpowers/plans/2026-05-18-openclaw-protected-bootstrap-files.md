# OpenClaw Protected Bootstrap Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-on OpenClaw approval gate that requires human approval before native OpenClaw tools modify `AGENTS.md`, `TOOLS.md`, or `USER.md`.

**Architecture:** Implement the policy inside `@agent-vm/openclaw-agent-vm-plugin`, because the Gondolin plugin is already installed into managed OpenClaw gateway images and participates in native OpenClaw plugin registration. The plugin registers a `before_tool_call` hook during full OpenClaw registration, inspects target paths from structured tool params and obvious shell write commands, and returns `requireApproval` with `timeoutBehavior: "deny"` when protected bootstrap files are targeted.

**Tech Stack:** TypeScript, Vitest, OpenClaw native plugin hooks, OXC formatting and linting, pnpm monorepo scripts.

---

## Approval Boundary

This document is the plan. It does not approve implementation by itself. Stop after saving and reviewing this plan until the human approves execution.

## Runtime Compatibility Grounding

- `packages/agent-vm/managed-images.json` currently pins managed OpenClaw to `2026.5.7`.
- `npm view openclaw@2026.5.7 version dist.tarball` confirmed the package exists at `https://registry.npmjs.org/openclaw/-/openclaw-2026.5.7.tgz`.
- The `openclaw@2026.5.7` tarball exposes `api.on(hookName, handler, { priority, timeoutMs })` in `package/dist/plugin-sdk/src/plugins/types.d.ts`.
- The same tarball's `PluginHookBeforeToolCallEvent` has `toolName`, `params`, optional `runId`, and optional `toolCallId`; it does not expose `derivedPaths`.
- The same tarball's `PluginHookBeforeToolCallResult.requireApproval` supports `title`, `description`, `severity`, `timeoutMs`, `timeoutBehavior`, `pluginId`, and `onResolution`; it does not support `allowedDecisions`.
- A newer local checkout under `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw` includes `derivedPaths` for `apply_patch`, but this plan treats `derivedPaths` as forward-compatible optional input and never depends on it for the managed `2026.5.7` runtime.

## File Structure

- Create `packages/openclaw-agent-vm-plugin/src/protected-file-policy.ts`
  - Owns protected basename normalization, tool-call path extraction, shell write heuristics, approval result construction, and hook registration.
- Create `packages/openclaw-agent-vm-plugin/src/protected-file-policy.test.ts`
  - Unit tests for all protected and unprotected tool-call shapes.
- Create `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.test.ts`
  - Unit tests for default and explicit `protectedFiles` config parsing.
- Modify `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`
  - Adds typed `protectedFiles` config to the existing Gondolin plugin config parser.
- Modify `packages/openclaw-agent-vm-plugin/src/openclaw-sandbox-sdk-contract.ts`
  - Adds local structural types for the OpenClaw hook API used by this plugin.
- Modify `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
  - Registers the protected-file hook in full registration mode after config parsing and before background SDK loading.
- Modify `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts`
  - Adds registration tests for `api.on` presence, missing hook support, disabled policy, and tool-discovery mode.
- Modify `packages/openclaw-agent-vm-plugin/openclaw.plugin.json`
  - Extends manifest schema to allow `plugins.entries.gondolin.config.protectedFiles`.
- Modify `packages/agent-vm/src/cli/manual-templates.ts`
  - Documents the deployment-facing policy in generated OpenClaw manual text and agent-facing instructions.
- Modify `packages/agent-vm/src/cli/manual-templates.test.ts`
  - Locks the generated manual wording.

No controller route, VM lease API, worker gateway, or filesystem sandbox change belongs in this slice. This is an OpenClaw plugin policy gate, not a host-level write sandbox.

## Design Decisions

- Protect by basename, case-insensitively, anywhere in a workspace or zone tree.
- Default protected basenames are exactly `AGENTS.md`, `TOOLS.md`, and `USER.md`.
- Do not protect `CLAUDE.md` by default because this deployment path is OpenClaw/Codex-oriented and the user explicitly called out that OpenClaw does not use `CLAUDE.md`.
- Require approval for `write` and `edit` when `params.path` points at a protected basename.
- Require approval for `apply_patch` when the patch text targets a protected basename through `*** Add File:`, `*** Update File:`, `*** Delete File:`, or `*** Move to:` markers.
- Also inspect optional `event.derivedPaths` when newer OpenClaw versions provide it.
- Require approval for obvious shell writes through `exec`, `bash`, `shell`, or `process` command strings when they contain direct redirection, `tee`, `cp`, `mv`, `rm`, `sed -i`, or `perl -pi` against a protected basename.
- Do not block read-only shell commands such as `cat AGENTS.md`.
- If `protectedFiles.enabled` is true and full OpenClaw registration lacks `api.on`, fail fast with a clear startup error. If the policy is disabled, skip hook registration.
- Approval requests use `severity: "critical"`, `timeoutMs: 60_000`, `timeoutBehavior: "deny"`, and `pluginId: "gondolin"`.

## Task 1: Protected Files Config

**Files:**
- Create: `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`
- Modify: `packages/openclaw-agent-vm-plugin/openclaw.plugin.json`

- [ ] **Step 1: Write failing config tests**

Add `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
	DEFAULT_PROTECTED_FILE_BASENAMES,
	resolveGondolinPluginConfig,
} from './gondolin-plugin-config.js';

const basePluginConfig = {
	controllerUrl: 'http://controller.vm.host:18800',
	zoneId: 'shravan',
};

describe('resolveGondolinPluginConfig protectedFiles', () => {
	it('defaults bootstrap file protection on', () => {
		const config = resolveGondolinPluginConfig(basePluginConfig);

		expect(config.protectedFiles).toEqual({
			basenames: DEFAULT_PROTECTED_FILE_BASENAMES,
			enabled: true,
			protectShellWrites: true,
		});
	});

	it('accepts explicit protected file policy overrides', () => {
		const config = resolveGondolinPluginConfig({
			...basePluginConfig,
			protectedFiles: {
				basenames: ['AGENTS.md', 'policy.md'],
				enabled: false,
				protectShellWrites: false,
			},
		});

		expect(config.protectedFiles).toEqual({
			basenames: ['AGENTS.md', 'policy.md'],
			enabled: false,
			protectShellWrites: false,
		});
	});

	it('rejects path-like protected file names so config remains basename-only', () => {
		expect(() =>
			resolveGondolinPluginConfig({
				...basePluginConfig,
				protectedFiles: { basenames: ['docs/AGENTS.md'] },
			}),
		).toThrow('protectedFiles.basenames must contain file basenames without path separators.');
	});

	it('rejects empty protected file basename lists', () => {
		expect(() =>
			resolveGondolinPluginConfig({
				...basePluginConfig,
				protectedFiles: { basenames: [] },
			}),
		).toThrow('protectedFiles.basenames must contain at least one basename.');
	});
});
```

- [ ] **Step 2: Run config test and confirm it fails for missing exports**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.test.ts
```

Expected: FAIL with an import/export error for `DEFAULT_PROTECTED_FILE_BASENAMES` or missing `protectedFiles` on the resolved config.

- [ ] **Step 3: Add typed config parsing**

Modify `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`:

```typescript
import path from 'node:path';

export const DEFAULT_PROTECTED_FILE_BASENAMES = ['AGENTS.md', 'TOOLS.md', 'USER.md'] as const;

export interface ProtectedFilesConfig {
	readonly basenames: readonly string[];
	readonly enabled: boolean;
	readonly protectShellWrites: boolean;
}

export interface ResolvedGondolinPluginConfig {
	readonly controllerUrl: string;
	readonly profileId?: string;
	readonly protectedFiles: ProtectedFilesConfig;
	readonly zoneGitToken?: string;
	readonly zoneGitTokenEnv?: string;
	readonly zoneId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveBoolean(value: unknown, defaultValue: boolean): boolean {
	return typeof value === 'boolean' ? value : defaultValue;
}

function normalizeProtectedBasename(value: unknown): string {
	if (typeof value !== 'string') {
		throw new Error('protectedFiles.basenames entries must be strings.');
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new Error('protectedFiles.basenames entries must be non-empty strings.');
	}
	if (trimmed !== path.basename(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
		throw new Error('protectedFiles.basenames must contain file basenames without path separators.');
	}
	return trimmed;
}

function resolveProtectedFilesConfig(value: unknown): ProtectedFilesConfig {
	const record = isRecord(value) ? value : {};
	const basenamesInput = Array.isArray(record.basenames)
		? record.basenames
		: DEFAULT_PROTECTED_FILE_BASENAMES;
	const basenames = [...new Set(basenamesInput.map((entry) => normalizeProtectedBasename(entry)))];

	if (basenames.length === 0) {
		throw new Error('protectedFiles.basenames must contain at least one basename.');
	}

	return {
		basenames,
		enabled: resolveBoolean(record.enabled, true),
		protectShellWrites: resolveBoolean(record.protectShellWrites, true),
	};
}

export function resolveGondolinPluginConfig(
	config: Record<string, unknown>,
): ResolvedGondolinPluginConfig {
	if (typeof config.controllerUrl !== 'string' || typeof config.zoneId !== 'string') {
		throw new Error('Gondolin plugin config requires controllerUrl and zoneId.');
	}

	return {
		controllerUrl: config.controllerUrl,
		...(typeof config.profileId === 'string' ? { profileId: config.profileId } : {}),
		protectedFiles: resolveProtectedFilesConfig(config.protectedFiles),
		...(typeof config.zoneGitToken === 'string' ? { zoneGitToken: config.zoneGitToken } : {}),
		...(typeof config.zoneGitTokenEnv === 'string'
			? { zoneGitTokenEnv: config.zoneGitTokenEnv }
			: {}),
		zoneId: config.zoneId,
	};
}
```

- [ ] **Step 4: Extend the OpenClaw manifest schema**

Modify `packages/openclaw-agent-vm-plugin/openclaw.plugin.json` under `configSchema.properties`:

```json
"protectedFiles": {
	"type": "object",
	"additionalProperties": false,
	"properties": {
		"enabled": {
			"type": "boolean"
		},
		"basenames": {
			"type": "array",
			"minItems": 1,
			"items": {
				"type": "string",
				"minLength": 1,
				"pattern": "^[^/\\\\]+$"
			}
		},
		"protectShellWrites": {
			"type": "boolean"
		}
	}
}
```

- [ ] **Step 5: Run config test and confirm it passes**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.test.ts
```

Expected: PASS for 4 tests in `gondolin-plugin-config.test.ts`.

## Task 2: Protected File Policy Unit

**Files:**
- Create: `packages/openclaw-agent-vm-plugin/src/protected-file-policy.test.ts`
- Create: `packages/openclaw-agent-vm-plugin/src/protected-file-policy.ts`

- [ ] **Step 1: Write failing policy tests**

Add `packages/openclaw-agent-vm-plugin/src/protected-file-policy.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import type { ProtectedFilesConfig } from './gondolin-plugin-config.js';
import {
	createProtectedFilePolicyHandler,
	protectedFileApprovalForToolCall,
	registerProtectedFilePolicy,
} from './protected-file-policy.js';

const enabledConfig: ProtectedFilesConfig = {
	basenames: ['AGENTS.md', 'TOOLS.md', 'USER.md'],
	enabled: true,
	protectShellWrites: true,
};

function expectApprovalFor(toolName: string, params: Record<string, unknown>): void {
	const result = protectedFileApprovalForToolCall(
		{ toolName, params },
		enabledConfig,
	);

	expect(result?.requireApproval).toMatchObject({
		pluginId: 'gondolin',
		severity: 'critical',
		timeoutBehavior: 'deny',
		timeoutMs: 60_000,
		title: 'Approve protected bootstrap file change',
	});
}

describe('protectedFileApprovalForToolCall', () => {
	it('requires approval for write path params targeting AGENTS.md', () => {
		expectApprovalFor('write', { path: '/zone/agents/default/AGENTS.md', content: 'next' });
	});

	it('requires approval for edit path params targeting nested tools.md case-insensitively', () => {
		expectApprovalFor('edit', { path: '/zone/agents/default/packages/core/tools.md' });
	});

	it('requires approval for apply_patch patch markers targeting USER.md', () => {
		expectApprovalFor('apply_patch', {
			input: [
				'*** Begin Patch',
				'*** Update File: docs/USER.md',
				'-old',
				'+new',
				'*** End Patch',
			].join('\n'),
		});
	});

	it('requires approval for apply_patch move targets', () => {
		expectApprovalFor('apply_patch', {
			input: [
				'*** Begin Patch',
				'*** Update File: docs/current.md',
				'*** Move to: AGENTS.md',
				'*** End Patch',
			].join('\n'),
		});
	});

	it('uses forward-compatible derivedPaths when present', () => {
		const result = protectedFileApprovalForToolCall(
			{
				toolName: 'apply_patch',
				params: {},
				derivedPaths: ['/host/sandbox/USER.md'],
			},
			enabledConfig,
		);

		expect(result?.requireApproval?.description).toContain('USER.md');
	});

	it('requires approval for obvious shell redirection writes', () => {
		expectApprovalFor('exec', { command: 'printf %s next >> /zone/agents/default/TOOLS.md' });
	});

	it('requires approval for obvious shell tee writes', () => {
		expectApprovalFor('bash', { cmd: 'printf %s next | tee AGENTS.md' });
	});

	it('does not require approval for read-only shell commands', () => {
		const result = protectedFileApprovalForToolCall(
			{ toolName: 'exec', params: { command: 'cat AGENTS.md' } },
			enabledConfig,
		);

		expect(result).toBeUndefined();
	});

	it('does not protect CLAUDE.md by default', () => {
		const result = protectedFileApprovalForToolCall(
			{ toolName: 'write', params: { path: 'CLAUDE.md' } },
			enabledConfig,
		);

		expect(result).toBeUndefined();
	});

	it('does nothing when policy is disabled', () => {
		const result = protectedFileApprovalForToolCall(
			{ toolName: 'write', params: { path: 'AGENTS.md' } },
			{ ...enabledConfig, enabled: false },
		);

		expect(result).toBeUndefined();
	});
});

describe('registerProtectedFilePolicy', () => {
	it('registers a before_tool_call hook with high priority', () => {
		const on = vi.fn();

		registerProtectedFilePolicy({ api: { on }, config: enabledConfig });

		expect(on).toHaveBeenCalledWith(
			'before_tool_call',
			expect.any(Function),
			{ priority: 90, timeoutMs: 1_000 },
		);
	});

	it('throws when enabled policy cannot register a hook', () => {
		expect(() =>
			registerProtectedFilePolicy({ api: {}, config: enabledConfig }),
		).toThrow('Gondolin protectedFiles policy requires OpenClaw api.on during full registration.');
	});

	it('skips missing hook support when the policy is disabled', () => {
		expect(() =>
			registerProtectedFilePolicy({
				api: {},
				config: { ...enabledConfig, enabled: false },
			}),
		).not.toThrow();
	});

	it('creates a handler that returns approval for protected writes', () => {
		const handler = createProtectedFilePolicyHandler(enabledConfig);

		const result = handler({ toolName: 'write', params: { path: 'USER.md' } });

		expect(result?.requireApproval?.description).toContain('USER.md');
	});
});
```

- [ ] **Step 2: Run policy test and confirm it fails for missing module**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/openclaw-agent-vm-plugin/src/protected-file-policy.test.ts
```

Expected: FAIL with a module resolution error for `protected-file-policy.js`.

- [ ] **Step 3: Implement policy extraction and approval result**

Create `packages/openclaw-agent-vm-plugin/src/protected-file-policy.ts` with these exported seams and behavior:

```typescript
import path from 'node:path';

import type { ProtectedFilesConfig } from './gondolin-plugin-config.js';
import type {
	OpenClawBeforeToolCallEvent,
	OpenClawBeforeToolCallResult,
	OpenClawHookRegistrationApi,
} from './openclaw-sandbox-sdk-contract.js';

const PROTECTED_FILE_HOOK_PRIORITY = 90;
const PROTECTED_FILE_HOOK_TIMEOUT_MS = 1_000;
const APPROVAL_TIMEOUT_MS = 60_000;
const WRITE_TOOL_NAMES = new Set(['write', 'edit']);
const SHELL_TOOL_NAMES = new Set(['exec', 'bash', 'shell', 'process']);

export function registerProtectedFilePolicy(params: {
	readonly api: OpenClawHookRegistrationApi;
	readonly config: ProtectedFilesConfig;
}): void {
	if (!params.config.enabled) {
		return;
	}
	if (typeof params.api.on !== 'function') {
		throw new Error(
			'Gondolin protectedFiles policy requires OpenClaw api.on during full registration.',
		);
	}
	params.api.on('before_tool_call', createProtectedFilePolicyHandler(params.config), {
		priority: PROTECTED_FILE_HOOK_PRIORITY,
		timeoutMs: PROTECTED_FILE_HOOK_TIMEOUT_MS,
	});
}

export function createProtectedFilePolicyHandler(
	config: ProtectedFilesConfig,
): (event: OpenClawBeforeToolCallEvent) => OpenClawBeforeToolCallResult | undefined {
	return (event) => protectedFileApprovalForToolCall(event, config);
}

export function protectedFileApprovalForToolCall(
	event: OpenClawBeforeToolCallEvent,
	config: ProtectedFilesConfig,
): OpenClawBeforeToolCallResult | undefined {
	if (!config.enabled) {
		return undefined;
	}

	const protectedPaths = collectProtectedPathHints(event, config);
	if (protectedPaths.length === 0) {
		return undefined;
	}

	const displayPaths = [...new Set(protectedPaths)].sort((left, right) =>
		left.localeCompare(right),
	);

	return {
		requireApproval: {
			title: 'Approve protected bootstrap file change',
			description: `OpenClaw tool ${event.toolName} wants to modify protected bootstrap file(s): ${displayPaths.join(', ')}.`,
			severity: 'critical',
			timeoutMs: APPROVAL_TIMEOUT_MS,
			timeoutBehavior: 'deny',
			pluginId: 'gondolin',
		},
	};
}
```

Continue the same file with helpers that use these exact contracts:

```typescript
function collectProtectedPathHints(
	event: OpenClawBeforeToolCallEvent,
	config: ProtectedFilesConfig,
): readonly string[] {
	const candidates = new Set<string>();

	for (const candidate of event.derivedPaths ?? []) {
		candidates.add(candidate);
	}

	if (WRITE_TOOL_NAMES.has(event.toolName)) {
		const pathParam = readStringParam(event.params, 'path');
		if (pathParam) {
			candidates.add(pathParam);
		}
	}

	if (event.toolName === 'apply_patch') {
		for (const patchPath of collectApplyPatchPathHints(event.params)) {
			candidates.add(patchPath);
		}
	}

	if (config.protectShellWrites && SHELL_TOOL_NAMES.has(event.toolName)) {
		const command = readStringParam(event.params, 'command') ?? readStringParam(event.params, 'cmd');
		if (command) {
			for (const shellPath of collectShellWritePathHints(command)) {
				candidates.add(shellPath);
			}
		}
	}

	return [...candidates].filter((candidate) => isProtectedPath(candidate, config.basenames));
}

function readStringParam(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function collectApplyPatchPathHints(params: Record<string, unknown>): readonly string[] {
	const patchText = readStringParam(params, 'input') ?? readStringParam(params, 'patch');
	if (!patchText) {
		return [];
	}

	const paths: string[] = [];
	for (const line of patchText.split(/\r?\n/u)) {
		const fileMatch = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u.exec(line);
		const moveMatch = /^\*\*\* Move to: (.+)$/u.exec(line);
		const rawPath = fileMatch?.[1] ?? moveMatch?.[1];
		if (rawPath) {
			paths.push(rawPath.trim());
		}
	}
	return paths;
}

function collectShellWritePathHints(command: string): readonly string[] {
	const paths: string[] = [];
	const redirectionPattern = /(?:^|[\s;&|])(?:>|>>)\s*(['"]?)([^'"\s;&|]+)\1/gu;
	for (const match of command.matchAll(redirectionPattern)) {
		const pathValue = match[2];
		if (pathValue) {
			paths.push(pathValue);
		}
	}

	const commandWritePattern =
		/(?:^|[\s;&|])(?:tee|cp|mv|rm)\s+(?:-[A-Za-z0-9-]+\s+)*((?:['"]?)[^'"\s;&|]+(?:['"]?))(?:\s+((?:['"]?)[^'"\s;&|]+(?:['"]?)))?/gu;
	for (const match of command.matchAll(commandWritePattern)) {
		for (const group of [match[1], match[2]]) {
			const cleanGroup = stripShellQuotes(group);
			if (cleanGroup) {
				paths.push(cleanGroup);
			}
		}
	}

	const inPlacePattern =
		/(?:^|[\s;&|])(?:sed|perl)\s+(?:-[A-Za-z0-9-]*i[A-Za-z0-9-]*\s+)(?:[^;&|]*?\s+)?(['"]?)([^'"\s;&|]+)\1/gu;
	for (const match of command.matchAll(inPlacePattern)) {
		const pathValue = match[2];
		if (pathValue) {
			paths.push(pathValue);
		}
	}

	return paths;
}

function stripShellQuotes(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	return value.replace(/^['"]|['"]$/gu, '');
}

function isProtectedPath(candidate: string, protectedBasenames: readonly string[]): boolean {
	const basename = path.basename(candidate).toLocaleLowerCase('en-US');
	return protectedBasenames.some(
		(protectedBasename) => protectedBasename.toLocaleLowerCase('en-US') === basename,
	);
}
```

- [ ] **Step 4: Add hook API types needed by the policy**

Modify `packages/openclaw-agent-vm-plugin/src/openclaw-sandbox-sdk-contract.ts`:

```typescript
export interface OpenClawBeforeToolCallEvent {
	readonly derivedPaths?: readonly string[];
	readonly params: Record<string, unknown>;
	readonly runId?: string;
	readonly toolCallId?: string;
	readonly toolName: string;
}

export interface OpenClawBeforeToolCallResult {
	readonly block?: boolean;
	readonly blockReason?: string;
	readonly params?: Record<string, unknown>;
	readonly requireApproval?: {
		readonly description: string;
		readonly onResolution?: (decision: string) => Promise<void> | void;
		readonly pluginId?: string;
		readonly severity?: 'info' | 'warning' | 'critical';
		readonly timeoutBehavior?: 'allow' | 'deny';
		readonly timeoutMs?: number;
		readonly title: string;
	};
}

export interface OpenClawHookRegistrationApi {
	readonly on?: (
		hookName: 'before_tool_call',
		handler: (
			event: OpenClawBeforeToolCallEvent,
			context?: unknown,
		) => OpenClawBeforeToolCallResult | Promise<OpenClawBeforeToolCallResult | undefined> | undefined,
		options?: {
			readonly priority?: number;
			readonly timeoutMs?: number;
		},
	) => void;
}
```

- [ ] **Step 5: Run policy test and confirm it passes**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/openclaw-agent-vm-plugin/src/protected-file-policy.test.ts
```

Expected: PASS for 14 tests in `protected-file-policy.test.ts`.

## Task 3: Plugin Registration

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts`

- [ ] **Step 1: Add failing registration tests**

Extend `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts` inside `describe('createGondolinPlugin', () => { ... })`:

```typescript
it('registers the protected bootstrap file hook during full registration', () => {
	const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	const registerTool = vi.fn();
	const on = vi.fn();

	try {
		defaultPlugin.register({
			pluginConfig: {
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			registerTool,
			on,
			registrationMode: 'full',
		});

		expect(on).toHaveBeenCalledWith(
			'before_tool_call',
			expect.any(Function),
			{ priority: 90, timeoutMs: 1_000 },
		);
	} finally {
		stderrWrite.mockRestore();
	}
});

it('fails full registration when protected files are enabled and OpenClaw does not expose api.on', () => {
	expect(() =>
		defaultPlugin.register({
			pluginConfig: {
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			registerTool: vi.fn(),
			registrationMode: 'full',
		}),
	).toThrow('Gondolin protectedFiles policy requires OpenClaw api.on during full registration.');
});

it('allows full registration without api.on when protected files are disabled', () => {
	const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

	try {
		expect(() =>
			defaultPlugin.register({
				pluginConfig: {
					controllerUrl: 'http://controller.vm.host:18800',
					protectedFiles: { enabled: false },
					zoneId: 'shravan',
				},
				registerTool: vi.fn(),
				registrationMode: 'full',
			}),
		).not.toThrow();
	} finally {
		stderrWrite.mockRestore();
	}
});

it('does not require api.on during OpenClaw tool discovery', () => {
	const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

	try {
		expect(() =>
			defaultPlugin.register({
				pluginConfig: {
					controllerUrl: 'http://controller.vm.host:18800',
					zoneId: 'shravan',
				},
				registerTool: vi.fn(),
				registrationMode: 'tool-discovery',
			}),
		).not.toThrow();
	} finally {
		stderrWrite.mockRestore();
	}
});
```

- [ ] **Step 2: Update existing full-registration happy-path fixtures**

In the existing full-registration tests that expect successful registration, add `on: vi.fn()` to the `defaultPlugin.register({ ... })` API object. At minimum, update:

```typescript
defaultPlugin.register({
	pluginConfig: {
		controllerUrl: 'http://controller.vm.host:18800',
		zoneId: 'shravan',
	},
	registerTool,
	on: vi.fn(),
	registrationMode: 'full',
});
```

and:

```typescript
defaultPlugin.register({
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
		},
	},
	pluginConfig: {
		controllerUrl: 'http://controller.vm.host:18800',
		zoneId: 'shravan',
	},
	registerTool: vi.fn(),
	on: vi.fn(),
	registrationMode: 'full',
});
```

The existing `fails full registration when OpenClaw does not expose registerTool` test should keep omitting `registerTool`; it should continue to fail on the registerTool requirement before hook registration is reached.

- [ ] **Step 3: Run registration test and confirm it fails for missing registration**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts
```

Expected: FAIL because `on` is not called and missing `api.on` does not throw yet.

- [ ] **Step 4: Register the protected-file policy in full mode**

Modify `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts` imports:

```typescript
import { registerProtectedFilePolicy } from './protected-file-policy.js';
import {
	assertSdkShape,
	type OpenClawHookRegistrationApi,
	type OpenClawToolRegistrationApi,
	type SshHelpers,
	type SshSandboxSession,
} from './openclaw-sandbox-sdk-contract.js';
```

Add `on` to the `register(api: { ... })` shape:

```typescript
readonly on?: OpenClawHookRegistrationApi['on'];
```

After `if (api.registrationMode !== 'full') { return; }`, register the hook before runtime-status publishing:

```typescript
registerProtectedFilePolicy({
	api: { on: api.on },
	config: pluginConfig.protectedFiles,
});
```

Keep the existing `zone_git_push` tool registration before the full-mode check so OpenClaw tool discovery remains unchanged.

- [ ] **Step 5: Run registration test and confirm it passes**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts
```

Expected: PASS for the existing plugin registration tests plus the 4 new tests.

## Task 4: Generated Manual Guidance

**Files:**
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`

- [ ] **Step 1: Add failing manual assertions**

Modify `packages/agent-vm/src/cli/manual-templates.test.ts`.

In the `builds an agent-facing AGENTS.md index that points at the manual` test, add:

```typescript
expect(content).toContain('AGENTS.md, TOOLS.md, and USER.md are protected OpenClaw bootstrap files');
```

In the `builds progressive manual files for agents helping end users` test, add assertions near the existing `openclaw-defaults.md` checks:

```typescript
const openClawDefaultsManual = files.find((file) =>
	file.relativePath.endsWith('openclaw-defaults.md'),
)?.content;
expect(openClawDefaultsManual).toContain('before_tool_call');
expect(openClawDefaultsManual).toContain('protectedFiles.enabled=false');
expect(openClawDefaultsManual).toContain('AGENTS.md, TOOLS.md, and USER.md');
```

- [ ] **Step 2: Run manual tests and confirm they fail for missing text**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: FAIL because the generated manual does not mention the protected bootstrap file policy yet.

- [ ] **Step 3: Add concise generated manual text**

Modify `buildAgentVmAgentsTemplate` in `packages/agent-vm/src/cli/manual-templates.ts` by adding this sentence after the primary config block:

```text
AGENTS.md, TOOLS.md, and USER.md are protected OpenClaw bootstrap files; expect an approval prompt before changing them.
```

Modify the `docs/manual/openclaw-defaults.md` body in the same file by adding this paragraph after the line about `@agent-vm/openclaw-agent-vm-plugin`:

```text
	The gondolin OpenClaw plugin registers a before_tool_call safety policy that requires operator approval before native OpenClaw tools modify AGENTS.md, TOOLS.md, or USER.md. The policy is authoritative for structured write, edit, and apply_patch targets and best-effort for obvious shell writes. Set plugins.entries.gondolin.config.protectedFiles.enabled=false only for deployments that intentionally manage these files through automation.
```

- [ ] **Step 4: Run manual tests and confirm they pass**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS for `manual-templates.test.ts`.

## Task 5: Focused Plugin Verification

**Files:**
- Verify changed files only.

- [ ] **Step 1: Run all OpenClaw plugin unit tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/openclaw-agent-vm-plugin/src
```

Expected: PASS for the OpenClaw plugin test files, including `gondolin-plugin-config.test.ts`, `protected-file-policy.test.ts`, `openclaw-plugin-registration.test.ts`, and existing plugin tests.

- [ ] **Step 2: Run plugin typecheck**

Run:

```bash
pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Run plugin build**

Run:

```bash
pnpm --filter @agent-vm/openclaw-agent-vm-plugin build
```

Expected: exit code 0 and `dist/openclaw.plugin.json` includes the new `protectedFiles` schema because the package build copies `openclaw.plugin.json` into `dist/`.

- [ ] **Step 4: Inspect built manifest for schema output**

Run:

```bash
rg -n '"protectedFiles"|"AGENTS.md"|"TOOLS.md"|"USER.md"' packages/openclaw-agent-vm-plugin/dist/openclaw.plugin.json
```

Expected: output includes `"protectedFiles"`. The manifest schema does not need to include default basename literals because defaults live in TypeScript config parsing.

## Task 6: Repo Quality Gate And Commit

**Files:**
- Verify the whole repo.
- Commit only after approval and passing verification.

- [ ] **Step 1: Run the default unit suite**

Run:

```bash
pnpm test:unit
```

Expected: exit code 0.

- [ ] **Step 2: Run the full quality gate**

Run:

```bash
pnpm check
```

Expected: exit code 0. This covers package version sync, Zod version guard, type-aware linting, format check, and monorepo typecheck.

- [ ] **Step 3: Review git diff for accidental scope expansion**

Run:

```bash
git diff -- packages/openclaw-agent-vm-plugin packages/agent-vm/src/cli/manual-templates.ts packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: diff is limited to the files named in this plan.

- [ ] **Step 4: Commit after human approval**

Run:

```bash
git add packages/openclaw-agent-vm-plugin packages/agent-vm/src/cli/manual-templates.ts packages/agent-vm/src/cli/manual-templates.test.ts
git commit -m "feat(openclaw): protect bootstrap file writes

Co-authored-by: Codex <noreply@openai.com>"
```

Expected: commit succeeds and includes the required trailer exactly once. Do not push until the human asks.

## Self-Review

- Spec coverage: The plan protects `AGENTS.md`, `TOOLS.md`, and `USER.md`; leaves `CLAUDE.md` unprotected by default; places the feature in `@agent-vm/openclaw-agent-vm-plugin`; uses OpenClaw `before_tool_call`; adds config, manifest schema, tests, docs, package verification, and repo verification.
- Runtime grounding: The plan targets managed OpenClaw `2026.5.7`, not the newer local OpenClaw checkout. It avoids `allowedDecisions` and does not depend on `derivedPaths`.
- Boundary check: No controller, worker gateway, lease API, or filesystem sandbox changes are included.
- Type consistency: `ProtectedFilesConfig`, `OpenClawBeforeToolCallEvent`, `OpenClawBeforeToolCallResult`, and `OpenClawHookRegistrationApi` are defined before later tasks import them.
- Test-first shape: Each behavior starts with a failing Vitest assertion before implementation.

## Reviewer Brief

Please review whether this plan fits the OpenClaw `2026.5.7` plugin hook contract and whether the boundary belongs in the Gondolin OpenClaw plugin rather than the controller. The highest-risk points are shell-write detection false negatives, fail-fast behavior when `api.on` is missing, and making sure the policy is an approval gate rather than claiming to be a filesystem sandbox. Confirm that `CLAUDE.md` remains out of the default protected set and that the manual wording communicates the best-effort shell limitation clearly.
