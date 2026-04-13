import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGitPrToolDefinition } from './git-pr-action.js';
import type { WrapupActionResult } from './wrapup-types.js';
import { findMissingRequiredActions } from './wrapup-types.js';

const mocks = vi.hoisted(() => ({
	configureGit: vi.fn(),
	createBranch: vi.fn(),
	stageAndCommit: vi.fn(),
	pushBranch: vi.fn(),
	createPullRequest: vi.fn(),
}));

vi.mock('../git/git-operations.js', () => ({
	configureGit: mocks.configureGit,
	createBranch: mocks.createBranch,
	stageAndCommit: mocks.stageAndCommit,
	pushBranch: mocks.pushBranch,
	createPullRequest: mocks.createPullRequest,
}));

describe('git-pr-action', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('creates a PR and returns success result', async () => {
		mocks.configureGit.mockResolvedValue(undefined);
		mocks.createBranch.mockResolvedValue(undefined);
		mocks.stageAndCommit.mockResolvedValue(undefined);
		mocks.pushBranch.mockResolvedValue(undefined);
		mocks.createPullRequest.mockResolvedValue('https://github.com/org/repo/pull/42');

		const tool = createGitPrToolDefinition({
			branchPrefix: 'agent/',
			commitCoAuthor: 'agent <noreply@agent>',
			workspaceDir: '/workspace',
			taskId: 'task-1',
			taskPrompt: 'fix login bug',
			plan: 'The plan',
			repo: { repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' },
		});

		const result = await tool.execute({
			title: 'fix: resolve login bug',
			body: 'Fixes the login issue.',
		});

		expect(result).toEqual({
			type: 'git-pr',
			artifact: 'https://github.com/org/repo/pull/42',
			success: true,
		});
		expect(mocks.stageAndCommit).toHaveBeenCalledWith({
			message: 'fix: resolve login bug',
			coAuthor: 'agent <noreply@agent>',
			cwd: '/workspace',
		});
	});

	it('returns failure when repo is null', async () => {
		const tool = createGitPrToolDefinition({
			branchPrefix: 'agent/',
			commitCoAuthor: 'agent <noreply@agent>',
			workspaceDir: '/workspace',
			taskId: 'task-1',
			taskPrompt: 'summarize incidents',
			plan: null,
			repo: null,
		});

		const result = await tool.execute({ title: 'PR', body: 'body' });

		expect(result).toEqual({
			type: 'git-pr',
			success: false,
			artifact: 'No repo configured - cannot create PR.',
		});
	});

	it('sanitizes tokens in error messages', async () => {
		mocks.configureGit.mockResolvedValue(undefined);
		mocks.createBranch.mockResolvedValue(undefined);
		mocks.stageAndCommit.mockResolvedValue(undefined);
		mocks.pushBranch.mockRejectedValue(
			new Error('push failed: https://x-access-token:ghp_secret123@github.com/org/repo'),
		);

		const tool = createGitPrToolDefinition({
			branchPrefix: 'agent/',
			commitCoAuthor: 'agent <noreply@agent>',
			workspaceDir: '/workspace',
			taskId: 'task-1',
			taskPrompt: 'fix bug',
			plan: null,
			repo: { repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' },
		});

		const result = (await tool.execute({
			title: 'PR',
			body: 'body',
		})) as WrapupActionResult;

		expect(result.success).toBe(false);
		expect(result.artifact).not.toContain('ghp_secret123');
		expect(result.artifact).toContain('x-access-token:***');
	});
});

describe('wrapup-types', () => {
	describe('findMissingRequiredActions', () => {
		it('returns empty when all required actions succeeded', () => {
			expect(
				findMissingRequiredActions(
					[
						{ type: 'git-pr', required: true },
						{ type: 'slack-post', required: false },
					],
					[{ type: 'git-pr', success: true }],
				),
			).toHaveLength(0);
		});

		it('returns missing required actions', () => {
			expect(
				findMissingRequiredActions(
					[{ type: 'git-pr', required: true }],
					[{ type: 'git-pr', success: false }],
				),
			).toEqual(['git-pr']);
		});

		it('returns required actions not executed at all', () => {
			expect(findMissingRequiredActions([{ type: 'git-pr', required: true }], [])).toEqual([
				'git-pr',
			]);
		});

		it('ignores optional actions', () => {
			expect(
				findMissingRequiredActions([{ type: 'slack-post', required: false }], []),
			).toHaveLength(0);
		});
	});
});
