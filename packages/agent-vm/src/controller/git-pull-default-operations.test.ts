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
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
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
				if (joined.includes('local-agent-sha..refs/remotes/origin/main')) {
					return { stdout: '2', stderr: '', exitCode: 0 };
				}
				if (joined.includes('refs/remotes/origin/main..local-agent-sha')) {
					return { stdout: '3', stderr: '', exitCode: 0 };
				}
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
			localDefaultHead: 'remote-main-sha',
			divergence: { aheadOfDefault: 3, behindDefault: 2, forkPoint: 'fork-sha' },
		});
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			expect.arrayContaining([
				'-c',
				'core.hooksPath=/dev/null',
				'--git-dir=/tmp/task-1/gitdirs/widgets.git',
				'--work-tree=/tmp/task-1/gitdirs',
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
				'--work-tree=/tmp/task-1/gitdirs',
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
			localDefaultHead: 'remote-main-sha',
		});
	});

	test('fails when default branch update-ref read-back does not match expected head', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'stale-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'merge-base') return { stdout: 'fork-sha', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'update-ref') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'log') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 1 };
		});

		await expect(
			pullDefaultForTask({
				activeTask,
				repoUrl: 'https://github.com/acme/widgets.git',
				githubToken: 'token',
			}),
		).resolves.toMatchObject({
			kind: 'failed',
			success: false,
			error: expect.stringContaining('did not move the ref'),
		});
	});

	test('refuses when the local default branch ref is missing after fetch', async () => {
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: '', stderr: '', exitCode: 1 };
			}
			if (gitArgs[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'log') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 1 };
		});

		await expect(
			pullDefaultForTask({
				activeTask,
				repoUrl: 'https://github.com/acme/widgets.git',
				githubToken: 'token',
				recordEvent,
			}),
		).resolves.toMatchObject({
			kind: 'refused-not-fast-forward',
			success: false,
			error: expect.stringContaining("Local default branch ref 'refs/heads/main' is missing"),
		});
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-pull-failed',
			repoUrl: 'https://github.com/acme/widgets.git',
			attempts: 0,
			message: expect.stringContaining("Local default branch ref 'refs/heads/main' is missing"),
		});
	});

	test('refuses and emits a terminal event when local default cannot fast-forward', async () => {
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'local-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'merge-base' && gitArgs.includes('--is-ancestor')) {
				return { stdout: '', stderr: '', exitCode: 1 };
			}
			if (gitArgs[0] === 'log') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 1 };
		});

		const result = await pullDefaultForTask({
			activeTask,
			repoUrl: 'https://github.com/acme/widgets.git',
			githubToken: 'token',
			recordEvent,
		});

		expect(result).toMatchObject({
			kind: 'refused-not-fast-forward',
			success: false,
			error: expect.stringContaining('cannot be fast-forwarded'),
		});
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-pull-failed',
			repoUrl: 'https://github.com/acme/widgets.git',
			attempts: 0,
			message: expect.stringContaining('cannot be fast-forwarded'),
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
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: 'remote-agent-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/agent/task-1')) {
				return { stdout: 'remote-agent-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'branch') {
				return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'remote-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
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

		expect(result.kind).toBe('advanced');
		if (result.kind !== 'advanced') throw new Error('Expected advanced result');
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
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			expect.arrayContaining(['merge-base', 'remote-agent-sha', 'refs/remotes/origin/main']),
			expect.any(Object),
		);
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			expect.arrayContaining(['rev-list', '--count', 'refs/remotes/origin/main..remote-agent-sha']),
			expect.any(Object),
		);
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			expect.arrayContaining(['rev-list', '--count', 'remote-agent-sha..refs/remotes/origin/main']),
			expect.any(Object),
		);
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
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: 'remote-agent-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'branch') {
				return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'remote-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
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

		expect(result.kind).toBe('advanced');
		if (result.kind !== 'advanced') throw new Error('Expected advanced result');
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

	test('reports merge-base failures instead of classifying them as divergence', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: 'remote-agent-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'remote-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'merge-base' && joined.includes('agent/task-1')) {
				return { stdout: '', stderr: 'fatal: corrupt commit graph', exitCode: 128 };
			}
			if (gitArgs[0] === 'merge-base') return { stdout: 'fork-sha', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'update-ref') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'rev-list') return { stdout: '1', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'log') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 1 };
		});

		await expect(
			pullDefaultForTask({
				activeTask,
				repoUrl: 'https://github.com/acme/widgets.git',
				githubToken: 'token',
				currentBranch: 'agent/task-1',
				currentHead: 'local-agent-sha',
				worktreeDirty: false,
			}),
		).resolves.toMatchObject({
			kind: 'failed',
			success: false,
			error: expect.stringContaining('fatal: corrupt commit graph'),
		});
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
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: 'remote-agent-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'remote-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
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

		expect(result.kind).toBe('advanced');
		if (result.kind !== 'advanced') throw new Error('Expected advanced result');
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

	test('reports current branch as up to date when local and remote heads match', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'local-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'merge-base') return { stdout: 'fork-sha', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'update-ref') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'rev-list') {
				return { stdout: joined.includes('HEAD..') ? '2' : '3', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'log') return { stdout: '', stderr: '', exitCode: 0 };
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

		expect(result.kind).toBe('advanced');
		if (result.kind !== 'advanced') throw new Error('Expected advanced result');
		expect(result.currentBranchSync).toEqual({
			branch: 'agent/task-1',
			upstreamTrackingRef: 'origin/agent/task-1',
			status: 'up-to-date',
			localHead: 'local-agent-sha',
			remoteHead: 'local-agent-sha',
		});
	});

	test('reports current branch as ahead when remote is ancestor of local', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/agent/task-1')) {
				return { stdout: 'remote-agent-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'remote-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'merge-base' && joined.includes('refs/heads/agent/task-1')) {
				return joined.includes('refs/remotes/origin/agent/task-1 refs/heads/agent/task-1')
					? { stdout: '', stderr: '', exitCode: 0 }
					: { stdout: '', stderr: '', exitCode: 1 };
			}
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
			currentBranch: 'agent/task-1',
			currentHead: 'local-agent-sha',
			worktreeDirty: false,
		});

		expect(result.kind).toBe('advanced');
		if (result.kind !== 'advanced') throw new Error('Expected advanced result');
		expect(result.currentBranchSync).toMatchObject({
			branch: 'agent/task-1',
			upstreamTrackingRef: 'origin/agent/task-1',
			status: 'ahead',
			reason: expect.stringContaining('is ahead'),
		});
	});

	test('reports current branch with no upstream without treating it as controller failure', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'fetch' && gitArgs.join(' ').includes('refs/heads/agent/task-1')) {
				return { stdout: '', stderr: "fatal: couldn't find remote ref", exitCode: 128 };
			}
			if (gitArgs[0] === 'ls-remote') return { stdout: '', stderr: '', exitCode: 0 };
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
			currentBranch: 'agent/task-1',
			currentHead: 'local-agent-sha',
			worktreeDirty: false,
		});

		expect(result.kind).toBe('advanced');
		if (result.kind !== 'advanced') throw new Error('Expected advanced result');
		expect(result.currentBranchSync).toEqual({
			branch: 'agent/task-1',
			upstreamTrackingRef: null,
			status: 'no-upstream',
			localHead: 'local-agent-sha',
			reason: "Current branch 'agent/task-1' has no upstream tracking ref on origin.",
		});
	});

	test('reports default-branch current branch without a second current branch fetch', async () => {
		const fetches: string[][] = [];
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'remote-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'fetch') {
				fetches.push([...gitArgs]);
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
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
			currentBranch: 'main',
			currentHead: 'local-main-sha',
			worktreeDirty: false,
		});

		expect(result.kind).toBe('advanced');
		if (result.kind !== 'advanced') throw new Error('Expected advanced result');
		expect(result.currentBranchSync).toMatchObject({
			branch: 'main',
			upstreamTrackingRef: 'origin/main',
			status: 'default-branch',
			localHead: 'local-main-sha',
			remoteHead: 'remote-main-sha',
		});
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			expect.arrayContaining(['merge-base', 'remote-main-sha', 'refs/remotes/origin/main']),
			expect.any(Object),
		);
		expect(fetches).toHaveLength(1);
	});

	test('refuses to move checked-out default branch when the worker worktree is dirty', async () => {
		const updatedRefs: string[][] = [];
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'local-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'merge-base') return { stdout: 'fork-sha', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'update-ref') {
				updatedRefs.push([...gitArgs]);
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'log') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 1 };
		});

		const result = await pullDefaultForTask({
			activeTask,
			repoUrl: 'https://github.com/acme/widgets.git',
			githubToken: 'token',
			currentBranch: 'main',
			currentHead: 'local-main-sha',
			worktreeDirty: true,
			recordEvent,
		});

		expect(result).toMatchObject({
			kind: 'refused-not-fast-forward',
			success: false,
			error: expect.stringContaining('uncommitted changes'),
		});
		expect(updatedRefs).toEqual([]);
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-pull-failed',
			repoUrl: 'https://github.com/acme/widgets.git',
			attempts: 0,
			message: expect.stringContaining('uncommitted changes'),
		});
	});

	test('reports detached HEAD without current branch fetch', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'branch') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'remote-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
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

		expect(result.kind).toBe('advanced');
		if (result.kind !== 'advanced') throw new Error('Expected advanced result');
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
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'remote-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
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
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
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

	test('retries fetches that terminate without an exit code', async () => {
		vi.useFakeTimers();
		let fetchAttempts = 0;
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'fetch') {
				fetchAttempts += 1;
				if (fetchAttempts === 1) {
					return {
						stdout: '',
						stderr: 'killed',
						exitCode: undefined,
					};
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'merge-base') return { stdout: 'fork-sha', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'rev-list') return { stdout: '0', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'log') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 0 };
		});

		const resultPromise = pullDefaultForTask({
			activeTask,
			repoUrl: 'https://github.com/acme/widgets.git',
			githubToken: 'token',
			recordEvent,
		});

		await vi.advanceTimersByTimeAsync(2_000);
		const result = await resultPromise;

		expect(fetchAttempts).toBe(2);
		expect(result.success).toBe(true);
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-pull-retry',
			repoUrl: 'https://github.com/acme/widgets.git',
			attempts: 1,
			message: expect.stringContaining('terminated without an exit code'),
			retryDelaySeconds: 2,
		});
	});

	test('does not tell agents to start a new task after retryable pull failures', async () => {
		vi.useFakeTimers();
		let fetchAttempts = 0;
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'remote-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'fetch') {
				fetchAttempts += 1;
				return {
					stdout: '',
					stderr: `RPC failed; HTTP 503 EAI_AGAIN pull failure ${fetchAttempts}`,
					exitCode: 128,
				};
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
		expect(result.kind).toBe('failed');
		if (result.kind !== 'failed') {
			throw new Error(`Expected failed pull-default result, got ${result.kind}`);
		}
		expect(result.error).toContain('Try git-pull-default again in 5 minutes');
		expect(result.error).not.toContain('otherwise start a new task');
		expect(recordEvent).toHaveBeenCalledWith({
			event: 'controller-git-pull-failed',
			repoUrl: 'https://github.com/acme/widgets.git',
			attempts: 4,
			message: expect.not.stringContaining('otherwise start a new task'),
			retryAfterSeconds: 300,
		});
	});

	test('soft-fails when fetch fails', async () => {
		const recordEvent = vi.fn(async () => {});
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'rev-parse') return { stdout: '', stderr: '', exitCode: 1 };
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'remote-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
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

	test('scrubs GitHub tokens from current branch fetch failures', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'fetch' && gitArgs.join(' ').includes('refs/heads/agent/task-1')) {
				return {
					stdout: '',
					stderr: 'fatal: https://x-access-token:secret-token@github.com/acme/widgets.git rejected',
					exitCode: 128,
				};
			}
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'remote-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
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
			githubToken: 'secret-token',
			currentBranch: 'agent/task-1',
			currentHead: 'local-agent-sha',
			worktreeDirty: false,
		});

		expect(result).toMatchObject({ kind: 'failed', success: false });
		if (result.kind !== 'failed') throw new Error('Expected failed result');
		expect(result.error).not.toContain('secret-token');
		expect(result.error).toContain('https://x-access-token:***@github.com/acme/widgets.git');
	});

	test('does not fail the pull when task event recording fails', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const gitArgs = extractGitArgs(args);
			const joined = gitArgs.join(' ');
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/remotes/origin/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'rev-parse' && gitArgs.includes('refs/heads/main')) {
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'ls-remote')
				return { stdout: 'remote-agent-sha	refs/heads/agent/task-1', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'merge-base') return { stdout: 'fork-sha', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'update-ref') return { stdout: '', stderr: '', exitCode: 0 };
			if (gitArgs[0] === 'rev-list') {
				return { stdout: joined.includes('HEAD..') ? '2' : '3', stderr: '', exitCode: 0 };
			}
			if (gitArgs[0] === 'log') {
				return { stdout: 'sha1\tmain change\tA\t2026-04-21T00:00:00Z', stderr: '', exitCode: 0 };
			}
			return { stdout: '', stderr: '', exitCode: 1 };
		});

		await expect(
			pullDefaultForTask({
				activeTask,
				repoUrl: 'https://github.com/acme/widgets.git',
				githubToken: 'token',
				recordEvent: vi.fn(async () => {
					throw new Error('event log unavailable');
				}),
			}),
		).resolves.toMatchObject({ kind: 'advanced', success: true });
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
				return { stdout: 'remote-main-sha', stderr: '', exitCode: 0 };
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
