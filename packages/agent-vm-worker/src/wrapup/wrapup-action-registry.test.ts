import { describe, expect, it, vi } from 'vitest';

import { workerConfigSchema } from '../config/worker-config.js';
import { buildWrapupTools, getWrapupActionConfigs } from './wrapup-action-registry.js';

const mocks = vi.hoisted(() => ({
	createGitPrToolDefinition: vi.fn(),
	createSlackToolDefinition: vi.fn(),
}));

vi.mock('./git-pr-action.js', () => ({
	createGitPrToolDefinition: mocks.createGitPrToolDefinition,
}));

vi.mock('./slack-action.js', () => ({
	createSlackToolDefinition: mocks.createSlackToolDefinition,
}));

describe('wrapup-action-registry', () => {
	it('records successful tool results with configured action keys', async () => {
		mocks.createGitPrToolDefinition.mockReturnValue({
			name: 'git-pr',
			description: 'Create a PR',
			inputSchema: { type: 'object', properties: {} },
			execute: vi.fn(async () => ({
				key: '',
				type: 'git-pr',
				success: true,
				artifact: 'https://example.com/pr/1',
			})),
		});

		const registry = buildWrapupTools({
			config: workerConfigSchema.parse({
				wrapupActions: [{ type: 'git-pr', required: true }],
			}),
			taskId: 'task-1',
			taskPrompt: 'fix bug',
			plan: null,
			repos: [],
		});

		await registry.tools[0]?.execute({});

		expect(registry.getResults()).toEqual([
			{
				key: 'git-pr:0',
				type: 'git-pr',
				success: true,
				artifact: 'https://example.com/pr/1',
			},
		]);
	});

	it('records failed results when a tool throws', async () => {
		mocks.createGitPrToolDefinition.mockReturnValue({
			name: 'git-pr',
			description: 'Create a PR',
			inputSchema: { type: 'object', properties: {} },
			execute: vi.fn(async () => {
				throw new Error('push failed');
			}),
		});

		const registry = buildWrapupTools({
			config: workerConfigSchema.parse({
				wrapupActions: [{ type: 'git-pr', required: true }],
			}),
			taskId: 'task-1',
			taskPrompt: 'fix bug',
			plan: null,
			repos: [],
		});

		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const result = await registry.tools[0]?.execute({});

		expect(result).toEqual({
			key: 'git-pr:0',
			type: 'git-pr',
			success: false,
			artifact: 'push failed',
		});
		expect(registry.getResults()).toEqual([
			{
				key: 'git-pr:0',
				type: 'git-pr',
				success: false,
				artifact: 'push failed',
			},
		]);
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining('Wrapup action git-pr:0 (git-pr) threw: push failed'),
		);
	});

	it('returns stable wrapup action config keys', () => {
		const config = workerConfigSchema.parse({
			wrapupActions: [
				{ type: 'git-pr', required: true },
				{ type: 'git-pr', required: false },
			],
		});

		expect(getWrapupActionConfigs(config)).toEqual([
			{ key: 'git-pr:0', type: 'git-pr', required: true },
			{ key: 'git-pr:1', type: 'git-pr', required: false },
		]);
	});
});
