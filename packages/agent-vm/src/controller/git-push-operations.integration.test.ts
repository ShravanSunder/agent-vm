import { configure, dispose, reset, type LogRecord } from '@logtape/logtape';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActiveWorkerTask } from './active-task-registry.js';
import { createHostGitDir, createVmWorkPath } from './active-task-registry.js';
import { pushBranchesForTask, PushBranchesValidationError } from './git-push-operations.js';

const { execaMock } = vi.hoisted(() => ({
	execaMock: vi.fn(),
}));

vi.mock('execa', () => ({
	execa: execaMock,
}));

function buildActiveTask(): ActiveWorkerTask {
	return {
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
				pushPolicy: {
					kind: 'trusted_config',
					defaultBranch: 'main',
					protectedBranches: [],
					protectedBranchPatterns: [],
				},
				hostGitDir: createHostGitDir('/tmp/task-1/gitdirs/widgets.git'),
				vmWorkPath: createVmWorkPath('/work/repos/widgets'),
			},
		],
	};
}

function buildMultiRepoActiveTask(): ActiveWorkerTask {
	return {
		...buildActiveTask(),
		repos: [
			{
				repoUrl: 'https://github.com/acme/widgets.git',
				baseBranch: 'main',
				pushPolicy: {
					kind: 'trusted_config',
					defaultBranch: 'main',
					protectedBranches: [],
					protectedBranchPatterns: [],
				},
				hostGitDir: createHostGitDir('/tmp/task-1/gitdirs/widgets.git'),
				vmWorkPath: createVmWorkPath('/work/repos/widgets'),
			},
			{
				repoUrl: 'https://github.com/acme/api.git',
				baseBranch: 'main',
				pushPolicy: {
					kind: 'trusted_config',
					defaultBranch: 'main',
					protectedBranches: [],
					protectedBranchPatterns: [],
				},
				hostGitDir: createHostGitDir('/tmp/task-1/gitdirs/api.git'),
				vmWorkPath: createVmWorkPath('/work/repos/api'),
			},
		],
	};
}

function extractGitArgs(args: readonly string[]): readonly string[] {
	expect(args).toContain('--work-tree=/tmp/task-1/gitdirs');
	let index = 0;
	while (args[index] === '-c') {
		index += 2;
	}
	while (index < args.length) {
		const arg = args[index];
		if (arg === '--git-dir' || arg === '--work-tree') {
			index += 2;
			continue;
		}
		if (arg?.startsWith('--git-dir=') || arg?.startsWith('--work-tree=')) {
			index += 1;
			continue;
		}
		break;
	}
	return args.slice(index);
}

