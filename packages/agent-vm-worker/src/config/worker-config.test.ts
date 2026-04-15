import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	loadWorkerConfig,
	resolveModelAlias,
	resolvePhaseExecutor,
	workerConfigSchema,
} from './worker-config.js';

describe('worker-config', () => {
	describe('workerConfigSchema', () => {
		it('applies defaults for empty input', () => {
			const config = workerConfigSchema.parse({});

			expect(config.defaults.provider).toBe('codex');
			expect(config.defaults.model).toBe('latest-medium');
			expect(config.phases.plan.maxReviewLoops).toBe(2);
			expect(config.phases.work.maxReviewLoops).toBe(3);
			expect(config.phases.work.maxVerificationRetries).toBe(3);
			expect(config.verification).toHaveLength(2);
			expect(config.wrapupActions).toHaveLength(1);
			expect(config.branchPrefix).toBe('agent/');
			expect(config.stateDir).toBe('/state');
		});

		it('merges partial overrides', () => {
			const config = workerConfigSchema.parse({
				defaults: { provider: 'claude' },
				phases: { plan: { maxReviewLoops: 0 } },
				verification: [{ name: 'typecheck', command: 'tsc --noEmit' }],
			});

			expect(config.defaults.provider).toBe('claude');
			expect(config.defaults.model).toBe('latest-medium');
			expect(config.phases.plan.maxReviewLoops).toBe(0);
			expect(config.verification).toHaveLength(1);
			expect(config.verification[0]?.name).toBe('typecheck');
		});

		it('validates wrapup actions with discriminated union', () => {
			const config = workerConfigSchema.parse({
				wrapupActions: [
					{ type: 'git-pr', required: true },
					{
						type: 'slack-post',
						webhookUrl: 'https://hooks.slack.com/test',
						channel: '#eng',
						required: false,
					},
				],
			});

			expect(config.wrapupActions).toHaveLength(2);
		});

		it('rejects invalid wrapup action type', () => {
			expect(() =>
				workerConfigSchema.parse({
					wrapupActions: [{ type: 'invalid-action' }],
				}),
			).toThrow();
		});
	});

	describe('resolveModelAlias', () => {
		it('resolves codex latest-medium to gpt-5.4 with low effort', () => {
			expect(resolveModelAlias('codex', 'latest-medium')).toEqual({
				model: 'gpt-5.4',
				reasoningEffort: 'low',
			});
		});

		it('resolves claude latest to opus with high effort', () => {
			expect(resolveModelAlias('claude', 'latest')).toEqual({
				model: 'claude-opus-4-6',
				reasoningEffort: 'high',
			});
		});

		it('passes through explicit model IDs with medium effort', () => {
			expect(resolveModelAlias('codex', 'gpt-5.4-turbo')).toEqual({
				model: 'gpt-5.4-turbo',
				reasoningEffort: 'medium',
			});
		});

		it('passes through unknown providers with medium effort', () => {
			expect(resolveModelAlias('unknown-provider', 'latest')).toEqual({
				model: 'latest',
				reasoningEffort: 'medium',
			});
		});
	});

	describe('resolvePhaseExecutor', () => {
		it('uses defaults when phase has no overrides', () => {
			const config = workerConfigSchema.parse({});

			expect(resolvePhaseExecutor(config, {})).toEqual({
				provider: 'codex',
				model: 'gpt-5.4',
				reasoningEffort: 'low',
			});
		});

		it('uses phase overrides when provided', () => {
			const config = workerConfigSchema.parse({});

			expect(
				resolvePhaseExecutor(config, {
					provider: 'claude',
					model: 'latest',
				}),
			).toEqual({
				provider: 'claude',
				model: 'claude-opus-4-6',
				reasoningEffort: 'high',
			});
		});
	});

	describe('loadWorkerConfig', () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), 'worker-config-test-'));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		it('loads and parses config from a file', async () => {
			const configPath = join(tempDir, 'worker.json');
			await writeFile(
				configPath,
				JSON.stringify({
					defaults: { provider: 'claude' },
					branchPrefix: 'bot/',
				}),
				'utf-8',
			);

			const config = await loadWorkerConfig(configPath);
			expect(config.defaults.provider).toBe('claude');
			expect(config.branchPrefix).toBe('bot/');
		});

		it('returns defaults when file does not exist', async () => {
			const config = await loadWorkerConfig(join(tempDir, 'missing.json'));
			expect(config.defaults.provider).toBe('codex');
		});
	});
});
