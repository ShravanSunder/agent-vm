import type { ControlEnvelope } from '@agent-vm/control-protocol-contracts';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { buildSafeGitEnvironment } from './controller-tool-support.js';
import { createGitPullDefaultTool } from './git-pull-default-tool.js';
import { createGitPushTool } from './git-push-tool.js';
import {
	WorkerControlRpcCommandError,
	createWorkerControlControllerToolsClient,
	type WorkerControlControllerToolsClient,
} from './worker-control-rpc-client.js';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({ execa: execaMock }));

const repos = [
	{
		repoUrl: 'https://github.com/acme/widgets.git',
		baseBranch: 'main',
		gitDirPath: '/gitdirs/widgets.git',
		workPath: '/work/repos/widgets',
	},
];

function createMockWorkerControlClient(
	options: {
		readonly gitPullDefault?: WorkerControlControllerToolsClient['gitPullDefault'];
		readonly gitPush?: WorkerControlControllerToolsClient['gitPush'];
	} = {},
): WorkerControlControllerToolsClient {
	return {
		gitPullDefault:
			options.gitPullDefault ??
			vi.fn(async () => ({
				kind: 'advanced' as const,
				success: true as const,
				message: 'Default branch refreshed.',
				defaultBranch: 'main',
				repoUrl: 'https://github.com/acme/widgets.git',
				remoteDefaultHead: 'remote-main-sha',
				localDefaultHead: 'local-main-sha',
				fetchedCommits: [],
				commitsSinceForkPoint: [],
				divergence: { aheadOfDefault: 0, behindDefault: 0, forkPoint: 'fork-sha' },
			})),
		gitPush:
			options.gitPush ??
			vi.fn(async () => ({
				results: [
					{ branch: 'agent/task-1', repoUrl: 'https://github.com/acme/widgets.git', success: true },
				],
			})),
	};
}

function pullDefaultSuccessResult(): Awaited<
	ReturnType<WorkerControlControllerToolsClient['gitPullDefault']>
> {
	return {
		kind: 'advanced',
		success: true,
		message: 'Default branch refreshed.',
		defaultBranch: 'main',
		repoUrl: 'https://github.com/acme/widgets.git',
		remoteDefaultHead: 'remote-main-sha',
		localDefaultHead: 'local-main-sha',
		fetchedCommits: [],
		commitsSinceForkPoint: [],
		divergence: { aheadOfDefault: 0, behindDefault: 0, forkPoint: 'fork-sha' },
	};
}

