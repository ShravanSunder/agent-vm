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
		readonly hostGitDir: string;
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
				hostGitDir: '/tmp/task-1/gitdirs/widgets.git',
				vmWorkspacePath: '/work/repos/widgets',
			},
		],
	};
}

function buildMultiRepoActiveTask(): ReturnType<typeof buildActiveTask> {
	return {
		...buildActiveTask(),
		repos: [
			{
				repoUrl: 'https://github.com/acme/widgets.git',
				baseBranch: 'main',
				hostGitDir: '/tmp/task-1/gitdirs/widgets.git',
				vmWorkspacePath: '/work/repos/widgets',
			},
			{
				repoUrl: 'https://github.com/acme/api.git',
				baseBranch: 'main',
				hostGitDir: '/tmp/task-1/gitdirs/api.git',
				vmWorkspacePath: '/work/repos/api',
			},
		],
	};
}

function mockGitSuccess(): void {
	execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
		const gitArgs = args.slice(3);
		const joined = gitArgs.join(' ');
		if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
			return { stdout: '', stderr: '', exitCode: 1 };
		}
		if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
			return { stdout: 'base-sha', stderr: '', exitCode: 0 };
		}
		if (gitArgs[0] === 'rev-parse' && gitArgs.includes('HEAD')) {
			return { stdout: 'local-sha', stderr: '', exitCode: 0 };
		}
		if (gitArgs[0] === 'log' && joined.includes('refs/remotes/origin/main..HEAD')) {
			return {
				stdout: 'local-sha\tfeat: change\tAgent\t2026-04-21T00:00:00Z',
				stderr: '',
				exitCode: 0,
			};
		}
		if (gitArgs[0] === 'log') {
			return { stdout: 'local-sha\tfeat: change', stderr: '', exitCode: 0 };
		}
		if (gitArgs[0] === 'rev-list') {
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

	it('rejects duplicate repo push requests before push', async () => {
		await expect(
			pushBranchesForTask({
				activeTask: buildActiveTask(),
				branches: [
					{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/one' },
					{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/two' },
				],
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
				'-c',
				'core.hooksPath=/dev/null',
				'--git-dir=/tmp/task-1/gitdirs/widgets.git',
				'fetch',
				'--prune',
				'https://x-access-token:token@github.com/acme/widgets.git',
				'agent/task-1:refs/remotes/origin/agent/task-1',
			],
			expect.not.objectContaining({ cwd: expect.any(String) }),
		);
	});

	it('soft-fails when local head already matches remote branch', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = args.slice(3);
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: 'same-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('HEAD')) {
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

	it('pushes branches for different repos concurrently', async () => {
		const events: string[] = [];
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = args.slice(3);
			const gitDirArgument = args.find((arg) => arg.startsWith('--git-dir='));
			const repoName = gitDirArgument?.endsWith('/api.git') === true ? 'api' : 'widgets';
			if (gitArgs[0] === 'push') {
				events.push(`push-start:${repoName}`);
				if (repoName === 'widgets') {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				events.push(`push-finish:${repoName}`);
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('HEAD')) {
				return { stdout: `local-${repoName}`, stderr: '', exitCode: 0 };
			}
			if (
				gitArgs[0] === 'rev-parse' &&
				gitArgs.some((arg) => arg.startsWith('refs/remotes/origin/agent/'))
			) {
				return { stdout: '', stderr: '', exitCode: 1 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: `base-${repoName}`, stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'log') {
				return { stdout: `local-${repoName}\tfeat: ${repoName}`, stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-list') {
				return {
					stdout: gitArgs.join(' ').includes('HEAD..') ? '0' : '1',
					stderr: '',
					exitCode: 0,
				};
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});

		const result = await pushBranchesForTask({
			activeTask: buildMultiRepoActiveTask(),
			branches: [
				{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/widgets' },
				{ repoUrl: 'https://github.com/acme/api.git', branchName: 'agent/api' },
			],
			githubToken: 'token',
		});

		expect(result.results).toHaveLength(2);
		expect(result.results.every((branchResult) => branchResult.success)).toBe(true);
		expect(events.indexOf('push-start:api')).toBeLessThan(events.indexOf('push-finish:widgets'));
	});
});
