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

	test('git-pull-default posts selected repo to controller', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ success: true, defaultBranch: 'main' }), {
					status: 200,
				}),
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
			artifact: { success: true, defaultBranch: 'main' },
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'http://controller/zones/zone-1/tasks/task-1/pull-default',
			expect.objectContaining({
				body: JSON.stringify({ repoUrl: 'https://github.com/acme/widgets.git' }),
			}),
		);
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
});
