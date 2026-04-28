import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({
	execaMock: vi.fn(),
}));

vi.mock('execa', () => ({
	execa: execaMock,
}));

describe('bootstrapRepoWorktrees', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'repo-worktree-bootstrap-'));
		execaMock.mockReset();
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('writes gitdir files and checks out a task branch from the base branch', async () => {
		const { bootstrapRepoWorktrees } = await import('./repo-worktree-bootstrap.js');
		const workPath = join(tempDir, 'work', 'repos', 'widgets');
		const gitDirPath = join(tempDir, 'gitdirs', 'widgets.git');

		await bootstrapRepoWorktrees({
			branchPrefix: 'agent/',
			taskId: 'task-123',
			repos: [
				{
					repoUrl: 'https://github.com/acme/widgets.git',
					baseBranch: 'main',
					gitDirPath,
					workPath,
				},
			],
		});

		await expect(readFile(join(workPath, '.git'), 'utf8')).resolves.toBe(`gitdir: ${gitDirPath}\n`);
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			[
				'-c',
				'core.hooksPath=/dev/null',
				`--git-dir=${gitDirPath}`,
				`--work-tree=${workPath}`,
				'checkout',
				'-B',
				'agent/task-123',
				'main',
			],
			expect.objectContaining({
				reject: true,
				timeout: expect.any(Number),
			}),
		);
	});

	it('reports every failed repo checkout', async () => {
		execaMock.mockImplementation(async (_command: string, args: readonly string[]) => {
			const workTreeArg = args.find((arg) => arg.startsWith('--work-tree='));
			throw new Error(`checkout failed for ${workTreeArg ?? 'unknown'}`);
		});
		const { bootstrapRepoWorktrees } = await import('./repo-worktree-bootstrap.js');

		let thrownError: unknown;
		try {
			await bootstrapRepoWorktrees({
				branchPrefix: 'agent/',
				taskId: 'task-123',
				repos: [
					{
						repoUrl: 'https://github.com/acme/frontend.git',
						baseBranch: 'main',
						gitDirPath: join(tempDir, 'gitdirs', 'frontend.git'),
						workPath: join(tempDir, 'work', 'repos', 'frontend'),
					},
					{
						repoUrl: 'https://github.com/acme/backend.git',
						baseBranch: 'main',
						gitDirPath: join(tempDir, 'gitdirs', 'backend.git'),
						workPath: join(tempDir, 'work', 'repos', 'backend'),
					},
				],
			});
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(AggregateError);
		const aggregateError = thrownError as AggregateError;
		expect(aggregateError.errors).toEqual([
			expect.objectContaining({ message: expect.stringContaining('/frontend') }),
			expect.objectContaining({ message: expect.stringContaining('/backend') }),
		]);
	});
});