function createWorkerControlToolsServiceMock(
	onEnvelope: (envelope: ControlEnvelope) => void,
): Parameters<typeof createWorkerControlControllerToolsClient>[0] {
	let nextPeerSequence = 6;
	return {
		emitApplicationMessage: async (envelope: ControlEnvelope): Promise<unknown> => {
			onEnvelope(envelope);
			return {
				kind: 'command_result',
				operation: envelope.operation,
				payload: {
					gitPush: { results: [] },
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		},
		getAcceptedSession: async () => ({
			bootId: 'worker-boot-unit',
			connectionId: 'worker-connection-unit',
			controllerEpoch: 'controller-epoch-unit',
			generationId: 'worker-generation-unit',
			peerId: 'worker-peer-unit',
			sessionId: '0f8602ba-903d-4f21-982d-6b80ea631470',
			zoneId: 'worker-zone-unit',
		}),
		nextPeerSequence: () => nextPeerSequence++,
	};
}

describe('controller tools', () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		delete process.env.GIT_CONFIG_COUNT;
		delete process.env.GIT_CONFIG_KEY_0;
		delete process.env.GIT_CONFIG_VALUE_0;
		delete process.env.GIT_CONFIG_KEY_1;
		delete process.env.GIT_CONFIG_VALUE_1;
	});

	test('buildSafeGitEnvironment appends safe.directory to existing Git config slots', () => {
		process.env.GIT_CONFIG_COUNT = '1';
		process.env.GIT_CONFIG_KEY_0 = 'url.https://example.invalid/.insteadOf';
		process.env.GIT_CONFIG_VALUE_0 = 'git@example.invalid:';

		expect(buildSafeGitEnvironment('/work/repos/widgets')).toMatchObject({
			GIT_CONFIG_COUNT: '2',
			GIT_CONFIG_KEY_0: 'url.https://example.invalid/.insteadOf',
			GIT_CONFIG_VALUE_0: 'git@example.invalid:',
			GIT_CONFIG_KEY_1: 'safe.directory',
			GIT_CONFIG_VALUE_1: '/work/repos/widgets',
		});
	});

	test('worker control controller-tools client uses the session peer sequence allocator', async () => {
		const emittedEnvelopes: ControlEnvelope[] = [];
		const client = createWorkerControlControllerToolsClient(
			createWorkerControlToolsServiceMock((envelope) => emittedEnvelopes.push(envelope)),
		);

		await client.gitPush({
			branchName: 'agent/task-1',
			repoUrl: 'https://github.com/acme/widgets.git',
			taskId: 'task-1',
		});
		await client.gitPush({
			branchName: 'agent/task-2',
			repoUrl: 'https://github.com/acme/widgets.git',
			taskId: 'task-2',
		});

		expect(emittedEnvelopes.map((envelope) => envelope.sequence)).toEqual([6, 7]);
	});

	test('git-push emits current branch over worker control RPC', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const gitPush = vi.fn(async () => ({
			results: [
				{ branch: 'agent/task-1', repoUrl: 'https://github.com/acme/widgets.git', success: true },
			],
		}));
		const workerControlClient = createMockWorkerControlClient({ gitPush });

		const tool = createGitPushTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		const result = await tool.execute({});

		expect(result).toEqual({
			type: 'push',
			success: true,
			artifact: {
				results: [
					{ branch: 'agent/task-1', repoUrl: 'https://github.com/acme/widgets.git', success: true },
				],
			},
		});
		expect(gitPush).toHaveBeenCalledWith({
			branchName: 'agent/task-1',
			expectedHead: 'local-agent-sha',
			repoUrl: 'https://github.com/acme/widgets.git',
			taskId: 'task-1',
		});
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			['branch', '--show-current'],
			expect.objectContaining({
				cwd: '/work/repos/widgets',
				env: expect.objectContaining({
					GIT_CONFIG_COUNT: '1',
					GIT_CONFIG_KEY_0: 'safe.directory',
					GIT_CONFIG_VALUE_0: '/work/repos/widgets',
				}),
			}),
		);
	});

	test('git-push reports worker control errors as tool failures', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const workerControlClient = createMockWorkerControlClient({
			gitPush: vi.fn(async () => {
				throw new WorkerControlRpcCommandError('auth failed', false);
			}),
		});
		const tool = createGitPushTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({})).resolves.toEqual({
			type: 'push',
			success: false,
			artifact: 'auth failed',
		});
	});

	test('git-push refuses default branch', async () => {
		execaMock.mockResolvedValue({ stdout: 'main', stderr: '', exitCode: 0 });
		const tool = createGitPushTool({
			taskId: 'task-1',
			repos,
			workerControlClient: createMockWorkerControlClient(),
		});

		await expect(tool.execute({})).resolves.toMatchObject({
			type: 'push',
			success: false,
			artifact: expect.stringContaining('Refusing to push'),
		});
	});

	test('git-push reports git branch read failures instead of detached HEAD', async () => {
		execaMock.mockResolvedValue({
			stdout: '',
			stderr: 'fatal: not a git repository',
			exitCode: 128,
		});
		const tool = createGitPushTool({
			taskId: 'task-1',
			repos,
			workerControlClient: createMockWorkerControlClient(),
		});

		await expect(tool.execute({})).resolves.toEqual({
			type: 'push',
			success: false,
			artifact:
				'Unable to read current git branch: git branch --show-current failed\nfatal: not a git repository',
		});
	});

	test('git-push reports git HEAD read failures before worker control RPC', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') {
				return { stdout: '', stderr: 'fatal: ambiguous argument HEAD', exitCode: 128 };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const gitPush = vi.fn(async () => ({
			results: [
				{ branch: 'agent/task-1', repoUrl: 'https://github.com/acme/widgets.git', success: true },
			],
		}));
		const workerControlClient = createMockWorkerControlClient({ gitPush });
		const tool = createGitPushTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({})).resolves.toEqual({
			type: 'push',
			success: false,
			artifact:
				'Unable to read current git HEAD: git rev-parse HEAD failed\nfatal: ambiguous argument HEAD',
		});
		expect(gitPush).not.toHaveBeenCalled();
	});

	test('git-pull-default posts selected repo to controller', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const gitPullDefault = vi.fn(async () => ({
			kind: 'advanced' as const,
			success: true as const,
			message:
				"Default branch 'main' is now at remote-main-sha. Current branch 'agent/task-1' was already up to date with origin/agent/task-1.",
			defaultBranch: 'main',
			repoUrl: 'https://github.com/acme/widgets.git',
			remoteDefaultHead: 'remote-main-sha',
			localDefaultHead: 'local-main-sha',
			fetchedCommits: [],
			commitsSinceForkPoint: [],
			divergence: { aheadOfDefault: 0, behindDefault: 0, forkPoint: 'fork-sha' },
			currentBranchSync: {
				status: 'up-to-date' as const,
				branch: 'agent/task-1',
				upstreamTrackingRef: 'origin/agent/task-1',
				localHead: 'local-agent-sha',
				remoteHead: 'local-agent-sha',
			},
		}));
		const workerControlClient = createMockWorkerControlClient({
			gitPullDefault,
		});
		const tool = createGitPullDefaultTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toMatchObject({
			type: 'pull-default',
			success: true,
			artifact: {
				message:
					"Default branch 'main' is now at remote-main-sha. Current branch 'agent/task-1' was already up to date with origin/agent/task-1.",
				result: {
					kind: 'advanced',
					success: true,
					message:
						"Default branch 'main' is now at remote-main-sha. Current branch 'agent/task-1' was already up to date with origin/agent/task-1.",
					defaultBranch: 'main',
					currentBranchSync: {
						status: 'up-to-date',
						branch: 'agent/task-1',
						upstreamTrackingRef: 'origin/agent/task-1',
						localHead: 'local-agent-sha',
						remoteHead: 'local-agent-sha',
					},
				},
			},
		});
		expect(gitPullDefault).toHaveBeenCalledWith({
			repoUrl: 'https://github.com/acme/widgets.git',
			currentBranch: 'agent/task-1',
			currentHead: 'local-agent-sha',
			taskId: 'task-1',
			worktreeDirty: false,
		});
	});

	test('git-pull-default reports branch command termination before controller request', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: '', stderr: 'killed', exitCode: undefined };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const gitPullDefault = vi.fn(async () => pullDefaultSuccessResult());
		const workerControlClient = createMockWorkerControlClient({ gitPullDefault });
		const tool = createGitPullDefaultTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact:
				'Unable to read current git branch: git branch --show-current terminated without an exit code\nkilled',
		});
		expect(gitPullDefault).not.toHaveBeenCalled();
	});

	test('git-pull-default resets the worktree after a controller fast-forward', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
			if (args[0] === 'reset') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const workerControlClient = createMockWorkerControlClient({
			gitPullDefault: vi.fn(async () => ({
				kind: 'advanced' as const,
				success: true as const,
				message:
					"Default branch 'main' is now at remote-main-sha. Current branch 'agent/task-1' fast-forwarded from local-agent-sha to remote-agent-sha; the worker reset the worktree to materialize the new HEAD.",
				defaultBranch: 'main',
				repoUrl: 'https://github.com/acme/widgets.git',
				remoteDefaultHead: 'remote-main-sha',
				localDefaultHead: 'local-main-sha',
				fetchedCommits: [],
				commitsSinceForkPoint: [],
				divergence: { aheadOfDefault: 0, behindDefault: 0, forkPoint: 'fork-sha' },
				currentBranchSync: {
					status: 'fast-forwarded' as const,
					branch: 'agent/task-1',
					upstreamTrackingRef: 'origin/agent/task-1',
					localHead: 'local-agent-sha',
					remoteHead: 'remote-agent-sha',
				},
			})),
		});
		const tool = createGitPullDefaultTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toMatchObject({
			type: 'pull-default',
			success: true,
		});
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			['reset', '--hard', 'HEAD'],
			expect.objectContaining({
				cwd: '/work/repos/widgets',
				env: expect.objectContaining({
					GIT_CONFIG_COUNT: '1',
					GIT_CONFIG_KEY_0: 'safe.directory',
					GIT_CONFIG_VALUE_0: '/work/repos/widgets',
				}),
			}),
		);
	});

	test('git-pull-default resets the worktree after the checked-out default branch advances', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'main', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-main-sha', stderr: '', exitCode: 0 };
			if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
			if (args[0] === 'reset') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const workerControlClient = createMockWorkerControlClient({
			gitPullDefault: vi.fn(async () => ({
				kind: 'advanced' as const,
				success: true as const,
				message:
					"Default branch 'main' is now at remote-main-sha. Current branch 'main' is the default branch; it fast-forwarded from local-main-sha to remote-main-sha, and the worker reset the worktree to materialize the new HEAD.",
				defaultBranch: 'main',
				repoUrl: 'https://github.com/acme/widgets.git',
				remoteDefaultHead: 'remote-main-sha',
				localDefaultHead: 'local-main-sha',
				fetchedCommits: [],
				commitsSinceForkPoint: [],
				divergence: { aheadOfDefault: 0, behindDefault: 0, forkPoint: 'fork-sha' },
				currentBranchSync: {
					status: 'default-branch' as const,
					branch: 'main',
					upstreamTrackingRef: 'origin/main',
					localHead: 'local-main-sha',
					remoteHead: 'remote-main-sha',
					reason:
						"Current branch 'main' is the default branch and was fast-forwarded from local-main-sha to remote-main-sha.",
				},
			})),
		});
		const tool = createGitPullDefaultTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toMatchObject({
			type: 'pull-default',
			success: true,
		});
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			['reset', '--hard', 'HEAD'],
			expect.objectContaining({ cwd: '/work/repos/widgets' }),
		);
	});

	test('git-pull-default reports undefined git exit codes before controller request', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') {
				return { stdout: '', stderr: 'killed', exitCode: undefined };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const gitPullDefault = vi.fn(async () => pullDefaultSuccessResult());
		const workerControlClient = createMockWorkerControlClient({ gitPullDefault });
		const tool = createGitPullDefaultTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact:
				'Unable to read current git HEAD: git rev-parse HEAD terminated without an exit code\nkilled',
		});
		expect(gitPullDefault).not.toHaveBeenCalled();
	});

	test('git-pull-default reports status command termination before controller request', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			if (args[0] === 'status') return { stdout: '', stderr: 'killed', exitCode: undefined };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const gitPullDefault = vi.fn(async () => pullDefaultSuccessResult());
		const workerControlClient = createMockWorkerControlClient({ gitPullDefault });
		const tool = createGitPullDefaultTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact:
				'Unable to read worktree status: git status --porcelain terminated without an exit code\nkilled',
		});
		expect(gitPullDefault).not.toHaveBeenCalled();
	});

	test('git-pull-default reports reset termination after controller fast-forward', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
			if (args[0] === 'reset') return { stdout: '', stderr: 'killed', exitCode: undefined };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const workerControlClient = createMockWorkerControlClient({
			gitPullDefault: vi.fn(async () => ({
				kind: 'advanced' as const,
				success: true as const,
				message:
					"Default branch 'main' is now at remote-main-sha. Current branch 'agent/task-1' fast-forwarded from local-agent-sha to remote-agent-sha; the worker reset the worktree to materialize the new HEAD.",
				defaultBranch: 'main',
				repoUrl: 'https://github.com/acme/widgets.git',
				remoteDefaultHead: 'remote-main-sha',
				localDefaultHead: 'local-main-sha',
				fetchedCommits: [],
				commitsSinceForkPoint: [],
				divergence: { aheadOfDefault: 0, behindDefault: 0, forkPoint: 'fork-sha' },
				currentBranchSync: {
					status: 'fast-forwarded' as const,
					branch: 'agent/task-1',
					upstreamTrackingRef: 'origin/agent/task-1',
					localHead: 'local-agent-sha',
					remoteHead: 'remote-agent-sha',
				},
			})),
		});
		const tool = createGitPullDefaultTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact:
				'Controller fast-forwarded the current branch, but worker reset failed: git reset --hard HEAD terminated without an exit code\nkilled',
		});
	});

	test('git-pull-default reports in-band controller failures as tool failures', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const workerControlClient = createMockWorkerControlClient({
			gitPullDefault: vi.fn(async () => ({
				kind: 'failed' as const,
				success: false as const,
				repoUrl: 'https://github.com/acme/widgets.git',
				message: 'Fetch failed without leaking tokens.',
				error: 'Fetch failed without leaking tokens.',
			})),
		});
		const tool = createGitPullDefaultTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact: 'Fetch failed without leaking tokens.',
		});
	});

	test('git-pull-default reports worker control command errors as tool failures', async () => {
		const workerControlClient = createMockWorkerControlClient({
			gitPullDefault: vi.fn(async () => {
				throw new WorkerControlRpcCommandError('repo not registered', false);
			}),
		});
		const tool = createGitPullDefaultTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact: 'repo not registered',
		});
	});

	test('git-pull-default reports worker control transport errors as transport failures', async () => {
		const workerControlClient = createMockWorkerControlClient({
			gitPullDefault: vi.fn(async () => {
				throw new Error('controller offline');
			}),
		});
		const tool = createGitPullDefaultTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact: 'Worker control git_pull_default failed: controller offline',
		});
	});

	test('git-pull-default reports malformed worker control result separately', async () => {
		const workerControlClient = createMockWorkerControlClient({
			gitPullDefault: vi.fn(async () => ({ nope: true }) as never),
		});
		const tool = createGitPullDefaultTool({
			taskId: 'task-1',
			repos,
			workerControlClient,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact: 'Controller returned an unexpected pull-default response.',
		});
	});
});
