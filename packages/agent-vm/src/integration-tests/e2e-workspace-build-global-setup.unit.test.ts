import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	configureE2eCacheRootForGlobalSetup,
	resolveE2eGlobalCacheRoot,
	runE2eWorkspaceBuild,
	shouldBuildWorkspaceForE2e,
	shouldOwnE2eWorkspaceGlobalSetup,
} from './e2e-workspace-build-global-setup.js';

function createWorkspaceSetupOwnershipProject(isRootProject: boolean): {
	isRootProject(): boolean;
	provide(key: 'agentVmE2eCacheRoot', value: string): void;
} {
	return {
		isRootProject: (): boolean => isRootProject,
		provide: (): void => undefined,
	};
}

describe('shouldOwnE2eWorkspaceGlobalSetup', () => {
	it('assigns the inherited global setup to the root project only', () => {
		expect(shouldOwnE2eWorkspaceGlobalSetup(createWorkspaceSetupOwnershipProject(true))).toBe(true);
		expect(shouldOwnE2eWorkspaceGlobalSetup(createWorkspaceSetupOwnershipProject(false))).toBe(
			false,
		);
	});
});

describe('shouldBuildWorkspaceForE2e', () => {
	it('skips the workspace build for ordinary ungated e2e inventory runs', () => {
		expect(shouldBuildWorkspaceForE2e({})).toBe(false);
		expect(shouldBuildWorkspaceForE2e({ AGENT_VM_1PASSWORD_E2E: '1' })).toBe(false);
		expect(
			shouldBuildWorkspaceForE2e({
				AGENT_VM_TEST_OPENAI_API_KEY: 'test-model-token',
				AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN: 'test-op-token',
			}),
		).toBe(false);
	});

	it('requires one workspace build before live VM e2e runs', () => {
		expect(shouldBuildWorkspaceForE2e({ AGENT_VM_OPENCLAW_E2E: '1' })).toBe(true);
		expect(shouldBuildWorkspaceForE2e({ AGENT_VM_HERMES_E2E: '1' })).toBe(true);
		expect(shouldBuildWorkspaceForE2e({ AGENT_VM_WORKER_E2E: '1' })).toBe(true);
		expect(shouldBuildWorkspaceForE2e({ AGENT_VM_GONDOLIN_E2E: '1' })).toBe(true);
		expect(shouldBuildWorkspaceForE2e({ AGENT_VM_LLM_E2E: '1' })).toBe(true);
	});

	it('skips the workspace build when the caller already built once', () => {
		expect(
			shouldBuildWorkspaceForE2e({
				AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1',
				AGENT_VM_OPENCLAW_E2E: '1',
			}),
		).toBe(false);
	});
});

describe('configureE2eCacheRootForGlobalSetup', () => {
	it('leaves ordinary inventory runs without a live e2e cache root', () => {
		const env: Record<string, string> = {};
		const provided: [string, string][] = [];

		const cacheRoot = configureE2eCacheRootForGlobalSetup({
			env,
			project: {
				provide: (key, value) => {
					provided.push([key, value]);
				},
			},
			tmpdir: '/tmp',
		});

		expect(cacheRoot).toBeUndefined();
		expect(env.AGENT_VM_E2E_CACHE_DIR).toBeUndefined();
		expect(provided).toEqual([]);
	});

	it('makes the live e2e cache root explicit and available to the Vitest project', () => {
		const env: Record<string, string> = { AGENT_VM_OPENCLAW_E2E: '1' };
		const provided: [string, string][] = [];

		const cacheRoot = configureE2eCacheRootForGlobalSetup({
			env,
			project: {
				provide: (key, value) => {
					provided.push([key, value]);
				},
			},
			tmpdir: '/tmp',
		});

		expect(cacheRoot).toBe('/tmp/agent-vm-e2e-cache');
		expect(env.AGENT_VM_E2E_CACHE_DIR).toBe('/tmp/agent-vm-e2e-cache');
		expect(provided).toEqual([['agentVmE2eCacheRoot', '/tmp/agent-vm-e2e-cache']]);
	});

	it('still configures the live e2e cache root when the workspace build was already done', () => {
		const env: Record<string, string> = {
			AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1',
			AGENT_VM_GONDOLIN_E2E: '1',
		};

		const cacheRoot = configureE2eCacheRootForGlobalSetup({
			env,
			tmpdir: '/tmp',
		});

		expect(cacheRoot).toBe('/tmp/agent-vm-e2e-cache');
		expect(env.AGENT_VM_E2E_CACHE_DIR).toBe('/tmp/agent-vm-e2e-cache');
	});

	it('preserves an operator-provided live e2e cache root', () => {
		expect(
			resolveE2eGlobalCacheRoot({
				AGENT_VM_E2E_CACHE_DIR: '../custom-e2e-cache',
				AGENT_VM_OPENCLAW_E2E: '1',
			}),
		).toBe(path.resolve('../custom-e2e-cache'));
	});
});

describe('runE2eWorkspaceBuild', () => {
	it('does not run pnpm build when no live VM e2e gate is enabled', () => {
		const commands: string[][] = [];

		const result = runE2eWorkspaceBuild({
			cwd: '/repo/agent-vm',
			env: {},
			execFileSync: (command, args, options) => {
				commands.push([command, ...args, options.cwd]);
			},
		});

		expect(result).toBe('skipped');
		expect(commands).toEqual([]);
	});

	it('runs pnpm build once for a live VM e2e command', () => {
		const commands: string[][] = [];

		const result = runE2eWorkspaceBuild({
			cwd: '/repo/agent-vm',
			env: { AGENT_VM_OPENCLAW_E2E: '1' },
			execFileSync: (command, args, options) => {
				commands.push([command, ...args, options.cwd]);
			},
		});

		expect(result).toBe('built');
		expect(commands).toEqual([['pnpm', 'build', '/repo/agent-vm']]);
	});
});
