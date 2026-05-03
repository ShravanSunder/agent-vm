import { describe, expect, test, vi } from 'vitest';

import { buildWrapupGitContext } from './task-runner.js';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({ execa: execaMock }));

describe('task-runner wrapup git context', () => {
	test('marks the repo worktree safe for every wrapup git command', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const joinedArgs = args.join(' ');
			if (joinedArgs === 'branch --show-current') {
				return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			}
			if (joinedArgs === 'status --short') {
				return { stdout: ' M README.md', stderr: '', exitCode: 0 };
			}
			if (joinedArgs === 'rev-parse --verify --quiet origin/main') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (joinedArgs === 'log --oneline origin/main..HEAD') {
				return { stdout: 'abc123 docs: clarify payroll test', stderr: '', exitCode: 0 };
			}
			if (joinedArgs === 'diff --stat origin/main...HEAD') {
				return { stdout: ' README.md | 1 +', stderr: '', exitCode: 0 };
			}
			throw new Error(`unexpected git command: ${joinedArgs}`);
		});

		await expect(buildWrapupGitContext('/work/repos/widgets', 'main')).resolves.toContain(
			'Current branch: agent/task-1',
		);

		for (const call of execaMock.mock.calls) {
			expect(call[0]).toBe('git');
			expect(call[2]).toEqual(
				expect.objectContaining({
					cwd: '/work/repos/widgets',
					env: expect.objectContaining({
						GIT_CONFIG_COUNT: '1',
						GIT_CONFIG_KEY_0: 'safe.directory',
						GIT_CONFIG_VALUE_0: '/work/repos/widgets',
					}),
				}),
			);
		}
	});
});