function mockGitSuccess(): void {
	execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
		const gitArgs = extractGitArgs(args);
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
		vi.useRealTimers();
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
				'--work-tree=/tmp/task-1/gitdirs',
				'fetch',
				'--prune',
				'https://x-access-token:token@github.com/acme/widgets.git',
				'agent/task-1:refs/remotes/origin/agent/task-1',
			],
			expect.not.objectContaining({ cwd: expect.any(String) }),
		);
	});

	it('refuses stale expectedHead before pushing', async () => {
		mockGitSuccess();

		const result = await pushBranchesForTask({
			activeTask: buildActiveTask(),
			branches: [
				{
					branchName: 'agent/task-1',
					expectedHead: 'stale-sha',
					repoUrl: 'https://github.com/acme/widgets.git',
				},
			],
			githubToken: 'token',
		});

		expect(result.results[0]).toEqual({
			branch: 'agent/task-1',
			error:
				"Refusing to push: local HEAD 'local-sha' does not match expectedHead 'stale-sha'. Refresh task state before retrying.",
			localHead: 'local-sha',
			repoUrl: 'https://github.com/acme/widgets.git',
			success: false,
		});
		expect(
			execaMock.mock.calls.some((call) => {
				const args = call[1];
				return Array.isArray(args) && extractGitArgs(args)[0] === 'push';
			}),
		).toBe(false);
	});

	it('retries git commands that terminate without an exit code', async () => {
		vi.useFakeTimers();
		let defaultFetchAttempts = 0;
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (gitArgs[0] === 'fetch' && gitArgs.includes('main:refs/remotes/origin/main')) {
				defaultFetchAttempts += 1;
				if (defaultFetchAttempts === 1) {
					return { stdout: '', stderr: 'killed', exitCode: undefined };
				}
			}
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

		const resultPromise = pushBranchesForTask({
			activeTask: buildActiveTask(),
			branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/task-1' }],
			githubToken: 'token',
			recordEvent,
		});
		await vi.advanceTimersByTimeAsync(2_000);
		const result = await resultPromise;

		expect(defaultFetchAttempts).toBe(2);
		expect(result.results[0]).toMatchObject({ branch: 'agent/task-1', success: true });
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-push-fetch-retry',
			repoUrl: 'https://github.com/acme/widgets.git',
			branch: 'main',
			attempts: 1,
			message: expect.stringContaining('terminated without an exit code'),
			retryDelaySeconds: 2,
		});
	});

	it('retries transient git push failures before reporting success', async () => {
		vi.useFakeTimers();
		let pushAttempts = 0;
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (gitArgs[0] === 'push') {
				pushAttempts += 1;
				if (pushAttempts < 4) {
					return {
						stdout: '',
						stderr: `RPC failed; HTTP 503 ECONNRESET transient push failure ${pushAttempts}`,
						exitCode: 128,
					};
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return pushAttempts >= 4
					? { stdout: 'local-sha', stderr: '', exitCode: 0 }
					: { stdout: '', stderr: '', exitCode: 1 };
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

		const resultPromise = pushBranchesForTask({
			activeTask: buildActiveTask(),
			branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/task-1' }],
			githubToken: 'token',
			recordEvent,
		});

		await vi.advanceTimersByTimeAsync(22_000);
		const result = await resultPromise;

		expect(pushAttempts).toBe(4);
		expect(result.results[0]).toMatchObject({
			branch: 'agent/task-1',
			success: true,
			remoteBranchHead: 'local-sha',
		});
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-push-succeeded',
			repoUrl: 'https://github.com/acme/widgets.git',
			branch: 'agent/task-1',
			attempts: 4,
			localHead: 'local-sha',
			remoteBranchHead: 'local-sha',
		});
	});

	it('records default branch fetch retries without updating branch push retry state', async () => {
		vi.useFakeTimers();
		let defaultFetchAttempts = 0;
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (gitArgs[0] === 'fetch' && gitArgs.includes('main:refs/remotes/origin/main')) {
				defaultFetchAttempts += 1;
				if (defaultFetchAttempts === 1) {
					return { stdout: '', stderr: 'RPC failed; HTTP 503 fetching main', exitCode: 128 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			}
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

		const resultPromise = pushBranchesForTask({
			activeTask: buildActiveTask(),
			branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/task-1' }],
			githubToken: 'token',
			recordEvent,
		});

		await vi.advanceTimersByTimeAsync(2_000);
		const result = await resultPromise;

		expect(defaultFetchAttempts).toBe(2);
		expect(result.results[0]).toMatchObject({ branch: 'agent/task-1', success: true });
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-push-fetch-retry',
			repoUrl: 'https://github.com/acme/widgets.git',
			branch: 'main',
			attempts: 1,
			message: 'RPC failed; HTTP 503 fetching main',
			retryDelaySeconds: 2,
		});
		expect(recordEvent).not.toHaveBeenCalledWith({
			event: 'controller-git-push-retry',
			repoUrl: 'https://github.com/acme/widgets.git',
			branch: 'main',
			attempts: expect.any(Number),
			message: expect.any(String),
			retryDelaySeconds: expect.any(Number),
		});
	});

	it('tells the agent to retry in five minutes when push retries are exhausted', async () => {
		vi.useFakeTimers();
		let pushAttempts = 0;
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'push') {
				pushAttempts += 1;
				return {
					stdout: '',
					stderr: `RPC failed; HTTP 503 github unavailable ${pushAttempts}`,
					exitCode: 128,
				};
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: '', stderr: '', exitCode: 1 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('HEAD')) {
				return { stdout: 'local-sha', stderr: '', exitCode: 0 };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});

		const resultPromise = pushBranchesForTask({
			activeTask: buildActiveTask(),
			branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/task-1' }],
			githubToken: 'token',
			recordEvent,
		});

		await vi.advanceTimersByTimeAsync(22_000);
		const result = await resultPromise;

		expect(pushAttempts).toBe(4);
		expect(result.results[0]).toMatchObject({
			branch: 'agent/task-1',
			success: false,
			error: expect.stringContaining('Try git-push again in 5 minutes'),
		});
		expect(result.results[0]?.error).toContain('github unavailable 4');
		expect(result.results[0]?.error).not.toContain('otherwise start a new task');
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-push-started',
			repoUrl: 'https://github.com/acme/widgets.git',
			branch: 'agent/task-1',
		});
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-push-retry',
			repoUrl: 'https://github.com/acme/widgets.git',
			branch: 'agent/task-1',
			attempts: 1,
			message: 'RPC failed; HTTP 503 github unavailable 1',
			phase: 'push',
			retryDelaySeconds: 2,
		});
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-push-failed',
			repoUrl: 'https://github.com/acme/widgets.git',
			branch: 'agent/task-1',
			attempts: 4,
			message: expect.stringContaining('Try git-push again in 5 minutes'),
			phase: 'push',
			retryAfterSeconds: 300,
		});
	});

	it('does not retry permanent git push failures', async () => {
		vi.useFakeTimers();
		let pushAttempts = 0;
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'push') {
				pushAttempts += 1;
				return { stdout: '', stderr: 'remote rejected: non-fast-forward', exitCode: 1 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: '', stderr: '', exitCode: 1 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('HEAD')) {
				return { stdout: 'local-sha', stderr: '', exitCode: 0 };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});

		const result = await pushBranchesForTask({
			activeTask: buildActiveTask(),
			branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/task-1' }],
			githubToken: 'token',
			recordEvent,
		});

		expect(pushAttempts).toBe(1);
		expect(result.results[0]).toMatchObject({
			branch: 'agent/task-1',
			success: false,
			error: expect.not.stringContaining('Try git-push again in 5 minutes'),
		});
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-push-failed',
			repoUrl: 'https://github.com/acme/widgets.git',
			branch: 'agent/task-1',
			attempts: 1,
			message: expect.stringContaining('non-fast-forward'),
			phase: 'push',
		});
		expect(recordEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({ event: 'controller-git-push-retry' }),
		);
	});

	it('records post-push fetch retries as fetch retries', async () => {
		vi.useFakeTimers();
		let postPushFetchAttempts = 0;
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (
				gitArgs[0] === 'fetch' &&
				gitArgs.includes('agent/task-1:refs/remotes/origin/agent/task-1')
			) {
				postPushFetchAttempts += 1;
				if (postPushFetchAttempts === 1) {
					return { stdout: '', stderr: 'RPC failed; HTTP 503 post-push fetch', exitCode: 128 };
				}
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return postPushFetchAttempts > 0
					? { stdout: 'local-sha', stderr: '', exitCode: 0 }
					: { stdout: '', stderr: '', exitCode: 1 };
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

		const resultPromise = pushBranchesForTask({
			activeTask: buildActiveTask(),
			branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/task-1' }],
			githubToken: 'token',
			recordEvent,
		});
		await vi.advanceTimersByTimeAsync(2_000);
		const result = await resultPromise;

		expect(postPushFetchAttempts).toBe(2);
		expect(result.results[0]).toMatchObject({ branch: 'agent/task-1', success: true });
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-push-fetch-retry',
			repoUrl: 'https://github.com/acme/widgets.git',
			branch: 'agent/task-1',
			attempts: 1,
			message: 'RPC failed; HTTP 503 post-push fetch',
			retryDelaySeconds: 2,
		});
		expect(recordEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'controller-git-push-retry',
				message: 'RPC failed; HTTP 503 post-push fetch',
			}),
		);
	});

	it('reports failure when post-push verification fetch fails', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (
				gitArgs[0] === 'fetch' &&
				gitArgs.includes('agent/task-1:refs/remotes/origin/agent/task-1')
			) {
				return { stdout: '', stderr: 'verification network failure', exitCode: 128 };
			}
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

		const result = await pushBranchesForTask({
			activeTask: buildActiveTask(),
			branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/task-1' }],
			githubToken: 'token',
		});

		expect(result.results[0]).toMatchObject({
			branch: 'agent/task-1',
			success: false,
			error: expect.stringContaining('verification network failure'),
		});
	});

	it('reports failure when branch-state git reads fail after push', async () => {
		let pushAttempts = 0;
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'push') {
				pushAttempts += 1;
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'log') {
				return { stdout: '', stderr: 'cannot read commit graph', exitCode: 128 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return pushAttempts > 0
					? { stdout: 'local-sha', stderr: '', exitCode: 0 }
					: { stdout: '', stderr: '', exitCode: 1 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'base-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('HEAD')) {
				return { stdout: 'local-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-list') {
				return { stdout: '1', stderr: '', exitCode: 0 };
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
			error: expect.stringContaining('git log'),
		});
	});

	it('does not fail the push when event logging fails', async () => {
		mockGitSuccess();
		const recordEvent = vi.fn(async () => {
			throw new Error('event log unavailable');
		});
		const capturedRecords: LogRecord[] = [];
		await configure({
			loggers: [
				{
					category: ['agent-vm', 'controller', 'git'],
					lowestLevel: 'trace',
					sinks: ['capture'],
				},
			],
			reset: true,
			sinks: {
				capture: (record): void => {
					capturedRecords.push(record);
				},
			},
		});

		try {
			const result = await pushBranchesForTask({
				activeTask: buildActiveTask(),
				branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/task-1' }],
				githubToken: 'token',
				recordEvent,
			});

			expect(result.results[0]).toMatchObject({ branch: 'agent/task-1', success: true });
			expect(recordEvent).toHaveBeenCalled();
			expect(capturedRecords.map((record) => record.properties)).toEqual([
				{
					event: 'controller-operation-failed',
					failureClass: 'failure',
					operation: 'record-controller-git-event',
					outcome: 'controller-git-push-started',
				},
				{
					event: 'controller-operation-failed',
					failureClass: 'failure',
					operation: 'record-controller-git-event',
					outcome: 'controller-git-push-succeeded',
				},
			]);
		} finally {
			await dispose().catch(() => {});
			await reset();
		}
	});

	it('soft-fails when local head already matches remote branch', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
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

	it('soft-fails before git IO when a worker repo has no trusted push policy', async () => {
		const activeTask = buildActiveTask();
		const result = await pushBranchesForTask({
			activeTask: {
				...activeTask,
				repos: activeTask.repos.map((repo) => ({
					...repo,
					pushPolicy: { kind: 'missing' },
				})),
			},
			branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/task-1' }],
			githubToken: 'token',
		});

		expect(result.results[0]).toMatchObject({
			branch: 'agent/task-1',
			success: false,
		});
		expect(result.results[0]?.error).toContain('no trusted controller push policy');
		expect(execaMock).not.toHaveBeenCalled();
	});

	it('soft-fails if controller is asked to push a protected worker repo branch', async () => {
		const activeTask = buildActiveTask();
		const result = await pushBranchesForTask({
			activeTask: {
				...activeTask,
				repos: activeTask.repos.map((repo) => ({
					...repo,
					pushPolicy: {
						kind: 'trusted_config',
						defaultBranch: 'main',
						protectedBranches: ['agent/release'],
						protectedBranchPatterns: [],
					},
				})),
			},
			branches: [{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/release' }],
			githubToken: 'token',
		});

		expect(result.results[0]).toMatchObject({
			branch: 'agent/release',
			success: false,
			error: expect.stringContaining('protected branch "agent/release"'),
		});
		expect(execaMock).not.toHaveBeenCalled();
	});

	it('soft-fails if controller is asked to push a protected worker repo branch pattern', async () => {
		const activeTask = buildActiveTask();
		const result = await pushBranchesForTask({
			activeTask: {
				...activeTask,
				repos: activeTask.repos.map((repo) => ({
					...repo,
					pushPolicy: {
						kind: 'trusted_config',
						defaultBranch: 'main',
						protectedBranches: [],
						protectedBranchPatterns: ['agent/release/*'],
					},
				})),
			},
			branches: [
				{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/release/2026' },
			],
			githubToken: 'token',
		});

		expect(result.results[0]).toMatchObject({
			branch: 'agent/release/2026',
			success: false,
			error: expect.stringContaining('protected branch pattern "agent/release/*"'),
		});
		expect(execaMock).not.toHaveBeenCalled();
	});

	it('pushes branches for different repos concurrently', async () => {
		const events: string[] = [];
		let releaseWidgetsPush: (() => void) | undefined;
		const widgetsPushCanFinish = new Promise<void>((resolve) => {
			releaseWidgetsPush = resolve;
		});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const gitDirArgument = args.find((arg) => arg.startsWith('--git-dir='));
			const repoName = gitDirArgument?.endsWith('/api.git') === true ? 'api' : 'widgets';
			if (gitArgs[0] === 'push') {
				events.push(`push-start:${repoName}`);
				if (repoName === 'widgets') {
					await widgetsPushCanFinish;
				} else {
					releaseWidgetsPush?.();
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
