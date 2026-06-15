import { describe, expect, it, vi } from 'vitest';

import { resolveControllerTelemetryIdentity } from './controller-telemetry-identity.js';

describe('resolveControllerTelemetryIdentity', () => {
	it('uses git remote, worktree root, and branch with beta override env support', async () => {
		const git = vi.fn(async (args: readonly string[]) => {
			if (args.join(' ') === 'config --get remote.origin.url') {
				return 'https://github.com/ShravanSunder/shravan-claw.git';
			}
			if (args.join(' ') === 'rev-parse --show-toplevel') {
				return '/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta';
			}
			if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
				return 'main';
			}
			throw new Error(`Unexpected git call: ${args.join(' ')}`);
		});

		await expect(
			resolveControllerTelemetryIdentity({
				cwd: '/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta',
				env: {
					AGENT_VM_OBSERVABILITY_RELEASE_CHANNEL: 'beta',
					AGENT_VM_OBSERVABILITY_RUNTIME_FLAVOR: 'beta',
				},
				git,
				serviceVersion: '0.0.99',
			}),
		).resolves.toEqual({
			branchName: 'main',
			releaseChannel: 'beta',
			repositoryIdentity: 'https://github.com/ShravanSunder/shravan-claw.git',
			runtimeFlavor: 'beta',
			serviceVersion: '0.0.99',
			worktreeIdentity: '/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta',
		});
		expect(git).toHaveBeenCalledTimes(3);
	});

	it('falls back to cwd and unknown branch when git metadata is unavailable', async () => {
		await expect(
			resolveControllerTelemetryIdentity({
				cwd: '/tmp/no-git',
				git: vi.fn(async () => undefined),
				serviceVersion: '0.0.99',
			}),
		).resolves.toEqual({
			branchName: 'unknown',
			repositoryIdentity: '/tmp/no-git',
			serviceVersion: '0.0.99',
			worktreeIdentity: '/tmp/no-git',
		});
	});
});
