import { describe, expect, it } from 'vitest';

import {
	runE2eWorkspaceBuild,
	shouldBuildWorkspaceForE2e,
} from './e2e-workspace-build-global-setup.js';

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
