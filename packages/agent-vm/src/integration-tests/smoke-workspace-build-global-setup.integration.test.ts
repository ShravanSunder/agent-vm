import { describe, expect, it } from 'vitest';

import {
	runSmokeWorkspaceBuild,
	shouldBuildWorkspaceForSmoke,
} from './smoke-workspace-build-global-setup.js';

describe('shouldBuildWorkspaceForSmoke', () => {
	it('skips the workspace build for ordinary ungated smoke runs', () => {
		expect(shouldBuildWorkspaceForSmoke({})).toBe(false);
		expect(shouldBuildWorkspaceForSmoke({ AGENT_VM_1PASSWORD_SMOKE: '1' })).toBe(false);
	});

	it('requires one workspace build before live VM smoke runs', () => {
		expect(shouldBuildWorkspaceForSmoke({ AGENT_VM_OPENCLAW_SMOKE: '1' })).toBe(true);
		expect(shouldBuildWorkspaceForSmoke({ AGENT_VM_WORKER_SMOKE: '1' })).toBe(true);
		expect(shouldBuildWorkspaceForSmoke({ AGENT_VM_GONDOLIN_SMOKE: '1' })).toBe(true);
	});
});

describe('runSmokeWorkspaceBuild', () => {
	it('does not run pnpm build when no live VM smoke gate is enabled', () => {
		const commands: string[][] = [];

		const result = runSmokeWorkspaceBuild({
			cwd: '/repo/agent-vm',
			env: {},
			execFileSync: (command, args, options) => {
				commands.push([command, ...args, options.cwd]);
			},
		});

		expect(result).toBe('skipped');
		expect(commands).toEqual([]);
	});

	it('runs pnpm build once for a live VM smoke command', () => {
		const commands: string[][] = [];

		const result = runSmokeWorkspaceBuild({
			cwd: '/repo/agent-vm',
			env: { AGENT_VM_OPENCLAW_SMOKE: '1' },
			execFileSync: (command, args, options) => {
				commands.push([command, ...args, options.cwd]);
			},
		});

		expect(result).toBe('built');
		expect(commands).toEqual([['pnpm', 'build', '/repo/agent-vm']]);
	});
});
