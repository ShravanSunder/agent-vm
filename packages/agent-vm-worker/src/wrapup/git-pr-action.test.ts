import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGitPrToolDefinition } from './git-pr-action.js';
import { findMissingRequiredActions, wrapupActionResultSchema } from './wrapup-types.js';

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
			taskId: 'task-1',
			taskPrompt: 'fix login bug',
			plan: 'The plan',
			repos: [
				{
					repoUrl: 'https://github.com/org/repo.git',
					baseBranch: 'main',
					workspacePath: '/workspace/repo',
				},
			],
		});

		const result = await tool.execute({
			title: 'fix: resolve login bug',
			body: 'Fixes the login issue.',
		});

		expect(result).toEqual({
			key: '',
			type: 'git-pr',
			artifact: 'https://github.com/org/repo/pull/42',
			success: true,
		});
		expect(mocks.stageAndCommit).toHaveBeenCalledWith({
			message: 'fix: resolve login bug',
			coAuthor: 'agent <noreply@agent>',
			cwd: '/workspace/repo',
		});
	});

	it('returns failure when no repos are configured', async () => {
		const tool = createGitPrToolDefinition({
			branchPrefix: 'agent/',
			commitCoAuthor: 'agent <noreply@agent>',
			taskId: 'task-1',
			taskPrompt: 'summarize incidents',
			plan: null,
			repos: [],
		});

		const result = await tool.execute({ title: 'PR', body: 'body' });

		expect(result).toEqual({
			key: '',
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
			taskId: 'task-1',
			taskPrompt: 'fix bug',
			plan: null,
			repos: [
				{
					repoUrl: 'https://github.com/org/repo.git',
					baseBranch: 'main',
					workspacePath: '/workspace/repo',
				},
			],
		});

		const result = wrapupActionResultSchema.parse(
			await tool.execute({
				title: 'PR',
				body: 'body',
			}),
		);

		expect(result.success).toBe(false);
		expect(result.artifact).not.toContain('ghp_secret123');
		expect(result.artifact).toContain('x-access-token:***');
	});

	it('requires an explicit repo target when multiple repos are configured', async () => {
		const tool = createGitPrToolDefinition({
			branchPrefix: 'agent/',
			commitCoAuthor: 'agent <noreply@agent>',
			taskId: 'task-1',
			taskPrompt: 'fix cross-repo bug',
			plan: null,
			repos: [
				{
					repoUrl: 'https://github.com/org/frontend.git',
					baseBranch: 'main',
					workspacePath: '/workspace/frontend',
				},
				{
					repoUrl: 'https://github.com/org/backend.git',
					baseBranch: 'main',
					workspacePath: '/workspace/backend',
				},
			],
		});

		const result = await tool.execute({ title: 'PR', body: 'body' });

		expect(result).toEqual({
			key: '',
			type: 'git-pr',
			success: false,
			artifact:
				'Multiple repos configured - provide repoWorkspacePath or repoUrl to choose which repo to wrap up.',
		});
	});
});

describe('wrapup-types', () => {
	describe('findMissingRequiredActions', () => {
		it('returns empty when all required actions succeeded', () => {
			expect(
				findMissingRequiredActions(
					[
						{ key: 'git-pr:0', type: 'git-pr', required: true },
						{ key: 'slack-post:1', type: 'slack-post', required: false },
					],
					[{ key: 'git-pr:0', type: 'git-pr', success: true }],
				),
			).toHaveLength(0);
		});

		it('returns missing required actions', () => {
			expect(
				findMissingRequiredActions(
					[{ key: 'git-pr:0', type: 'git-pr', required: true }],
					[{ key: 'git-pr:0', type: 'git-pr', success: false }],
				),
			).toEqual(['git-pr']);
		});

		it('returns required actions not executed at all', () => {
			expect(
				findMissingRequiredActions([{ key: 'git-pr:0', type: 'git-pr', required: true }], []),
			).toEqual(['git-pr']);
		});

		it('ignores optional actions', () => {
			expect(
				findMissingRequiredActions(
					[{ key: 'slack-post:0', type: 'slack-post', required: false }],
					[],
				),
			).toHaveLength(0);
		});

		it('distinguishes duplicate required actions with the same type', () => {
			expect(
				findMissingRequiredActions(
					[
						{ key: 'git-pr:0', type: 'git-pr', required: true },
						{ key: 'git-pr:1', type: 'git-pr', required: true },
					],
					[{ key: 'git-pr:0', type: 'git-pr', success: true }],
				),
			).toEqual(['git-pr']);
		});
	});
});
