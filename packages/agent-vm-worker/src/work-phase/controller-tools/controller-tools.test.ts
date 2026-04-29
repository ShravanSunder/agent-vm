import { afterEach, describe, expect, test, vi } from 'vitest';

import { createGitPullDefaultTool } from './git-pull-default-tool.js';
import { createGitPushTool } from './git-push-tool.js';

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

describe('controller tools', () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	test('git-push posts current branch to controller', async () => {
		execaMock.mockResolvedValue({ stdout: 'agent/task-1', stderr: '', exitCode: 0 });
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ results: [{ branch: 'agent/task-1', success: true }] }), {
					status: 200,
				}),
		);
		vi.stubGlobal('fetch', fetchMock);

		const tool = createGitPushTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
		});

		const result = await tool.execute({});

		expect(result).toEqual({
			type: 'push',
			success: true,
			artifact: { results: [{ branch: 'agent/task-1', success: true }] },
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'http://controller/zones/zone-1/tasks/task-1/push-branches',
			expect.objectContaining({
				body: JSON.stringify({
					branches: [
						{ repoUrl: 'https://github.com/acme/widgets.git', branchName: 'agent/task-1' },
					],
				}),
			}),
		);
	});

	test('git-push reports controller HTTP errors as tool failures', async () => {
		execaMock.mockResolvedValue({ stdout: 'agent/task-1', stderr: '', exitCode: 0 });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('auth failed', { status: 500 })),
		);
		const tool = createGitPushTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
		});

		await expect(tool.execute({})).resolves.toEqual({
			type: 'push',
			success: false,
			artifact: 'Controller request failed with HTTP 500: auth failed',
		});
	});

	test('git-push refuses default branch', async () => {
		execaMock.mockResolvedValue({ stdout: 'main', stderr: '', exitCode: 0 });
		const tool = createGitPushTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
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
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
		});

		await expect(tool.execute({})).resolves.toEqual({
			type: 'push',
			success: false,
			artifact:
				'Unable to read current git branch: git branch --show-current failed\nfatal: not a git repository',
		});
	});

	test('git-pull-default posts selected repo to controller', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
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
					}),
					{
						status: 200,
					},
				),
		);
		vi.stubGlobal('fetch', fetchMock);
		const tool = createGitPullDefaultTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
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
		expect(fetchMock).toHaveBeenCalledWith(
			'http://controller/zones/zone-1/tasks/task-1/pull-default',
			expect.objectContaining({
				body: JSON.stringify({
					repoUrl: 'https://github.com/acme/widgets.git',
					currentBranch: 'agent/task-1',
					currentHead: 'local-agent-sha',
					worktreeDirty: false,
				}),
			}),
		);
	});

	test('git-pull-default reports branch command termination before controller request', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: '', stderr: 'killed', exitCode: undefined };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const tool = createGitPullDefaultTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact:
				'Unable to read current git branch: git branch --show-current terminated without an exit code\nkilled',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test('git-pull-default resets the worktree after a controller fast-forward', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
			if (args[0] === 'reset') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							kind: 'advanced',
							success: true,
							message:
								"Default branch 'main' is now at remote-main-sha. Current branch 'agent/task-1' fast-forwarded from local-agent-sha to remote-agent-sha; the worker reset the worktree to materialize the new HEAD.",
							defaultBranch: 'main',
							currentBranchSync: {
								status: 'fast-forwarded',
								branch: 'agent/task-1',
								upstreamTrackingRef: 'origin/agent/task-1',
								localHead: 'local-agent-sha',
								remoteHead: 'remote-agent-sha',
							},
						}),
						{ status: 200 },
					),
			),
		);
		const tool = createGitPullDefaultTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
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

	test('git-pull-default resets the worktree after the checked-out default branch advances', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'main', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-main-sha', stderr: '', exitCode: 0 };
			if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
			if (args[0] === 'reset') return { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							kind: 'advanced',
							success: true,
							message:
								"Default branch 'main' is now at remote-main-sha. Current branch 'main' is the default branch; it fast-forwarded from local-main-sha to remote-main-sha, and the worker reset the worktree to materialize the new HEAD.",
							defaultBranch: 'main',
							currentBranchSync: {
								status: 'default-branch',
								branch: 'main',
								upstreamTrackingRef: 'origin/main',
								localHead: 'local-main-sha',
								remoteHead: 'remote-main-sha',
								reason:
									"Current branch 'main' is the default branch and was fast-forwarded from local-main-sha to remote-main-sha.",
							},
						}),
						{ status: 200 },
					),
			),
		);
		const tool = createGitPullDefaultTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
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
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const tool = createGitPullDefaultTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact:
				'Unable to read current git HEAD: git rev-parse HEAD terminated without an exit code\nkilled',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test('git-pull-default reports status command termination before controller request', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			if (args[0] === 'status') return { stdout: '', stderr: 'killed', exitCode: undefined };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const tool = createGitPullDefaultTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact:
				'Unable to read worktree status: git status --porcelain terminated without an exit code\nkilled',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test('git-pull-default reports reset termination after controller fast-forward', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'branch') return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			if (args[0] === 'rev-parse') return { stdout: 'local-agent-sha', stderr: '', exitCode: 0 };
			if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
			if (args[0] === 'reset') return { stdout: '', stderr: 'killed', exitCode: undefined };
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							kind: 'advanced',
							success: true,
							message:
								"Default branch 'main' is now at remote-main-sha. Current branch 'agent/task-1' fast-forwarded from local-agent-sha to remote-agent-sha; the worker reset the worktree to materialize the new HEAD.",
							currentBranchSync: {
								status: 'fast-forwarded',
								branch: 'agent/task-1',
								upstreamTrackingRef: 'origin/agent/task-1',
								localHead: 'local-agent-sha',
								remoteHead: 'remote-agent-sha',
							},
						}),
						{ status: 200 },
					),
			),
		);
		const tool = createGitPullDefaultTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
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
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							kind: 'failed',
							success: false,
							message: 'Fetch failed without leaking tokens.',
							error: 'Fetch failed without leaking tokens.',
						}),
						{ status: 200 },
					),
			),
		);
		const tool = createGitPullDefaultTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact: 'Fetch failed without leaking tokens.',
		});
	});

	test('git-pull-default reports controller HTTP errors as tool failures', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('repo not registered', { status: 400 })),
		);
		const tool = createGitPullDefaultTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact: 'Controller request failed with HTTP 400: repo not registered',
		});
	});

	test('git-pull-default reports controller transport errors as transport failures', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('controller offline');
			}),
		);
		const tool = createGitPullDefaultTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact: 'Controller request failed before HTTP response: controller offline',
		});
	});

	test('git-pull-default reports malformed controller JSON separately', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not-json', { status: 200 })),
		);
		const tool = createGitPullDefaultTool({
			controllerBaseUrl: 'http://controller',
			zoneId: 'zone-1',
			taskId: 'task-1',
			repos,
		});

		await expect(tool.execute({ repoWorkPath: '/work/repos/widgets' })).resolves.toEqual({
			type: 'pull-default',
			success: false,
			artifact: expect.stringContaining('Controller response parse failed:'),
		});
	});
});
