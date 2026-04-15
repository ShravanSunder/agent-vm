import { afterEach, describe, expect, it, vi } from 'vitest';

import { pushBranchesForTask, PushBranchesValidationError } from './git-push-operations.js';

const { execaMock } = vi.hoisted(() => ({
	execaMock: vi.fn(),
}));

vi.mock('execa', () => ({
	execa: execaMock,
}));

describe('git-push-operations', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('rejects branches outside the configured prefix before push', async () => {
		await expect(
			pushBranchesForTask({
				activeTask: {
					taskId: 'task-1',
					zoneId: 'shravan',
					taskRoot: '/tmp/task-1',
					branchPrefix: 'agent/',
					repos: [
						{
							repoUrl: 'https://github.com/acme/widgets.git',
							baseBranch: 'main',
							hostWorkspacePath: '/tmp/task-1/repo',
							vmWorkspacePath: '/workspace/repo',
						},
					],
				},
				branches: [
					{
						repoUrl: 'https://github.com/acme/widgets.git',
						branchName: 'main',
						title: 'PR',
						body: 'body',
					},
				],
				githubToken: 'token',
			}),
		).rejects.toBeInstanceOf(PushBranchesValidationError);
		expect(execaMock).not.toHaveBeenCalled();
	});

	it('returns per-repo success and failure results', async () => {
		execaMock
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({
				stdout: 'https://github.com/acme/widgets/pull/42\n',
				stderr: '',
				exitCode: 0,
			})
			.mockResolvedValueOnce({
				stdout: '',
				stderr: 'remote rejected',
				exitCode: 1,
			});

		const result = await pushBranchesForTask({
			activeTask: {
				taskId: 'task-1',
				zoneId: 'shravan',
				taskRoot: '/tmp/task-1',
				branchPrefix: 'agent/',
				repos: [
					{
						repoUrl: 'https://github.com/acme/widgets.git',
						baseBranch: 'main',
						hostWorkspacePath: '/tmp/task-1/widgets',
						vmWorkspacePath: '/workspace/widgets',
					},
					{
						repoUrl: 'https://github.com/acme/api.git',
						baseBranch: 'develop',
						hostWorkspacePath: '/tmp/task-1/api',
						vmWorkspacePath: '/workspace/api',
					},
				],
			},
			branches: [
				{
					repoUrl: 'https://github.com/acme/widgets.git',
					branchName: 'agent/task-1',
					title: 'PR 1',
					body: 'body 1',
				},
				{
					repoUrl: 'https://github.com/acme/api.git',
					branchName: 'agent/task-1-api',
					title: 'PR 2',
					body: 'body 2',
				},
			],
			githubToken: 'token',
		});

		expect(result).toEqual({
			results: [
				{
					repoUrl: 'https://github.com/acme/widgets.git',
					branchName: 'agent/task-1',
					success: true,
					prUrl: 'https://github.com/acme/widgets/pull/42',
				},
				{
					repoUrl: 'https://github.com/acme/api.git',
					branchName: 'agent/task-1-api',
					success: false,
					error: expect.stringContaining('git push failed'),
				},
			],
		});
	});
});
