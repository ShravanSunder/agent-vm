import { afterEach, describe, expect, test, vi } from 'vitest';

import { pullDefaultForTask, PullDefaultValidationError } from './git-pull-default-operations.js';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({ execa: execaMock }));

const activeTask = {
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

describe('git-pull-default-operations', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	test('rejects unregistered repo', async () => {
		await expect(
			pullDefaultForTask({
				activeTask,
				repoUrl: 'https://github.com/acme/unknown.git',
				githubToken: 'token',
			}),
		).rejects.toBeInstanceOf(PullDefaultValidationError);
	});

	test('fetches and fast-forwards local default branch', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = args.slice(3);
			const joined = gitArgs.join(' ');
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'local-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse') {
				return { stdout: '', stderr: '', exitCode: 1 };
			}
			if (gitArgs[0] === 'branch') {
				return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'merge-base') {
				return { stdout: 'fork-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-list') {
				return { stdout: joined.includes('HEAD..') ? '2' : '3', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'log') {
				return { stdout: 'sha1\tmain change\tA\t2026-04-21T00:00:00Z', stderr: '', exitCode: 0 };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});

		const result = await pullDefaultForTask({
			activeTask,
			repoUrl: 'https://github.com/acme/widgets.git',
			githubToken: 'token',
		});

		expect(result).toMatchObject({
			repoUrl: 'https://github.com/acme/widgets.git',
			success: true,
			defaultBranch: 'main',
			remoteDefaultHead: 'remote-main-sha',
			localDefaultHead: 'local-main-sha',
			currentBranch: 'agent/task-1',
			divergence: { aheadOfDefault: 3, behindDefault: 2, forkPoint: 'fork-sha' },
		});
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			expect.arrayContaining([
				'-c',
				'core.hooksPath=/dev/null',
				'--git-dir=/tmp/task-1/gitdirs/widgets.git',
				'fetch',
				'--prune',
			]),
			expect.not.objectContaining({ cwd: expect.any(String) }),
		);
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			[
				'-c',
				'core.hooksPath=/dev/null',
				'--git-dir=/tmp/task-1/gitdirs/widgets.git',
				'update-ref',
				'refs/heads/main',
				'refs/remotes/origin/main',
			],
			expect.not.objectContaining({ cwd: expect.any(String) }),
		);
	});

	test('soft-fails when fetch fails', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = args.slice(3);
			if (gitArgs[0] === 'rev-parse') return { stdout: '', stderr: '', exitCode: 1 };
			if (gitArgs[0] === 'fetch') return { stdout: '', stderr: 'network down', exitCode: 1 };
			return { stdout: '', stderr: '', exitCode: 0 };
		});

		await expect(
			pullDefaultForTask({
				activeTask,
				repoUrl: 'https://github.com/acme/widgets.git',
				githubToken: 'token',
			}),
		).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining('Fetch failed'),
		});
	});
});
