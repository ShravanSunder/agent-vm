import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ActiveWorkerTask } from './active-task-registry.js';
import { createHostGitDir, createVmWorkPath } from './active-task-registry.js';
import { pullDefaultForTask, PullDefaultValidationError } from './git-pull-default-operations.js';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({ execa: execaMock }));

const activeTask: ActiveWorkerTask = {
	taskId: 'task-1',
	zoneId: 'shravan',
	taskRoot: '/tmp/task-1',
	eventLogPath: '/tmp/task-1/state/tasks/task-1.jsonl',
	branchPrefix: 'agent/',
	workerIngress: null,
	repos: [
		{
			repoUrl: 'https://github.com/acme/widgets.git',
			baseBranch: 'main',
			hostGitDir: createHostGitDir('/tmp/task-1/gitdirs/widgets.git'),
			vmWorkPath: createVmWorkPath('/work/repos/widgets'),
		},
	],
};

function extractGitArgs(args: readonly string[]): readonly string[] {
	expect(args[0]).toBe('-c');
	expect(args[1]).toBe('core.hooksPath=/dev/null');
	expect(args[2]).toBe('--git-dir=/tmp/task-1/gitdirs/widgets.git');
	return args.slice(3);
}

describe('git-pull-default-operations', () => {
	afterEach(() => {
		vi.useRealTimers();
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
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
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
			recordEvent,
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
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-pull-started',
			repoUrl: 'https://github.com/acme/widgets.git',
		});
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-pull-succeeded',
			repoUrl: 'https://github.com/acme/widgets.git',
			attempts: 1,
			defaultBranch: 'main',
			remoteDefaultHead: 'remote-main-sha',
			localDefaultHead: 'local-main-sha',
		});
	});

	test('fetches and fast-forwards the current branch when clean and behind upstream', async () => {
		const updatedRefs: string[][] = [];
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'local-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: 'remote-agent-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/agent/task-1')) {
				return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'branch') {
				return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'fetch') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'merge-base' && joined.includes('refs/heads/agent/task-1')) {
				return joined.includes('refs/heads/agent/task-1 refs/remotes/origin/agent/task-1')
					? { stdout: '', stderr: '', exitCode: 0 }
					: { stdout: '', stderr: '', exitCode: 1 };
			}
			if (gitArgs[0] === 'merge-base') {
				return { stdout: 'fork-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'update-ref') {
				updatedRefs.push([...gitArgs]);
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-list') {
				return { stdout: joined.includes('HEAD..') ? '2' : '3', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'log') {
				return { stdout: 'sha1\tmain change\tA\t2026-04-21T00:00:00Z', stderr: '', exitCode: 0 };
			}
			return { stdout: '', stderr: '', exitCode: 1 };
		});

		const result = await pullDefaultForTask({
			activeTask,
			repoUrl: 'https://github.com/acme/widgets.git',
			githubToken: 'token',
			currentBranch: 'agent/task-1',
			currentHead: 'local-agent-sha',
			worktreeDirty: false,
		});

		expect(result.currentBranchSync).toEqual({
			branch: 'agent/task-1',
			upstreamTrackingRef: 'origin/agent/task-1',
			status: 'fast-forwarded',
			localHead: 'local-agent-sha',
			remoteHead: 'remote-agent-sha',
		});
		expect(updatedRefs).toContainEqual([
			'update-ref',
			'refs/heads/agent/task-1',
			'refs/remotes/origin/agent/task-1',
		]);
	});

	test('reports current branch divergence without updating the branch ref', async () => {
		const updatedRefs: string[][] = [];
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'local-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: 'remote-agent-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'branch') {
				return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'fetch') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'merge-base' && joined.includes('agent/task-1')) {
				return { stdout: '', stderr: '', exitCode: 1 };
			}
			if (gitArgs[0] === 'merge-base') {
				return { stdout: 'fork-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'update-ref') {
				updatedRefs.push([...gitArgs]);
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-list') {
				return { stdout: '1', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'log') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			return { stdout: '', stderr: '', exitCode: 1 };
		});

		const result = await pullDefaultForTask({
			activeTask,
			repoUrl: 'https://github.com/acme/widgets.git',
			githubToken: 'token',
			currentBranch: 'agent/task-1',
			currentHead: 'local-agent-sha',
			worktreeDirty: false,
		});

		expect(result.currentBranchSync).toMatchObject({
			branch: 'agent/task-1',
			upstreamTrackingRef: 'origin/agent/task-1',
			status: 'diverged',
			reason: expect.stringContaining('did not merge or rebase'),
		});
		expect(updatedRefs).not.toContainEqual([
			'update-ref',
			'refs/heads/agent/task-1',
			'refs/remotes/origin/agent/task-1',
		]);
	});

	test('reports dirty worktree instead of fast-forwarding current branch', async () => {
		const updatedRefs: string[][] = [];
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'local-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: 'remote-agent-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'merge-base' && joined.includes('refs/heads/agent/task-1')) {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'merge-base') return { stdout: 'fork-sha', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'update-ref') {
				updatedRefs.push([...gitArgs]);
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-list') return { stdout: '1', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'log') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 1 };
		});

		const result = await pullDefaultForTask({
			activeTask,
			repoUrl: 'https://github.com/acme/widgets.git',
			githubToken: 'token',
			currentBranch: 'agent/task-1',
			currentHead: 'local-agent-sha',
			worktreeDirty: true,
		});

		expect(result.currentBranchSync).toMatchObject({
			branch: 'agent/task-1',
			upstreamTrackingRef: 'origin/agent/task-1',
			status: 'dirty-worktree',
			reason: expect.stringContaining('uncommitted changes'),
		});
		expect(updatedRefs).not.toContainEqual([
			'update-ref',
			'refs/heads/agent/task-1',
			'refs/remotes/origin/agent/task-1',
		]);
	});

	test('reports detached HEAD without current branch fetch', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'local-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'branch') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'merge-base') return { stdout: 'fork-sha', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'update-ref') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'rev-list') return { stdout: '1', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'log') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 1 };
		});

		const result = await pullDefaultForTask({
			activeTask,
			repoUrl: 'https://github.com/acme/widgets.git',
			githubToken: 'token',
			currentBranch: null,
			currentHead: 'detached-sha',
			worktreeDirty: false,
		});

		expect(result.currentBranchSync).toEqual({
			branch: null,
			upstreamTrackingRef: null,
			status: 'detached',
			localHead: 'detached-sha',
			reason: 'Detached HEAD at detached-sha; controller did not pull the current branch.',
		});
	});

	test('retries transient default-branch fetch failures', async () => {
		vi.useFakeTimers();
		let fetchAttempts = 0;
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (gitArgs[0] === 'fetch') {
				fetchAttempts += 1;
				if (fetchAttempts < 4) {
					return {
						stdout: '',
						stderr: `RPC failed; HTTP 503 EAI_AGAIN pull failure ${fetchAttempts}`,
						exitCode: 128,
					};
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'local-main-sha', stderr: '', exitCode: 0 };
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

		const resultPromise = pullDefaultForTask({
			activeTask,
			repoUrl: 'https://github.com/acme/widgets.git',
			githubToken: 'token',
			recordEvent,
		});

		await vi.advanceTimersByTimeAsync(22_000);
		const result = await resultPromise;

		expect(fetchAttempts).toBe(4);
		expect(result.success).toBe(true);
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-pull-retry',
			repoUrl: 'https://github.com/acme/widgets.git',
			attempts: 1,
			message: 'RPC failed; HTTP 503 EAI_AGAIN pull failure 1',
			retryDelaySeconds: 2,
		});
	});

	test('soft-fails when fetch fails', async () => {
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'rev-parse') return { stdout: '', stderr: '', exitCode: 1 };
			if (gitArgs[0] === 'fetch') return { stdout: '', stderr: 'network down', exitCode: 1 };
			return { stdout: '', stderr: '', exitCode: 0 };
		});

		await expect(
			pullDefaultForTask({
				activeTask,
				repoUrl: 'https://github.com/acme/widgets.git',
				githubToken: 'token',
				recordEvent,
			}),
		).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining('Fetch failed'),
		});
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-pull-failed',
			repoUrl: 'https://github.com/acme/widgets.git',
			attempts: 1,
			message: expect.stringContaining('network down'),
		});
	});

	test('soft-fails when branch-state git reads fail after fetch', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'log') {
				return { stdout: '', stderr: 'cannot read commit graph', exitCode: 128 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'local-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'branch') {
				return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'merge-base') {
				return { stdout: 'fork-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-list') {
				return { stdout: '1', stderr: '', exitCode: 0 };
			}
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
			error: expect.stringContaining('git log'),
		});
	});
});
