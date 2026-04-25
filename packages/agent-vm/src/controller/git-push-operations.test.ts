import { afterEach, describe, expect, it, vi } from 'vitest';

import { pushBranchesForTask, PushBranchesValidationError } from './git-push-operations.js';

const { execaMock } = vi.hoisted(() => ({
	execaMock: vi.fn(),
}));

vi.mock('execa', () => ({
	execa: execaMock,
}));

function buildActiveTask(): {
	readonly taskId: string;
	readonly zoneId: string;
	readonly taskRoot: string;
	readonly branchPrefix: string;
	readonly workerIngress: null;
	readonly repos: readonly {
		readonly repoUrl: string;
		readonly baseBranch: string;
		readonly hostWorkspacePath: string;
		readonly vmWorkspacePath: string;
	}[];
} {
	return {
		taskId: 'task-1',
		zoneId: 'shravan',
		taskRoot: '/tmp/task-1',
		branchPrefix: 'agent/',
		workerIngress: null,
		repos: [
			{
				repoUrl: 'https://github.com/acme/widgets.git',
				baseBranch: 'main',
				hostWorkspacePath: '/tmp/task-1/widgets',
				vmWorkspacePath: '/workspace/widgets',
			},
		],
	};
}

function mockGitSuccess(): void {
	execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
		const joined = args.join(' ');
		if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/agent/task-1')) {
			return { stdout: '', stderr: '', exitCode: 1 };
		}
		if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main')) {
			return { stdout: 'base-sha', stderr: '', exitCode: 0 };
		}
		if (args[0] === 'rev-parse' && args.includes('HEAD')) {
			return { stdout: 'local-sha', stderr: '', exitCode: 0 };
		}
		if (args[0] === 'log' && joined.includes('refs/remotes/origin/main..HEAD')) {
			return {
				stdout: 'local-sha\tfeat: change\tAgent\t2026-04-21T00:00:00Z',
				stderr: '',
				exitCode: 0,
			};
		}
		if (args[0] === 'log') {
			return { stdout: 'local-sha\tfeat: change', stderr: '', exitCode: 0 };
		}
		if (args[0] === 'rev-list') {
			return { stdout: joined.includes('HEAD..') ? '0' : '1', stderr: '', exitCode: 0 };
		}
		return { stdout: '', stderr: '', exitCode: 0 };
	});
}

describe('git-push-operations', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('rejects branches outside the configured prefix before push', async () => {
		await expect(
			pushBranchesForTask({
				activeTask: buildActiveTask(),
				branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'main' }],
				githubToken: 'token',
			}),
		).rejects.toBeInstanceOf(PushBranchesValidationError);
		expect(execaMock).not.toHaveBeenCalled();
	});

	it('pushes branch and returns rich branch state without creating a PR', async () => {
		mockGitSuccess();

		const result = await pushBranchesForTask({
			activeTask: buildActiveTask(),
			branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/task-1' }],
			githubToken: 'token',
		});

		expect(result.results[0]).toMatchObject({
			repoUrl: 'https://github.com/acme/widgets.git',
			branch: 'agent/task-1',
			success: true,
			localHead: 'local-sha',
			defaultBranch: 'main',
			remoteDefaultHead: 'base-sha',
			remoteAlreadyHadBranch: false,
			divergence: { aheadOfDefault: 1, behindDefault: 0 },
		});
		expect(result.results[0]?.commitsOnBranch?.[0]?.sha).toBe('local-sha');
		expect(execaMock).not.toHaveBeenCalledWith('gh', expect.anything(), expect.anything());
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			[
				'fetch',
				'--prune',
				'https://x-access-token:token@github.com/acme/widgets.git',
				'agent/task-1:refs/remotes/origin/agent/task-1',
			],
			expect.objectContaining({ cwd: '/tmp/task-1/widgets' }),
		);
	});

	it('soft-fails when local head already matches remote branch', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: 'same-sha', stderr: '', exitCode: 0 };
			}
			if (args[0] === 'rev-parse' && args.includes('HEAD')) {
				return { stdout: 'same-sha', stderr: '', exitCode: 0 };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});

		const result = await pushBranchesForTask({
			activeTask: buildActiveTask(),
			branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/task-1' }],
			githubToken: 'token',
		});

		expect(result.results[0]).toMatchObject({
			branch: 'agent/task-1',
			success: false,
			error: expect.stringContaining('Nothing new to push'),
		});
	});

	it('soft-fails if controller is asked to push the default branch', async () => {
		const result = await pushBranchesForTask({
			activeTask: { ...buildActiveTask(), branchPrefix: '' },
			branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'main' }],
			githubToken: 'token',
		});

		expect(result.results[0]).toMatchObject({
			branch: 'main',
			success: false,
			error: expect.stringContaining('Refusing to push'),
		});
	});
});
